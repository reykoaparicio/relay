import { afterEach, describe, expect, it } from 'vitest';
import { microusd } from '@relay/contracts';
import type { RunId, StepKey, StepRunId } from '@relay/contracts';
import { reserveEntries } from './budget.js';
import { lastAliveAt, recoverOnStart } from './recovery.js';
import { applyRunEvent } from './run-machine.js';
import { stepsToPromote, tick } from './runner.js';
import { effectiveStepSnapshot, snapshotOf } from './snapshot.js';
import { applyStepEvent } from './step-machine.js';
import { createHarness } from './testing/harness.js';
import { expectedEstimate } from './testing/estimates.js';
import type { Harness } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const N = microusd(40_000);
const INPUT_TOKENS = 1_000;

/** A running run whose review step holds an attempt crafted in `state` (as a crash would leave it). */
async function crashedAttempt(state: 'reserved' | 'dispatching', responseId = false, streamedOutputTokens = 0): Promise<{ harness: Harness; runId: RunId; stepRunId: StepRunId }> {
  const harness = await createHarness();
  h = harness;
  const runId = await harness.startRun();
  await tick(harness.ctx);
  await tick(harness.ctx);
  const stepRunId = harness.db.tx('immediate', (r) => {
    const run = r.runs.get(runId);
    for (const s of stepsToPromote(r.steps.latestPerStepKey(runId), snapshotOf(run))) applyStepEvent(r, [], s, 'DEPS_MET');
    const step = r.steps.latestFor(runId, 'review' as StepKey);
    if (step === undefined) throw new Error('no review');
    const snap = effectiveStepSnapshot(r, run, step.stepKey);
    const id = harness.ids.next('attempt');
    const now = harness.clock.now();
    r.attempts.insert({ id, runId, stepRunId: step.id, seq: 1, purpose: 'initial', providerId: 'anthropic', modelId: snap.profile.modelId,
      profileSnapshot: snap.profile, requestFingerprint: 'f'.repeat(64), state: 'reserved', reservationMicrousd: N,
      estimate: { inputTokens: INPUT_TOKENS, upperAllowanceMicrousd: N }, priceCatalogVersion: snap.profile.priceCatalogVersion, createdAt: now });
    r.ledger.append(reserveEntries({ N, attemptId: id, runId, projectId: run.projectId, priceCatalogVersion: 'v', createdAt: now }));
    applyStepEvent(r, [], step, 'RESERVED');
    if (state === 'dispatching') {
      r.attempts.transition(id, ['reserved'], 'dispatching', { dispatchedAt: now });
      applyStepEvent(r, [], r.steps.get(step.id), 'DISPATCHING');
      if (responseId) r.attempts.setProviderIds(id, { responseId: 'resp_123' });
      if (streamedOutputTokens > 0) r.events.append(runId, 'attempt.stream_progress', { attemptId: id, stepRunId: step.id, outputTokensSoFar: streamedOutputTokens, elapsedMs: 10 });
    }
    return step.id;
  });
  return { harness, runId, stepRunId };
}

describe('recovery (F9 Wave-1 subset)', () => {
  it('releases a reserved attempt (failed_before_dispatch), returns the step to ready, and interrupts the run', async () => {
    const { harness, runId, stepRunId } = await crashedAttempt('reserved');

    const recovered = await recoverOnStart(harness.ctx);

    expect(recovered).toEqual([runId]);
    const [a] = harness.db.repos.attempts.listForRun(runId);
    expect(a?.state).toBe('failed_before_dispatch');
    expect(harness.db.repos.steps.get(stepRunId).state).toBe('ready');
    expect(harness.db.repos.ledger.attemptBalances(a?.id ?? ('' as never)).reserved).toBe(0);
    expect(harness.db.repos.runs.get(runId).status).toBe('interrupted');
    expect(harness.db.repos.ledger.runBalances(runId).R).toBe(0);
  });

  it.each([false, true])('decision 1: settles EVERY dispatching attempt at once as an estimate, R back to 0, never unknown (responseId: %s)', async (responseId) => {
    const { harness, runId, stepRunId } = await crashedAttempt('dispatching', responseId);

    await recoverOnStart(harness.ctx);

    const [a] = harness.db.repos.attempts.listForRun(runId);
    const E = expectedEstimate(a!, 0); // the recorded input tokens, no output observed
    expect(E).toBeGreaterThan(0);
    expect(a?.state).toBe('unknown');
    expect([a?.outcomeUncertain, a?.mayNotHaveBeenCharged]).toEqual([true, !responseId]); // a response id proves it arrived
    expect(harness.db.repos.steps.get(stepRunId).state).toBe('unknown');
    expect(harness.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: 0, C: E }));
    expect(harness.db.repos.ledger.attemptBalances(a!.id)).toEqual({ reserved: 0, unknown: 0, settled: E });
    expect(harness.db.repos.runs.get(runId).status).toBe('interrupted');
    const detail = await harness.engine.handle('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.availableActions).toEqual(['review_recovery', 'stop', 'export_report']);
    expect(detail.ok && detail.data.unresolvedAttempts).toEqual([]);
    expect(detail.ok && detail.data.uncertainAttempts.map((x) => [x.cost, x.mayNotHaveBeenCharged])).toEqual([[{ microusd: E, certainty: 'estimated' }, !responseId]]);
    expect(detail.ok && detail.data.cost.hasEstimates).toBe(true);
  });

  it('decision 1: output streamed before the crash (stream progress events) is part of the estimate, and rules out "may not have been charged"', async () => {
    const { harness, runId } = await crashedAttempt('dispatching', false, 300);

    await recoverOnStart(harness.ctx);

    const [a] = harness.db.repos.attempts.listForRun(runId);
    expect(harness.db.repos.ledger.attemptBalances(a!.id).settled).toBe(expectedEstimate(a!, 300));
    expect(expectedEstimate(a!, 300)).toBeGreaterThan(expectedEstimate(a!, 0));
    expect(a?.mayNotHaveBeenCharged).toBe(false);
  });

  it('never touches succeeded steps and cancels a cancelling run with its open steps skipped', async () => {
    const { harness, runId } = await crashedAttempt('dispatching');
    harness.db.tx('immediate', (r) => applyRunEvent(r, r.runs.get(runId), { type: 'CANCEL_REQUESTED' }, harness.clock.now(), []));

    await recoverOnStart(harness.ctx);

    expect(harness.db.repos.runs.get(runId).status).toBe('cancelled');
    const states = Object.fromEntries(harness.db.repos.steps.latestPerStepKey(runId).map((s) => [s.stepKey, s.state]));
    expect(states).toEqual(expect.objectContaining({ intake: 'succeeded', review: 'skipped', finalize: 'skipped' }));
    expect(harness.db.repos.ledger.runBalances(runId).R).toBe(0);
    await harness.waitFor(() => harness.db.repos.artifacts.listForRun(runId, ['report']).length === 1);
  });

  it('interrupts a running run with nothing in flight and leaves queued/paused runs alone', async () => {
    const harness = await createHarness();
    h = harness;
    const running = await harness.startRun();
    const queued = await harness.startRun();
    await tick(harness.ctx);

    const recovered = await recoverOnStart(harness.ctx);

    expect(recovered).toEqual([running]);
    expect(harness.db.repos.runs.get(running).status).toBe('interrupted');
    expect(harness.db.repos.runs.get(queued).status).toBe('queued');
  });

  it('B1: downtime never counts — 3 h between the crash and the restart add ~0 to execution_ms_used', async () => {
    const { harness, runId } = await crashedAttempt('dispatching');
    harness.clock.advance(1_000); // the runner was alive for 1 s after the dispatch intent…
    harness.db.tx('immediate', (r) => {
      r.attempts.setProviderIds(r.attempts.listForRun(runId)[0]!.id, { requestId: 'req_1' });
    });
    const before = harness.db.repos.runs.get(runId);
    harness.clock.advance(3 * 3_600_000); // …then crashed; the app restarts 3 h later

    await recoverOnStart(harness.ctx);

    const after = harness.db.repos.runs.get(runId);
    expect(after.status).toBe('interrupted');
    expect(after.runningSince).toBeNull();
    expect(after.executionMsUsed - before.executionMsUsed).toBeLessThan(60_000);
    expect(after.executionMsUsed).toBeLessThan(60_000);
  });

  it('B1: lastAliveAt is the latest run/attempt/event timestamp, capped at now', async () => {
    const { harness, runId } = await crashedAttempt('reserved');
    const t = harness.clock.now();
    harness.clock.advance(5_000);

    expect(harness.db.tx('immediate', (r) => lastAliveAt(r, runId, harness.clock.now()))).toBe(t);
    expect(harness.db.tx('immediate', (r) => lastAliveAt(r, runId, (t - 1) as never))).toBe(t - 1);
  });
});
