// Referee fixes for decision 1 (estimates instead of unknown), ported from the bug hunt on f8c9f0f:
// D1-1 corrections / recovery settlements booked in the charge's month and a per-attempt month "~"; D1-2 a $0
// correction is no longer "estimated"; D1-3 a definitive lookup without usage is never repeated; D1-4 a stale report
// is refreshed at start and forceUnknown records `ledger.overrun`.
import { afterEach, describe, expect, it } from 'vitest';
import { errors, microusd } from '@relay/contracts';
import type { ProviderId, ReportV1, RunId, StepKey } from '@relay/contracts';
import type { ModelResult, ProviderRegistry } from '@relay/providers';
import { reserveEntries } from './budget.js';
import { monthWindowOf } from './clock.js';
import { recoverOnStart, reconcileUnknownAttempts } from './recovery.js';
import { regenerateReportBatch, stepsToPromote, tick } from './runner.js';
import { effectiveStepSnapshot, snapshotOf } from './snapshot.js';
import { applyStepEvent } from './step-machine.js';
import { drive, driveThroughApproval, wrapAdapters } from './testing/drive.js';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';
import { correctionEntries } from './uncertain.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const REVIEW = 'review' as StepKey;
const SEP_30 = new Date(2026, 8, 30, 12).getTime();
const OCT_2 = new Date(2026, 9, 2, 12).getTime();
const signal = (): AbortSignal => new AbortController().signal;

const lookupScenario = (reconcile: 'completed' | 'failed', times = 1) => ({
  name: 'mid-lookup', capabilityOverrides: { supportsRequestLookup: true },
  steps: [{ match: { stepKey: 'review', purpose: 'initial' as const }, result: { kind: 'midstream_error' as const }, reconcile: [reconcile], times }],
});

async function latestReport(x: Harness, runId: RunId): Promise<ReportV1> {
  const row = x.db.repos.artifacts.listForRun(runId, ['report']).at(-1);
  if (row === undefined) throw new Error('no report');
  const bytes = await x.ctx.artifacts.read(row.relPath, 5_000_000);
  if (!bytes.ok) throw new Error('unreadable report');
  return JSON.parse(new TextDecoder().decode(bytes.value)) as ReportV1;
}

const monthSummary = async (x: Harness, month: string) => {
  const s = await x.engine.handle('relay/v1/ledger.projectSummary', { projectId: x.projectId, month });
  if (!s.ok) throw new Error(s.error.code);
  return s.data;
};

describe('D1-1: an estimate and its correction stay in the month of the charge', () => {
  it('a correction made in October of an estimate booked in September lands in September (no "~", no negative October)', async () => {
    const x = await createHarness({ scenario: lookupScenario('completed') });
    h = x;
    x.clock.set(SEP_30);
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const [a] = x.db.repos.attempts.listForRun(runId);
    if (a === undefined) throw new Error('no attempt');

    x.clock.set(OCT_2); // the next start reconciles
    await reconcileUnknownAttempts(x.ctx, signal());

    const X = x.db.repos.ledger.attemptBalances(a.id).settled;
    const sep = monthWindowOf('2026-09');
    const oct = monthWindowOf('2026-10');
    expect(x.db.repos.ledger.projectMonthBalances(x.projectId, sep.start, sep.end).C).toBe(X);
    expect(x.db.repos.ledger.projectMonthBalances(x.projectId, oct.start, oct.end).C).toBe(0);
    expect((await monthSummary(x, '2026-09')).hasEstimates).toBe(false);
    expect(x.db.repos.ledger.projectMonthEstimated(x.projectId, oct.start, oct.end)).toBe(0);
  });

  it('the month "~" is per attempt: a genuine uncorrected estimate is never hidden by another attempt', async () => {
    const x = await createHarness({ scenario: lookupScenario('completed', Number.POSITIVE_INFINITY) });
    h = x;
    x.clock.set(SEP_30);
    const run1 = await x.startRun({ key: 'run-one-key-000001' });
    expect(await drive(x, run1, ['paused'])).toBe('paused');
    x.clock.set(OCT_2);
    await reconcileUnknownAttempts(x.ctx, signal());
    await x.engine.handle('relay/v1/runs.cancel', { runId: run1 });
    await drive(x, run1, ['cancelled']);
    const run2 = await x.startRun({ key: 'run-two-key-000002' });
    expect(await drive(x, run2, ['paused'])).toBe('paused'); // an October estimate, not looked up (yet)

    expect((await monthSummary(x, '2026-10')).hasEstimates).toBe(true);
  });

  it('crash recovery books the estimate of an attempt dispatched on 30 Sep in September, not at the restart', async () => {
    const x = await createHarness();
    h = x;
    x.clock.set(new Date(2026, 8, 30, 23, 0).getTime());
    const runId = await x.startRun();
    await tick(x.ctx);
    await tick(x.ctx);
    const attemptId = x.db.tx('immediate', (r) => {
      const run = r.runs.get(runId);
      for (const s of stepsToPromote(r.steps.latestPerStepKey(runId), snapshotOf(run))) applyStepEvent(r, [], s, 'DEPS_MET');
      const step = r.steps.latestFor(runId, REVIEW);
      if (step === undefined) throw new Error('no review');
      const snap = effectiveStepSnapshot(r, run, step.stepKey);
      const id = x.ids.next('attempt');
      const now = x.clock.now();
      const N = microusd(40_000);
      r.attempts.insert({ id, runId, stepRunId: step.id, seq: 1, purpose: 'initial', providerId: snap.profile.providerId, modelId: snap.profile.modelId,
        profileSnapshot: snap.profile, requestFingerprint: 'f'.repeat(64), state: 'reserved', reservationMicrousd: N,
        estimate: { inputTokens: 1_000, upperAllowanceMicrousd: N }, priceCatalogVersion: snap.profile.priceCatalogVersion, createdAt: now });
      r.ledger.append(reserveEntries({ N, attemptId: id, runId, projectId: run.projectId, priceCatalogVersion: 'v', createdAt: now }));
      applyStepEvent(r, [], step, 'RESERVED');
      r.attempts.transition(id, ['reserved'], 'dispatching', { dispatchedAt: now });
      applyStepEvent(r, [], r.steps.get(step.id), 'DISPATCHING');
      return id;
    });

    x.clock.set(new Date(2026, 9, 2, 9, 0).getTime()); // restart on 2 Oct
    await recoverOnStart(x.ctx);

    const E = x.db.repos.ledger.attemptBalances(attemptId).settled;
    expect(E).toBeGreaterThan(0);
    const sep = monthWindowOf('2026-09');
    const oct = monthWindowOf('2026-10');
    expect(x.db.repos.ledger.projectMonthBalances(x.projectId, sep.start, sep.end).C).toBe(E);
    expect(x.db.repos.ledger.projectMonthBalances(x.projectId, oct.start, oct.end).C).toBe(0);
  });
});

describe('D1-2: an estimate corrected to $0 is no longer "estimated"', () => {
  it('the report lists no estimated charge, the step cost and the attempt view are not "estimated"', async () => {
    const x = await createHarness({ scenario: lookupScenario('failed') });
    h = x;
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const [a] = x.db.repos.attempts.listForRun(runId);
    if (a === undefined) throw new Error('no attempt');
    await reconcileUnknownAttempts(x.ctx, signal()); // failed, usage reported as none → X = $0 (calculated)
    expect(x.db.repos.ledger.attemptBalances(a.id).settled).toBe(0);

    expect(await driveThroughApproval(x, runId, ['completed', 'incomplete', 'paused'])).toMatch(/completed|incomplete/);
    await x.waitFor(() => x.db.repos.artifacts.listForRun(runId, ['report']).length === 1);
    const report = await latestReport(x, runId);
    const d = await x.engine.handle('relay/v1/runs.get', { runId });
    if (!d.ok) throw new Error(d.error.code);

    expect(report.estimatedCharges).toEqual([]);
    expect(report.totals.hasEstimates).toBe(false);
    expect(report.steps.find((s) => s.stepKey === REVIEW)?.cost.certainty).not.toBe('estimated');
    expect(d.data.attempts?.find((v) => v.id === a.id)?.cost?.certainty).toBe('calculated');
    expect(d.data.uncertainAttempts).toEqual([]);
  });
});

describe('D1-3: a definitive lookup without usage is never repeated', () => {
  it('the attempt is marked lookup-done and later starts do not ask the provider again', async () => {
    let lookups = 0;
    const failedNoUsage = (base: ProviderRegistry): ProviderRegistry => ({
      list: () => base.list(),
      get: (id: ProviderId) => ({
        ...base.get(id),
        reconcile: () => {
          lookups += 1;
          return Promise.resolve({ kind: 'failed' as const, usageKnown: false });
        },
      }),
    });
    const x = await createHarness({ providers: failedNoUsage, scenario: { name: 'mid', capabilityOverrides: { supportsRequestLookup: true },
      steps: [{ match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'midstream_error' } }] } });
    h = x;
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const [a] = x.db.repos.attempts.listForRun(runId);
    if (a === undefined) throw new Error('no attempt');

    for (let i = 0; i < 3; i += 1) await reconcileUnknownAttempts(x.ctx, signal()); // three "starts"

    expect(lookups).toBe(1);
    const after = x.db.repos.attempts.get(a.id);
    expect([after.state, after.lookupDone]).toEqual(['abandoned', true]);
    expect(x.db.repos.ledger.attemptBalances(a.id).settled).toBeGreaterThan(0); // the estimate is kept
  });
});

describe('D1-4: a report older than the ledger is refreshed; forceUnknown records the overrun', () => {
  it('a correction committed without its report refresh (a crash) is put in the report by the start-time batch', async () => {
    const x = await createHarness({ scenario: { name: 'mid', steps: [{ match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'midstream_error' } }] } });
    h = x;
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const [a] = x.db.repos.attempts.listForRun(runId);
    const step = x.db.repos.steps.latestFor(runId, REVIEW);
    if (a === undefined || step === undefined) throw new Error('no attempt');
    const retried = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'retry-key-0000001', runId, stepId: step.id });
    expect(retried.ok).toBe(true);
    expect(await driveThroughApproval(x, runId, ['completed', 'incomplete'])).toMatch(/completed|incomplete/);
    await x.waitFor(() => x.db.repos.artifacts.listForRun(runId, ['report']).length === 1);
    expect((await latestReport(x, runId)).estimatedCharges?.map((c) => c.attemptId)).toEqual([a.id]);

    // A reconciliation corrected the estimate, then the process died before `refreshReport` ran.
    const estimate = microusd(x.db.repos.ledger.attemptBalances(a.id).settled);
    x.db.tx('immediate', (r) => {
      r.ledger.append(correctionEntries({ attemptId: a.id, runId, projectId: x.projectId, priceCatalogVersion: a.priceCatalogVersion,
        createdAt: x.clock.now(), estimate, X: microusd(1), certainty: 'calculated' }));
    });

    expect(await regenerateReportBatch(x.ctx, 10)).toBe(0);

    expect(x.db.repos.artifacts.listForRun(runId, ['report'])).toHaveLength(2);
    const fresh = await latestReport(x, runId);
    expect(fresh.estimatedCharges).toEqual([]);
    expect(fresh.totals.hasEstimates).toBe(false);
    // An up-to-date report is left alone at the next start.
    expect(await regenerateReportBatch(x.ctx, 10)).toBe(0);
    expect(x.db.repos.artifacts.listForRun(runId, ['report'])).toHaveLength(2);
  });

  it('forceUnknown with an estimate above the reservation appends ledger.overrun { N, X } and pauses budget_overrun', async () => {
    // The provider streams far more output than the reservation covers, then the settle never returns (a throw between
    // the response and the settle): the F4 `finally` settles the attempt as an estimate through forceUnknown.
    const x = await createHarness({
      providers: wrapAdapters({
        generate: (_base, _req, gctx): Promise<ModelResult> => {
          gctx.hooks?.onProgress?.({ outputTokensSoFar: 50_000_000, elapsedMs: 1 });
          return Promise.resolve({ kind: 'error', error: errors.providerUnavailable(), phase: 'sent_no_response' });
        },
      }),
      hooks: {
        afterProviderResponse: () => {
          throw new Error('settle never ran');
        },
      },
    });
    h = x;
    const runId = await x.startRun();
    for (let i = 0; i < 20 && !x.db.repos.events.list(runId, 0, 1000).some((e) => e.type === 'attempt.unknown'); i += 1) {
      await tick(x.ctx).catch(() => undefined);
    }

    const [a] = x.db.repos.attempts.listForRun(runId);
    if (a === undefined) throw new Error('no attempt');
    const X = x.db.repos.ledger.attemptBalances(a.id).settled;
    expect(X).toBeGreaterThan(a.reservationMicrousd);
    const overrun = x.db.repos.events.list(runId, 0, 1000).find((e) => e.type === 'ledger.overrun');
    expect(overrun?.payload).toMatchObject({ attemptId: a.id, N: a.reservationMicrousd, X });
    const run = x.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason]).toEqual(['paused', 'budget_overrun']);
  });
});

describe('U-4 (engine): paused(unknown_outcome) with no step left to retry offers resume', () => {
  it('RunDetail fills hasRetryableStep: ["resume", "stop"] is offered, and resume is accepted', async () => {
    const x = await createHarness({ scenario: { name: 'mid', steps: [{ match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'midstream_error' } }] } });
    h = x;
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('unknown_outcome');
    const before = await x.engine.handle('relay/v1/runs.get', { runId });
    expect(before.ok && before.data.availableActions.slice(0, 2)).toEqual(['retry_step', 'stop']);
    // The uncertain step was settled meanwhile (e.g. by a reconciliation): nothing is failed or unknown any more.
    x.db.tx('immediate', (r) => {
      const step = r.steps.latestFor(runId, REVIEW);
      if (step === undefined) throw new Error('no review');
      r.steps.transition(step.id, [step.state], 'ready', {});
    });

    const after = await x.engine.handle('relay/v1/runs.get', { runId });
    expect(after.ok && after.data.availableActions.slice(0, 2)).toEqual(['resume', 'stop']);
    const res = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'resume-uncertain-01', runId, decision: { kind: 'continue' } });
    expect(res.ok && res.data.status).toBe('queued');
  });
});
