// Regression tests for the Referee round-3 back-end rulings (money / reports). Each fails on the pre-fix code:
// M5 a settlement on a finished run refreshes its report (background reconcile; decision 1 retired runs.decideUnknown)
// and emits `report.created`; B1 a project-allowance edit never
// resumes a budget_run pause it cannot have caused (null estimate keeps the pause); B2 a budget scope move keeps the
// step estimate of the old pause detail.
import { afterEach, describe, expect, it } from 'vitest';
import { computeCost, errors } from '@relay/contracts';
import type { ReportV1, RunId } from '@relay/contracts';
import type { ModelResult, ProviderRegistry } from '@relay/providers';
import type { AttemptRow } from '@relay/storage';
import { reconcileUnknownAttempts } from './recovery.js';
import { tick } from './runner.js';
import { drive } from './testing/drive.js';
import { createHarness, sleep } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function open(o: HarnessOptions = {}): Promise<Harness> {
  const x = await createHarness(o);
  h = x;
  return x;
}

const UNKNOWN_REVIEW = { name: 'u', steps: [{ match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'unknown_after_dispatch' } }] } as const;

async function cancelledWithUnknown(o: HarnessOptions): Promise<{ x: Harness; runId: RunId; a: AttemptRow }> {
  const x = await open(o);
  const runId = await x.startRun();
  expect(await drive(x, runId, ['paused'])).toBe('paused');
  const a = x.db.repos.attempts.listForRun(runId).find((y) => y.state === 'unknown');
  if (a === undefined) throw new Error('no unknown attempt');
  const stop = await x.engine.handle('relay/v1/runs.cancel', { runId });
  expect(stop.ok && stop.data.status).toBe('cancelled');
  for (let i = 0; i < 5; i += 1) await sleep(0); // the terminal report effect
  return { x, runId, a };
}

async function newestReport(x: Harness, runId: RunId): Promise<{ id: string; report: ReportV1 }> {
  const d = await x.engine.handle('relay/v1/runs.get', { runId });
  if (!d.ok || d.data.reportArtifactId === null) throw new Error('no report');
  const row = x.db.repos.artifacts.get(d.data.reportArtifactId);
  if (row === undefined) throw new Error('no report row');
  const bytes = await x.ctx.artifacts.read(row.relPath, 1_000_000);
  if (!bytes.ok) throw new Error('report unreadable');
  return { id: row.id, report: JSON.parse(new TextDecoder().decode(bytes.value)) as ReportV1 };
}

const reportEvents = (x: Harness, runId: RunId) => x.db.repos.events.list(runId, 0, 100_000).filter((e) => e.type === 'report.created');

describe('M5 + decision 1: an uncertain attempt of a finished run is an estimate in its report; a later correction refreshes the report', () => {
  it('a cancelled run with an uncertain attempt: the report lists the estimate (estimatedCharges, ~ totals), never an unknown liability; nothing to decide', async () => {
    const { x, runId, a } = await cancelledWithUnknown({ scenario: UNKNOWN_REVIEW, monthlyAllowanceMicrousd: 100_000 });
    const { report } = await newestReport(x, runId);
    const settled = x.db.repos.ledger.attemptBalances(a.id).settled;
    expect(settled).toBeGreaterThan(0);
    expect(report.unknownLiabilities).toEqual([]);
    expect(report.estimatedCharges).toEqual([{ attemptId: a.id, stepKey: 'review', amountMicrousd: settled, mayNotHaveBeenCharged: false }]);
    expect([report.totals.unknown, report.totals.hasEstimates, report.totals.settledEstimated]).toEqual([0, true, settled]);
    const acc = await x.engine.handle('relay/v1/runs.decideUnknown', { idempotencyKey: 'w4-term-decide-0001', runId, attemptId: a.id, decision: 'accept_estimated_charge' });
    expect(acc.ok ? null : acc.error.details?.['reason']).toBe('decision_not_applicable');
  });

  it('background reconcile of an uncertain attempt of a cancelled run corrects the estimate (never counted twice) and refreshes the report', async () => {
    const lose = (base: ProviderRegistry): ProviderRegistry => ({
      list: () => base.list(),
      get: (id) => {
        const ad = base.get(id);
        return {
          ...ad,
          generate: async (req, gctx) => {
            const res: ModelResult = await ad.generate(req, gctx);
            if (req.metadata.stepKey !== 'review' || req.metadata.purpose !== 'initial') return res;
            return { kind: 'error', error: errors.providerUnavailable(id), phase: 'sent_no_response' };
          },
        };
      },
    });
    const { x, runId, a } = await cancelledWithUnknown({ scenario: 'reconcile-completed', providers: lose });
    const before = await newestReport(x, runId);
    expect(before.report.estimatedCharges).toHaveLength(1);
    const eventsBefore = reportEvents(x, runId).length;
    const out = await reconcileUnknownAttempts(x.ctx, new AbortController().signal);
    expect(out.get(a.id)).toBe('completed');
    const after = await newestReport(x, runId);
    expect(after.id).not.toBe(before.id);
    expect(after.report.estimatedCharges).toEqual([]);
    expect(reportEvents(x, runId).length).toBe(eventsBefore + 1);
    const real = x.db.repos.attempts.get(a.id).usage;
    const X = computeCost({ uncachedInputTokens: real?.uncachedInputTokens ?? 0, cacheReadInputTokens: real?.cacheReadInputTokens ?? 0,
      cacheWriteInputTokens: real?.cacheWriteInputTokens ?? 0, outputTokens: real?.outputTokens ?? 0 }, a.profileSnapshot.prices).microusd;
    expect(x.db.repos.ledger.attemptBalances(a.id)).toEqual({ reserved: 0, unknown: 0, settled: X });
    expect(x.db.repos.ledger.settledByCertainty(runId).estimated).toBe(0);
    expect(after.report.totals.hasEstimates).toBe(false);
    expect(x.db.repos.runs.get(runId).status).toBe('cancelled');
  });
});

describe('B1: a project-allowance edit never resumes a budget_run pause it did not cause', () => {
  it('lowering the project allowance with no credential (null estimate) keeps paused(budget_run)', async () => {
    const x = await open({ monthlyAllowanceMicrousd: 50_000_000 });
    const runId = await x.startRun({ budgetMicrousd: 10_000 });
    expect(await drive(x, runId, ['paused', 'awaiting_approval', 'completed'])).toBe('paused');
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('budget_run');
    for (const p of ['anthropic', 'openai', 'gemini', 'fake'] as const) x.db.repos.credentials.delete(p);
    const p = x.db.repos.projects.get(x.projectId);
    const up = await x.engine.handle('relay/v1/projects.update', { projectId: x.projectId, expectedUpdatedAt: p.updatedAt, patch: { monthlyAllowanceMicrousd: 40_000_000 } });
    expect(up.ok).toBe(true);
    await tick(x.ctx);
    const run = x.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason]).toEqual(['paused', 'budget_run']);
  });

  it('raising the run allowance with a null estimate keeps the pause too', async () => {
    const x = await open({ monthlyAllowanceMicrousd: 50_000_000 });
    const runId = await x.startRun({ budgetMicrousd: 10_000 });
    expect(await drive(x, runId, ['paused', 'awaiting_approval', 'completed'])).toBe('paused');
    for (const p of ['anthropic', 'openai', 'gemini', 'fake'] as const) x.db.repos.credentials.delete(p);
    const res = await x.engine.handle('relay/v1/runs.increaseAllowance', { idempotencyKey: 'w4-null-incr-0001', runId, newAllowanceMicrousd: 20_000 });
    expect(res.ok && res.data.status).toBe('paused');
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('budget_run');
  });
});

describe('B2: a budget scope move keeps the step estimate of the old pause', () => {
  it('profile options keep the step_estimate basis after budget_run → budget_project', async () => {
    const x = await open({ monthlyAllowanceMicrousd: 42_000 });
    const runId = await x.startRun({ budgetMicrousd: 41_000 });
    expect(await drive(x, runId, ['paused', 'awaiting_approval', 'completed'])).toBe('paused');
    const d0 = await x.engine.handle('relay/v1/runs.get', { runId });
    if (!d0.ok) throw new Error(d0.error.code);
    expect(d0.data.pauseReason).toBe('budget_run');
    const detail0 = d0.data.statusDetail?.details ?? {};
    await x.engine.handle('relay/v1/runs.increaseAllowance', { idempotencyKey: 'w4-scope-incr-0001', runId, newAllowanceMicrousd: 5_000_000 });
    const d1 = await x.engine.handle('relay/v1/runs.get', { runId });
    if (!d1.ok) throw new Error(d1.error.code);
    expect(d1.data.pauseReason).toBe('budget_project');
    expect(d1.data.statusDetail?.details?.['stepKey']).toBe(detail0['stepKey']);
    expect(d1.data.statusDetail?.details?.['estimatedInputTokens']).toBe(detail0['estimatedInputTokens']);
    expect(d1.data.profileOptions?.map((o) => o.basis)).toEqual(d0.data.profileOptions?.map((o) => o.basis));
    expect(d1.data.profileOptions?.map((o) => o.basis)).toContain('step_estimate');
  });
});
