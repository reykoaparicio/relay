import { afterEach, describe, expect, it } from 'vitest';
import { microusd } from '@relay/contracts';
import type { RunId, StepKey, StepRunId } from '@relay/contracts';
import { reserveEntries } from './budget.js';
import { recoverOnStart } from './recovery.js';
import { applyRunEvent } from './run-machine.js';
import { stepsToPromote, tick } from './runner.js';
import { effectiveStepSnapshot, snapshotOf } from './snapshot.js';
import { applyStepEvent } from './step-machine.js';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const N = microusd(40_000);

/** A running run whose review step holds an attempt crafted in `state` (as a crash would leave it). */
async function crashedAttempt(state: 'reserved' | 'dispatching', responseId = false): Promise<{ harness: Harness; runId: RunId; stepRunId: StepRunId }> {
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
      priceCatalogVersion: snap.profile.priceCatalogVersion, createdAt: now });
    r.ledger.append(reserveEntries({ N, attemptId: id, runId, projectId: run.projectId, priceCatalogVersion: 'v', createdAt: now }));
    applyStepEvent(r, [], step, 'RESERVED');
    if (state === 'dispatching') {
      r.attempts.transition(id, ['reserved'], 'dispatching', { dispatchedAt: now });
      applyStepEvent(r, [], r.steps.get(step.id), 'DISPATCHING');
      if (responseId) r.attempts.setProviderIds(id, { responseId: 'resp_123' });
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

  it.each([false, true])('moves EVERY dispatching attempt to unknown with the full N (responseId: %s)', async (responseId) => {
    const { harness, runId, stepRunId } = await crashedAttempt('dispatching', responseId);

    await recoverOnStart(harness.ctx);

    const [a] = harness.db.repos.attempts.listForRun(runId);
    expect(a?.state).toBe('unknown');
    expect(harness.db.repos.steps.get(stepRunId).state).toBe('unknown');
    expect(harness.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: N }));
    expect(harness.db.repos.runs.get(runId).status).toBe('interrupted');
    const detail = await harness.engine.handle('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.availableActions).toEqual(['review_recovery', 'decide_unknown', 'stop']);
    expect(detail.ok && detail.data.unresolvedAttempts.map((x) => x.cost)).toEqual([{ microusd: N, certainty: 'unknown' }]);
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
});
