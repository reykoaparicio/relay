// Founder decisions 1–3 at engine level:
//   1. an uncertain outcome is settled at once as an estimate (never "unknown"); legacy unknown liabilities are
//      converted at start; a later reconciliation corrects the estimate without counting it twice;
//   2. Pause while queued / running / awaiting approval resumes exactly where it stopped; Export works while in progress;
//   3. per-step output limits on runs.start / runs.preflight with sensible defaults.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIN_OUTPUT_TOKEN_OVERRIDE, errors, upperBound } from '@relay/contracts';
import type { AppError, AttemptId, EpochMs, ReportV1, RunId, StepKey } from '@relay/contracts';
import type { ModelResult } from '@relay/providers';
import { reconcileUnknownAttempts, recoverOnStart } from './recovery.js';
import { defaultOutputTokens } from './run-start.js';
import { applyRunEvent } from './run-machine.js';
import { tick } from './runner.js';
import { snapshotOf } from './snapshot.js';
import { applyStepEvent } from './step-machine.js';
import { approvePending, drive, driveThroughApproval, wrapAdapters } from './testing/drive.js';
import { expectedEstimate } from './testing/estimates.js';
import { SAMPLE_FILES, createHarness } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';
import { convertLegacyUnknowns } from './uncertain.js';

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

const REVIEW = 'review' as StepKey;
const detailOf = async (x: Harness, runId: RunId) => {
  const d = await x.engine.handle('relay/v1/runs.get', { runId });
  if (!d.ok) throw new Error(d.error.code);
  return d.data;
};
const ledgerOf = (x: Harness, runId: RunId, attemptId: AttemptId) =>
  x.db.repos.ledger.listForRun(runId).map((e) => e.entry).filter((e) => e.attemptId === attemptId);

// ---------------------------------------------------------------- decision 1

describe('decision 1: an uncertain outcome is an estimate, counted at once', () => {
  it('unknown-before-response: no response byte → the estimate carries "may not have been charged" (attempt, view, report)', async () => {
    const x = await open({ scenario: 'unknown-before-response' });
    const runId = await x.startRun();
    expect(await driveThroughApproval(x, runId, ['paused'])).toBe('paused');

    const a = x.db.repos.attempts.listForRun(runId).find((y) => y.state === 'unknown')!;
    const E = expectedEstimate(a, 0);
    expect([a.outcomeUncertain, a.mayNotHaveBeenCharged, a.providerResponseId]).toEqual([true, true, null]);
    expect(x.db.repos.ledger.attemptBalances(a.id)).toEqual({ reserved: 0, unknown: 0, settled: E });
    const d = await detailOf(x, runId);
    expect([d.pauseReason, d.availableActions]).toEqual(['unknown_outcome', ['retry_step', 'stop', 'export_report']]);
    expect(d.uncertainAttempts.map((v) => [v.id, v.cost, v.mayNotHaveBeenCharged])).toEqual([[a.id, { microusd: E, certainty: 'estimated' }, true]]);
    expect(d.statusDetail?.code).toBe('REQUEST_OUTCOME_UNKNOWN');
    expect(d.statusDetail?.details).toEqual({ estimatedMicrousd: E, mayNotHaveBeenCharged: true });

    await x.engine.handle('relay/v1/runs.cancel', { runId });
    await x.waitFor(() => x.db.repos.artifacts.listForRun(runId, ['report']).length === 1);
    const row = x.db.repos.artifacts.listForRun(runId, ['report'])[0]!;
    const bytes = await x.ctx.artifacts.read(row.relPath, 1_000_000);
    const report = JSON.parse(new TextDecoder().decode(bytes.ok ? bytes.value : new Uint8Array())) as ReportV1;
    expect(report.estimatedCharges).toEqual([{ attemptId: a.id, stepKey: 'implement', amountMicrousd: E, mayNotHaveBeenCharged: true }]);
    expect(report.totals.hasEstimates).toBe(true);
  });

  it('unknown-outcome (a response id arrived): the same estimate without the note', async () => {
    const x = await open({ scenario: 'unknown-outcome' });
    const runId = await x.startRun();
    expect(await driveThroughApproval(x, runId, ['paused'])).toBe('paused');
    const a = x.db.repos.attempts.listForRun(runId).find((y) => y.state === 'unknown')!;
    expect([a.outcomeUncertain, a.mayNotHaveBeenCharged]).toEqual([true, false]);
    expect(x.db.repos.ledger.attemptBalances(a.id).settled).toBe(expectedEstimate(a, 0));
  });

  it('an estimate above the reservation is an overrun like any other (budget_overrun), then retry_step for the uncertain step', async () => {
    const x = await open({ providers: wrapAdapters({ generate: (base, req, gctx) => {
      if (req.metadata.stepKey !== 'review') return base.get(req.providerId).generate(req, gctx);
      const partialUsage = { uncachedInputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5_000_000 };
      return Promise.resolve<ModelResult>({ kind: 'error', error: errors.requestOutcomeUnknown('x' as never, { details: { partialUsage } }), phase: 'responded_partial' });
    } }) });
    const runId = await x.startRun({ budgetMicrousd: 500_000_000 });
    expect(await drive(x, runId, ['paused'])).toBe('paused');

    const [a] = x.db.repos.attempts.listForRun(runId);
    const E = expectedEstimate(a!, 5_000_000);
    expect(E).toBeGreaterThan(a!.reservationMicrousd);
    expect(x.db.repos.ledger.attemptBalances(a!.id)).toEqual({ reserved: 0, unknown: 0, settled: E }); // uncapped, R back to 0
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('budget_overrun');
    expect(x.db.repos.events.list(runId, 0, 500).some((e) => e.type === 'ledger.overrun')).toBe(true);
    const ack = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'd1-ack-overrun-001', runId, decision: { kind: 'acknowledge_overrun' } });
    expect(ack.ok && ack.data.status).toBe('queued');
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    expect((await detailOf(x, runId)).availableActions).toEqual(['retry_step', 'stop', 'export_report']); // never retried on its own
  });

  it('a later correction of a RETRIED (abandoned) uncertain attempt replaces its estimate once; the next start does not look it up again', async () => {
    const x = await open({ scenario: { name: 'mid-lookup', capabilityOverrides: { supportsRequestLookup: true },
      steps: [{ match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'midstream_error' }, reconcile: ['completed'] }] } });
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const [a] = x.db.repos.attempts.listForRun(runId);
    const E = x.db.repos.ledger.attemptBalances(a!.id).settled;
    const step = x.db.repos.steps.latestFor(runId, REVIEW)!;
    const retried = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'd1-retry-abandon-1', runId, stepId: step.id });
    expect(retried.ok).toBe(true);
    expect(x.db.repos.attempts.get(a!.id).state).toBe('abandoned');

    const out = await reconcileUnknownAttempts(x.ctx, new AbortController().signal);

    expect(out.get(a!.id)).toBe('completed');
    const after = x.db.repos.attempts.get(a!.id);
    expect(after.state).toBe('abandoned'); // its step moved on: only the cost is corrected
    const entries = ledgerOf(x, runId, a!.id).map((e) => [e.type, e.deltaMicrousd, e.certainty]);
    const X = x.db.repos.ledger.attemptBalances(a!.id).settled;
    expect(entries.slice(-2)).toEqual([['settle', 0 - E, 'estimated'], ['settle', X, 'calculated']]);
    expect(x.db.repos.ledger.attemptBalances(a!.id)).toEqual({ reserved: 0, unknown: 0, settled: X });
    expect(x.db.repos.steps.latestFor(runId, REVIEW)?.retryIndex).toBe(1); // the retry row is untouched
    const polls = x.callLog.reconcileEntries().length;
    const again = await reconcileUnknownAttempts(x.ctx, new AbortController().signal);
    expect(again.has(a!.id)).toBe(false); // corrected: never looked up again
    expect(x.callLog.reconcileEntries()).toHaveLength(polls);
    expect(ledgerOf(x, runId, a!.id)).toHaveLength(entries.length);
  });

  it('ledger.exportTo keeps the certainty column: the uncertain attempt reads "estimated"', async () => {
    const x = await open({ scenario: 'midstream-error' });
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const dir = await import('node:fs/promises').then((fs) => fs.mkdtemp(join(x.userDataDir, 'ledger-')));

    const res = await x.engine.handle('relay/v1/ledger.exportTo', { runId, destinationRealpath: dir });

    expect(res.ok).toBe(true);
    const csv = await readFile(join(dir, (await readdir(dir))[0]!), 'utf8');
    expect(csv.split('\r\n').filter((l) => l.includes(',settle,settled,'))).toEqual([expect.stringMatching(/,settle,settled,\d+\.\d{6},estimated,/)]);
    expect(csv).not.toContain(',unknown,');
  });
});

/** A legacy (pre-decision-1) unknown liability: the attempt moved to the `unknown` bucket, waiting for a decision. */
function seedLegacyUnknown(x: Harness, runId: RunId, o: { outputTokens: number | null; inputTokens: number; N: number }): AttemptId {
  return x.db.tx('immediate', (r) => {
    const run = r.runs.get(runId);
    const step = r.steps.latestFor(runId, REVIEW)!;
    for (const s of r.steps.latestPerStepKey(runId)) if (s.stepKey === 'intake' && s.state !== 'succeeded') r.steps.transition(s.id, [s.state], 'succeeded', {});
    const snap = snapshotOf(run).steps[REVIEW];
    if (snap?.kind !== 'model') throw new Error('review');
    const id = x.ids.next('attempt');
    const now = x.clock.now();
    r.attempts.insert({ id, runId, stepRunId: step.id, seq: 1, purpose: 'initial', providerId: snap.profile.providerId, modelId: snap.profile.modelId,
      profileSnapshot: snap.profile, requestFingerprint: 'f'.repeat(64), state: 'reserved', reservationMicrousd: o.N,
      estimate: { inputTokens: o.inputTokens, upperAllowanceMicrousd: o.N }, priceCatalogVersion: snap.profile.priceCatalogVersion, createdAt: now });
    r.attempts.transition(id, ['reserved'], 'dispatching', { dispatchedAt: now });
    r.attempts.transition(id, ['dispatching'], 'unknown', { finishedAt: now, error: errors.requestOutcomeUnknown(id),
      ...(o.outputTokens === null ? {} : { usage: { uncachedInputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: o.outputTokens, partial: true } }) });
    const base = { scope: 'run' as const, attemptId: id, runId, projectId: run.projectId, priceCatalogVersion: 'v', createdAt: now };
    r.ledger.append([{ ...base, type: 'reserve', bucket: 'reserved', deltaMicrousd: o.N }]);
    r.ledger.append([
      { ...base, type: 'move_to_unknown', bucket: 'reserved', deltaMicrousd: -o.N },
      { ...base, type: 'move_to_unknown', bucket: 'unknown', deltaMicrousd: o.N, certainty: 'unknown' },
    ]);
    if (step.state === 'pending') applyStepEvent(r, [], step, 'DEPS_MET');
    r.steps.transition(step.id, [r.steps.get(step.id).state], 'unknown', { error: errors.requestOutcomeUnknown(id) });
    return id;
  });
}

describe('decision 1: legacy unknown liabilities are converted to estimates at engine start', () => {
  async function pausedLegacy(outputTokens: number | null) {
    const x = await open();
    const runId = await x.startRun();
    await tick(x.ctx); // queued → running
    const id = seedLegacyUnknown(x, runId, { outputTokens, inputTokens: 2_000, N: 90_000 });
    x.db.tx('immediate', (r) => applyRunEvent(r, r.runs.get(runId), { type: 'UNKNOWN_OUTCOME', attemptId: id, error: errors.requestOutcomeUnknown(id) }, x.clock.now(), []));
    return { x, runId, id };
  }

  it('resolve_unknown −U + settle +estimate (booked in the attempt month), marked uncertain, idempotent and logged; the run then offers retry_step', async () => {
    const { x, runId, id } = await pausedLegacy(150);
    const a = x.db.repos.attempts.get(id);
    expect(x.db.repos.ledger.runBalances(runId).U).toBe(90_000);
    x.timers.advance(40 * 24 * 3600 * 1000); // the conversion runs weeks later

    expect(await convertLegacyUnknowns(x.ctx)).toBe(1);

    const E = expectedEstimate(a, 150);
    const conv = ledgerOf(x, runId, id).slice(-2);
    expect(conv.map((e) => [e.type, e.bucket, e.deltaMicrousd, e.certainty])).toEqual([['resolve_unknown', 'unknown', -90_000, null], ['settle', 'settled', E, 'estimated']]);
    for (const e of conv) expect(e.createdAt).toBe(a.dispatchedAt); // never moved into the current month
    expect(x.db.repos.ledger.attemptBalances(id)).toEqual({ reserved: 0, unknown: 0, settled: E });
    expect(x.db.repos.attempts.get(id)).toEqual(expect.objectContaining({ outcomeUncertain: true, mayNotHaveBeenCharged: false })); // output was observed
    expect(x.logger.entries.find((e) => e.event === 'recovery.unknown_converted')?.fields).toEqual({ liabilities: 1, estimatedMicrousd: E });
    expect(await convertLegacyUnknowns(x.ctx)).toBe(0);
    expect(ledgerOf(x, runId, id)).toHaveLength(5);

    const d = await detailOf(x, runId);
    expect([d.unresolvedAttempts, d.availableActions, d.cost.unknown]).toEqual([[], ['retry_step', 'stop', 'export_report'], 0]);
    const retried = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'd1-legacy-retry-01', runId, stepId: x.db.repos.steps.latestFor(runId, REVIEW)!.id });
    expect(retried.ok && retried.data.status).toBe('queued');
  });

  it('engine start (recoverOnStart) converts too; nothing observed → "may not have been charged"; a legacy setup liability settles at its amount', async () => {
    const { x, runId, id } = await pausedLegacy(null);
    x.db.tx('immediate', (r) => r.ledger.append([
      { scope: 'setup', type: 'move_to_unknown', bucket: 'reserved', deltaMicrousd: -700, createdAt: x.clock.now() },
      { scope: 'setup', type: 'move_to_unknown', bucket: 'unknown', deltaMicrousd: 700, certainty: 'unknown', createdAt: x.clock.now() },
    ]));
    x.db.tx('immediate', (r) => r.ledger.append([{ scope: 'setup', type: 'reserve', bucket: 'reserved', deltaMicrousd: 700, createdAt: x.clock.now() }]));

    await recoverOnStart(x.ctx);

    expect(x.db.repos.attempts.get(id).mayNotHaveBeenCharged).toBe(true);
    expect(x.db.repos.ledger.attemptBalances(id).settled).toBe(expectedEstimate(x.db.repos.attempts.get(id), 0));
    expect(x.db.repos.ledger.runBalances(runId).U).toBe(0);
    expect(x.db.repos.ledger.setupBalances(0 as EpochMs, Number.MAX_SAFE_INTEGER as EpochMs)).toEqual({ C: 700, R: 0, U: 0 });
    expect(x.db.repos.ledger.openUnknownLiabilities()).toEqual([]);
  });

  it('a finished run with a legacy liability gets a refreshed report listing the estimate', async () => {
    const { x, runId, id } = await pausedLegacy(null);
    await x.engine.handle('relay/v1/runs.cancel', { runId });
    await x.waitFor(() => x.db.repos.artifacts.listForRun(runId, ['report']).length === 1);

    await convertLegacyUnknowns(x.ctx);

    const reports = x.db.repos.artifacts.listForRun(runId, ['report']);
    expect(reports).toHaveLength(2);
    const bytes = await x.ctx.artifacts.read(reports.at(-1)!.relPath, 1_000_000);
    const report = JSON.parse(new TextDecoder().decode(bytes.ok ? bytes.value : new Uint8Array())) as ReportV1;
    expect(report.unknownLiabilities).toEqual([]);
    expect(report.estimatedCharges).toEqual([{ attemptId: id, stepKey: 'review', amountMicrousd: x.db.repos.ledger.attemptBalances(id).settled, mayNotHaveBeenCharged: true }]);
    expect(report.totals.unknown).toBe(0);
  });
});

// ---------------------------------------------------------------- decision 2

describe('decision 2: Pause resumes exactly where it stopped', () => {
  it('queued: pauses at once (paused(user), nothing in flight); resume re-queues and the run completes', async () => {
    const x = await open();
    const runId = await x.startRun();

    const paused = await x.engine.handle('relay/v1/runs.pause', { runId });

    expect(paused.ok && paused.data).toEqual({ status: 'paused', inFlight: 'none' });
    expect(x.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'user', pauseRequested: false }));
    await tick(x.ctx);
    expect(x.db.repos.runs.get(runId).status).toBe('paused'); // the loop never picks it
    expect((await detailOf(x, runId)).availableActions).toEqual(['resume', 'stop', 'export_report']);
    const resumed = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'd2-queued-resume-1', runId, decision: { kind: 'continue' } });
    expect(resumed.ok && resumed.data.status).toBe('queued');
    expect(await driveThroughApproval(x, runId, ['completed'])).toBe('completed');
  });

  it('awaiting_approval: the pending approval is kept; resume returns to awaiting_approval; approving then completes; outputs kept', async () => {
    const x = await open();
    const runId = await x.startRun();
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    const before = await detailOf(x, runId);
    const outputs = x.db.repos.steps.latestPerStepKey(runId).filter((s) => s.state === 'succeeded').map((s) => [s.stepKey, s.outputArtifactId]);
    expect(before.availableActions).toEqual(['approve', 'request_revision', 'reject', 'pause', 'cancel', 'export_report']);

    const paused = await x.engine.handle('relay/v1/runs.pause', { runId });

    expect(paused.ok && paused.data).toEqual({ status: 'paused', inFlight: 'none' });
    const d = await detailOf(x, runId);
    expect([d.status, d.pauseReason, d.pendingApproval?.id]).toEqual(['paused', 'user', before.pendingApproval?.id]);
    const early = await x.engine.handle('relay/v1/approvals.decide', { idempotencyKey: 'd2-approve-early-1', approvalId: before.pendingApproval!.id,
      planHash: before.pendingApproval!.planHash, contextHash: before.pendingApproval!.contextHash, decision: 'approved' });
    expect(early.ok).toBe(false); // only resume / stop while paused

    const resumed = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'd2-await-resume-01', runId, decision: { kind: 'continue' } });

    expect(resumed.ok && resumed.data.status).toBe('awaiting_approval');
    const again = await detailOf(x, runId);
    expect(again.pendingApproval?.id).toBe(before.pendingApproval?.id);
    expect(x.db.repos.steps.latestPerStepKey(runId).filter((s) => s.state === 'succeeded').map((s) => [s.stepKey, s.outputArtifactId])).toEqual(outputs);
    await approvePending(x, runId, 'd2-approve-after-01');
    expect(await drive(x, runId, ['completed'])).toBe('completed');
    expect(x.callLog.entries().filter((c) => c.stepKey === 'review')).toHaveLength(1); // nothing re-run
  });

  it('running with a call in flight: the call completes and settles; the pause applies before the next step; resume continues from there', async () => {
    const x = await open({ scenario: 'slow-review' });
    const runId = await x.startRun();
    await tick(x.ctx); // queued → running
    await tick(x.ctx); // intake
    const inFlight = tick(x.ctx); // review: dispatches, then waits 5 s on the injected timers
    await x.waitFor(() => x.db.repos.attempts.listForRun(runId)[0]?.state === 'dispatching');

    const paused = await x.engine.handle('relay/v1/runs.pause', { runId });
    expect(paused.ok && paused.data).toEqual({ status: 'running', inFlight: 'waiting' });
    x.timers.advance(5_000);
    await inFlight;

    expect(x.db.repos.attempts.listForRun(runId).map((a) => a.state)).toEqual(['succeeded']); // completed normally
    expect(x.db.repos.steps.latestFor(runId, REVIEW)?.state).toBe('succeeded');
    await tick(x.ctx);
    expect(x.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'user' }));
    expect(x.callLog.entries().filter((c) => c.stepKey === 'plan')).toHaveLength(0); // paused before the next step

    const resumed = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'd2-running-resume-1', runId, decision: { kind: 'continue' } });
    expect(resumed.ok && resumed.data.status).toBe('queued');
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    expect(x.callLog.entries().map((c) => c.stepKey)).toEqual(['review', 'plan']); // review never re-run
  });

  it('pause is refused (CONFLICT run_not_running) for paused, interrupted and terminal runs', async () => {
    const x = await open();
    const runId = await x.startRun();
    await x.engine.handle('relay/v1/runs.pause', { runId });
    const again = await x.engine.handle('relay/v1/runs.pause', { runId });
    expect(again.ok ? null : [again.error.code, again.error.details?.['reason']]).toEqual(['CONFLICT', 'run_not_running']);
    await x.engine.handle('relay/v1/runs.cancel', { runId });
    const done = await x.engine.handle('relay/v1/runs.pause', { runId });
    expect(done.ok ? null : done.error.code).toBe('CONFLICT');
  });
});

describe('decision 2: Export while a run is in progress', () => {
  async function exportOf(x: Harness, runId: RunId, what: 'report' | 'patch' | 'both') {
    const dir = await import('node:fs/promises').then((fs) => fs.mkdtemp(join(x.userDataDir, 'export-')));
    const res = await x.engine.handle('relay/v1/artifacts.exportTo', { runId, what, destinationRealpath: dir });
    const files = await readdir(dir);
    const text = async (suffix: string) => {
      const f = files.find((n) => n.endsWith(suffix));
      return f === undefined ? null : readFile(join(dir, f), 'utf8');
    };
    return { res, md: await text('.md'), patch: await text('.patch') };
  }

  it('awaiting approval: the interim report has the finished outputs (findings, plan), the pending approval, costs so far; nothing is stored', async () => {
    const x = await open();
    const runId = await x.startRun();
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    const reportsBefore = x.db.repos.artifacts.listForRun(runId, ['report']).length;

    const { res, md } = await exportOf(x, runId, 'report');

    expect(res.ok && res.data.written?.map((w) => w.what)).toEqual(['report']);
    expect(md).toMatch(/> In progress — exported \S+; 3 of 7 steps finished/);
    expect(md).toContain('- Status: awaiting_approval');
    expect(md).toContain('### review — findings (');
    expect(md).toContain('### plan — plan (');
    expect(md).toMatch(/\| approve \| apr_\w+ \| \w{12} \| not decided \|/);
    expect(md).toMatch(/- Settled, calculated from usage: \$0\.\d{6}/);
    expect(md).not.toContain('~$'); // no estimate yet
    expect(x.db.repos.artifacts.listForRun(runId, ['report'])).toHaveLength(reportsBefore); // never stored as the run's report
    expect(reportsBefore).toBe(0);
  });

  it('paused(unknown_outcome): costs so far include the estimate, marked "~" with the note', async () => {
    const x = await open({ scenario: 'unknown-before-response' });
    const runId = await x.startRun();
    expect(await driveThroughApproval(x, runId, ['paused'])).toBe('paused');

    const { md } = await exportOf(x, runId, 'report');

    expect(md).toContain('(includes estimates)');
    expect(md).toMatch(/- implement attempt att_\w+: ~\$\d+\.\d{6} \(estimated\) — the outcome was uncertain; may not have been charged/);
    expect(md).toMatch(/- Settled, estimated: ~\$/);
  });

  it('once a patch exists the patch part is written too (paused before verify), with per-part results', async () => {
    const x = await open({ scenario: { name: 'slow-implement', steps: [{ match: { stepKey: 'implement' }, delayMs: 1_000, result: { kind: 'success' } }] } });
    const runId = await x.startRun();
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    await approvePending(x, runId);
    for (let i = 0; i < 10 && x.db.repos.runs.get(runId).status !== 'running'; i += 1) await tick(x.ctx);
    const inFlight = (async () => {
      for (let i = 0; i < 10 && x.db.repos.steps.latestFor(runId, 'implement' as StepKey)?.state !== 'succeeded'; i += 1) await tick(x.ctx);
    })();
    await x.waitFor(() => x.db.repos.attempts.listForRun(runId).some((a) => a.state === 'dispatching'));
    await x.engine.handle('relay/v1/runs.pause', { runId });
    x.timers.advance(1_000);
    await inFlight;
    await tick(x.ctx);
    expect(x.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'user' }));
    expect((await detailOf(x, runId)).availableActions).toEqual(['resume', 'stop', 'export_report', 'export_patch']);

    const { res, md, patch } = await exportOf(x, runId, 'both');

    expect(res.ok && [res.data.written?.map((w) => w.what), res.data.failed]).toEqual([['report', 'patch'], undefined]);
    expect(md).toMatch(/; 5 of 7 steps finished/);
    expect(md).toContain('### implement — patch (');
    expect(patch).toContain('+++ b/src/');
  });
});

// ---------------------------------------------------------------- decision 3

describe('decision 3: per-step output limits', () => {
  const startInput = (x: Harness, extra: Record<string, unknown> = {}, key = 'd3-start-key-00001') => ({
    idempotencyKey: key, projectId: x.projectId, workflowId: x.db.repos.workflows.listWorkflows()[0]!.id, workflowVersion: 1,
    goal: 'Fix the defects in the handlers.', input: { kind: 'files' as const, relPaths: Object.keys(SAMPLE_FILES) }, ...extra,
  });
  const preflight = (x: Harness, extra: Record<string, unknown> = {}) => {
    const input: Record<string, unknown> = { ...startInput(x, extra) };
    delete input['idempotencyKey'];
    return x.engine.handle('relay/v1/runs.preflight', input as never);
  };

  it('preflight lists every model step box (workflow step setting → profile → model cap) and the first reservation reflects an override', async () => {
    const x = await open();

    const plain = await preflight(x);
    const small = await preflight(x, { outputTokenOverrides: { review: 1_000 } });

    expect(plain.ok && plain.data.stepLimits).toEqual([
      { stepKey: 'review', defaultMaxOutputTokens: 8_000, minMaxOutputTokens: MIN_OUTPUT_TOKEN_OVERRIDE, modelMaxOutputTokens: 64_000 },
      { stepKey: 'plan', defaultMaxOutputTokens: 8_000, minMaxOutputTokens: 256, modelMaxOutputTokens: 128_000 },
      { stepKey: 'implement', defaultMaxOutputTokens: 16_000, minMaxOutputTokens: 256, modelMaxOutputTokens: 128_000 },
      { stepKey: 'verify', defaultMaxOutputTokens: 8_000, minMaxOutputTokens: 256, modelMaxOutputTokens: 128_000 },
    ]);
    const prices = x.db.repos.catalog.get('anthropic', 'claude-haiku-4-5')!.prices;
    const tokens = plain.ok ? plain.data.inputSummary.estimatedInputTokens : 0;
    expect(plain.ok && plain.data.firstReservation.N).toBe(upperBound(tokens, 8_000, prices));
    expect(small.ok && small.data.firstReservation.N).toBe(upperBound(tokens, 1_000, prices));
  });

  it('an override goes into the run snapshot and sets the request maximum and the reservation N', async () => {
    const x = await open();
    const started = await x.engine.handle('relay/v1/runs.start', startInput(x, { outputTokenOverrides: { review: 1_000, implement: 20_000 } }));
    if (!started.ok) throw new Error(started.error.code);
    const runId = started.data.runId;

    const snap = snapshotOf(x.db.repos.runs.get(runId));
    expect([snap.steps[REVIEW], snap.steps['implement' as StepKey], snap.steps['plan' as StepKey]].map((s) => (s?.kind === 'model' ? s.maxOutputTokens : null))).toEqual([1_000, 20_000, 8_000]);
    expect(snap.outputTokenOverrides).toEqual({ review: 1_000, implement: 20_000 });
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    const [review] = x.db.repos.attempts.listForRun(runId);
    const estimate = review!.estimate as { inputTokens: number; maxOutputTokens: number };
    expect(estimate.maxOutputTokens).toBe(1_000);
    expect(review!.reservationMicrousd).toBe(upperBound(estimate.inputTokens, 1_000, review!.profileSnapshot.prices));
  });

  it('rejects an override above the model cap, an unknown or non-model step key, and a value below 256 (VALIDATION_FAILED at the path); nothing starts', async () => {
    const x = await open();
    const codeOf = (r: { ok: true } | { ok: false; error: AppError }) => (r.ok ? null : [r.error.code, (r.error.details?.['issues'] as { path: string; code: string }[] | undefined)?.map((i) => [i.path, i.code])]);

    const tooHigh = await x.engine.handle('relay/v1/runs.start', startInput(x, { outputTokenOverrides: { review: 64_001 } }, 'd3-start-key-00002'));
    const tooHighPre = await preflight(x, { outputTokenOverrides: { review: 64_001 } });
    const notModel = await x.engine.handle('relay/v1/runs.start', startInput(x, { outputTokenOverrides: { approve: 1_000 } }, 'd3-start-key-00003'));
    const unknown = await preflight(x, { outputTokenOverrides: { nope: 1_000 } });
    const tooLow = await x.engine.handle('relay/v1/runs.start', startInput(x, { outputTokenOverrides: { review: 255 } }, 'd3-start-key-00004'));
    const fraction = await preflight(x, { outputTokenOverrides: { review: 1000.5 } });

    expect(codeOf(tooHigh)).toEqual(['VALIDATION_FAILED', [['outputTokenOverrides.review', 'above_model_max']]]);
    expect(codeOf(tooHighPre)).toEqual(['VALIDATION_FAILED', [['outputTokenOverrides.review', 'above_model_max']]]);
    expect(codeOf(notModel)).toEqual(['VALIDATION_FAILED', [['outputTokenOverrides.approve', 'unknown_step']]]);
    expect(codeOf(unknown)).toEqual(['VALIDATION_FAILED', [['outputTokenOverrides.nope', 'unknown_step']]]);
    expect(tooLow.ok ? null : tooLow.error.code).toBe('VALIDATION_FAILED');
    expect(fraction.ok ? null : fraction.error.code).toBe('VALIDATION_FAILED');
    expect(x.db.repos.runs.idsForProject(x.projectId)).toEqual([]);
  });

  it('an override is checked against the CHOSEN profile: allowed with a larger model, refused once the profile change makes it too large', async () => {
    const x = await open();
    const capable = x.db.repos.profiles.getByName('Capable')!; // claude-opus-5-5: 128k output
    const big = { review: 100_000 };

    const withCapable = await preflight(x, { profileOverrides: { review: capable.id }, outputTokenOverrides: big });
    const withDefault = await preflight(x, { outputTokenOverrides: big }); // review = Economy (haiku, 64k)

    expect(withCapable.ok && withCapable.data.stepLimits[0]).toEqual({ stepKey: 'review', defaultMaxOutputTokens: 8_000, minMaxOutputTokens: 256, modelMaxOutputTokens: 128_000 });
    expect(withDefault.ok ? null : [withDefault.error.code, withDefault.error.details?.['issues']]).toEqual(['VALIDATION_FAILED',
      [expect.objectContaining({ path: 'outputTokenOverrides.review', code: 'above_model_max' })]]);
  });

  it('defaults clamp: a profile asking for more output than its model returns is clamped (no MODEL_UNSUPPORTED), the step setting still wins', async () => {
    const x = await open();
    const economy = x.db.repos.profiles.getByName('Economy')!;
    const huge = x.db.repos.profiles.upsert({ id: x.ids.next('profile'), name: 'Huge', providerId: economy.providerId, modelId: economy.modelId,
      params: { ...economy.params, maxOutputTokens: 100_000 }, capabilitiesSnapshot: economy.capabilitiesSnapshot, catalogVersion: economy.catalogVersion });
    if (!huge.ok) throw new Error('profile');

    const pre = await preflight(x, { profileOverrides: { review: huge.value.id } });
    const started = await x.engine.handle('relay/v1/runs.start', startInput(x, { profileOverrides: { review: huge.value.id } }));

    expect(pre.ok && pre.data.issues.filter((i) => i.code === 'output_budget_low')).toEqual([]);
    expect(pre.ok && pre.data.stepLimits[0]?.defaultMaxOutputTokens).toBe(8_000);
    if (!started.ok) throw new Error(started.error.code);
    const review = snapshotOf(x.db.repos.runs.get(started.data.runId)).steps[REVIEW];
    expect(review?.kind === 'model' && [review.profile.params.maxOutputTokens, review.maxOutputTokens]).toEqual([64_000, 8_000]);
    expect(defaultOutputTokens(undefined, 100_000, 64_000)).toBe(64_000); // profile → model cap
    expect(defaultOutputTokens(90_000, 8_000, 64_000)).toBe(64_000); // workflow step setting → model cap
    expect(defaultOutputTokens(undefined, 8_000, 64_000)).toBe(8_000);
  });
});
