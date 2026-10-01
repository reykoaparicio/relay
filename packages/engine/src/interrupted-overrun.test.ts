// Clarification 14 for interrupted runs: an unknown attempt of an INTERRUPTED run that reconciles with X > N is an
// overrun like any live one — review_recovery (`runs.resume { continue }`) must not acknowledge it; the run goes to
// paused(budget_overrun) and only acknowledge_overrun resumes it.
import { afterEach, describe, expect, it } from 'vitest';
import { microusd } from '@relay/contracts';
import type { RunAction, RunId, StepKey } from '@relay/contracts';
import { FAKE_FIXTURES } from '@relay/providers';
import type { FakeScenario, ProviderRegistry, ReconciliationResult } from '@relay/providers';
import { reserveEntries } from './budget.js';
import { recoverOnStart, reconcileUnknownAttempts } from './recovery.js';
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
const LOOKUP: FakeScenario = { name: 'lookup', capabilityOverrides: { supportsRequestLookup: true }, steps: [] };

/** Every adapter's lookup answers `completed` with a valid findings output and a usage far above N. */
const overrunLookup = (base: ProviderRegistry): ProviderRegistry => ({
  list: () => base.list(),
  get: (id) => ({
    ...base.get(id),
    reconcile: (): Promise<ReconciliationResult> => Promise.resolve({ kind: 'completed', json: structuredClone(FAKE_FIXTURES['findings.v1']),
      usage: { uncachedInputTokens: 100, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 900_000 }, rawUsage: null }),
  }),
});

/** A crash left the review attempt dispatching (with a provider response id); recovery interrupts the run. */
async function interruptedWithUnknown(): Promise<{ x: Harness; runId: RunId }> {
  const x = await createHarness({ scenario: LOOKUP, providers: overrunLookup });
  h = x;
  const runId = await x.startRun();
  await tick(x.ctx);
  await tick(x.ctx);
  x.db.tx('immediate', (r) => {
    const run = r.runs.get(runId);
    for (const s of stepsToPromote(r.steps.latestPerStepKey(runId), snapshotOf(run))) applyStepEvent(r, [], s, 'DEPS_MET');
    const step = r.steps.latestFor(runId, 'review' as StepKey);
    if (step === undefined) throw new Error('no review');
    const snap = effectiveStepSnapshot(r, run, step.stepKey);
    const id = x.ids.next('attempt');
    const now = x.clock.now();
    r.attempts.insert({ id, runId, stepRunId: step.id, seq: 1, purpose: 'initial', providerId: snap.profile.providerId, modelId: snap.profile.modelId,
      profileSnapshot: snap.profile, requestFingerprint: 'f'.repeat(64), state: 'reserved', reservationMicrousd: N,
      priceCatalogVersion: snap.profile.priceCatalogVersion, createdAt: now });
    r.ledger.append(reserveEntries({ N, attemptId: id, runId, projectId: run.projectId, priceCatalogVersion: 'v', createdAt: now }));
    applyStepEvent(r, [], step, 'RESERVED');
    r.attempts.transition(id, ['reserved'], 'dispatching', { dispatchedAt: now });
    applyStepEvent(r, [], r.steps.get(step.id), 'DISPATCHING');
    r.attempts.setProviderIds(id, { responseId: 'resp_overrun_1' });
  });
  await recoverOnStart(x.ctx);
  expect(x.db.repos.runs.get(runId).status).toBe('interrupted');
  return { x, runId };
}

const actionsOf = async (x: Harness, runId: RunId): Promise<readonly RunAction[]> => {
  const d = await x.engine.handle('relay/v1/runs.get', { runId });
  return d.ok ? d.data.availableActions : [];
};

describe('interrupted run: a reconciled overrun still requires acknowledge_overrun', () => {
  it('review_recovery → paused(budget_overrun), not queued; acknowledge_overrun then resumes', async () => {
    const { x, runId } = await interruptedWithUnknown();
    const [a] = x.db.repos.attempts.listForRun(runId);
    if (a === undefined) throw new Error('no attempt');

    await reconcileUnknownAttempts(x.ctx, new AbortController().signal);

    expect(x.db.repos.attempts.get(a.id).state).toBe('reconciled_succeeded');
    expect(x.db.repos.ledger.attemptBalances(a.id).settled).toBeGreaterThan(N);
    expect(x.db.repos.runs.get(runId).status).toBe('interrupted'); // reconcile never resumes an interrupted run
    expect(await actionsOf(x, runId)).toEqual(['review_recovery', 'stop']);

    const recovered = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'int-overrun-review-1', runId, decision: { kind: 'continue' } });

    expect(recovered.ok && recovered.data.status).toBe('paused');
    const run = x.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason, run.statusDetail?.details?.['overrun']]).toEqual(['paused', 'budget_overrun', true]);
    expect(await actionsOf(x, runId)).toEqual(['acknowledge_overrun', 'increase_allowance', 'stop']);
    const continued = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'int-overrun-review-2', runId, decision: { kind: 'continue' } });
    expect(continued.ok ? null : continued.error.code).toBe('CONFLICT');

    const ack = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'int-overrun-ack-0001', runId, decision: { kind: 'acknowledge_overrun' } });
    expect(ack.ok && ack.data.status).toBe('queued');
  });

  it('without an overrun, review_recovery still re-queues the interrupted run', async () => {
    const { x, runId } = await interruptedWithUnknown();
    const [a] = x.db.repos.attempts.listForRun(runId);
    await x.engine.handle('relay/v1/runs.decideUnknown', { idempotencyKey: 'int-decide-key-0001', runId, attemptId: a?.id ?? '', decision: 'retry_acknowledging_charge' });

    const recovered = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'int-plain-review-01', runId, decision: { kind: 'continue' } });

    expect(recovered.ok && recovered.data.status).toBe('queued');
  });
});
