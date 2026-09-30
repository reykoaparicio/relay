// 11 §K6 unknown-reconcile (@m3, F9b): after a restart the reconcile task looks up `unknown` attempts that carry a
// provider response id on an adapter with request lookup. in_progress is re-polled on the injected (manual) timers;
// completed → reconciled_succeeded with resolve_unknown −N + settle and NO new call; failed without usage →
// resolve_unknown −N + settle 0 (calculated); not_found → stays unknown.
import { afterEach, describe, expect, it } from 'vitest';
import type { RunId } from '@relay/contracts';
import type { FakeReconcileAnswer, FakeScenario } from '@relay/providers';
import { expectLedgerMatchesAttempts, expectNoNegativeReserved } from '../helpers/assert-ledger.js';
import { createHarness } from '../helpers/engine-harness.js';
import type { Harness, HarnessOptions } from '../helpers/engine-harness.js';
import { createManualClock } from '../helpers/manual-clock.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const x of harnesses.splice(0)) await x.dispose();
  await cleanupTempDirs();
});

async function open(o: HarnessOptions): Promise<Harness> {
  const x = await createHarness(o);
  harnesses.push(x);
  return x;
}

const LOOKUP = { supportsRequestLookup: true } as const;

/** Runs to paused(unknown_outcome) on implement, then restarts the runtime on the same userData (reconcile at start). */
async function unknownThenRestart(o: HarnessOptions): Promise<{ h: Harness; runId: RunId }> {
  const first = await open(o);
  const runId = await first.startRun();
  await first.waitFor(runId, 'awaiting_approval');
  await first.approve(runId);
  const paused = await first.waitFor(runId, (r) => !['queued', 'running'].includes(r.status));
  expect([paused.status, paused.pauseReason]).toEqual(['paused', 'unknown_outcome']);
  const [a] = first.attempts(runId, 'implement');
  expect(a?.state).toBe('unknown');
  expect(a?.providerResponseId).toBe(`fake_resp_${a!.id}`);
  await first.dispose();
  const h = await open({ ...o, userDataDir: first.userDataDir, projectRoot: first.projectRoot });
  return { h, runId };
}

const scenarioWith = (answers: readonly FakeReconcileAnswer[]): FakeScenario => ({
  name: `reconcile-${answers.join('-')}`,
  steps: [{ match: { stepKey: 'implement', purpose: 'initial' }, result: { kind: 'unknown_after_dispatch' }, reconcile: answers }],
});

describe('unknown reconcile @m3', () => {
  it('reconcile-slow: in_progress ×2 (attempt stays unknown) then completed → reconciled_succeeded, resolve_unknown −N + settle, no new call @m3', async () => {
    const mc = createManualClock();
    const { h, runId } = await unknownThenRestart({ scenario: 'reconcile-slow', fakeCapabilityOverrides: LOOKUP, clock: mc });
    const [a] = h.attempts(runId, 'implement');
    const N = a!.reservationMicrousd;

    await h.waitUntil(() => h.callLog.reconcileEntries().length === 1, 10_000, 'first reconcile poll');
    expect(h.db.repos.attempts.get(a!.id).state).toBe('unknown');
    mc.advance(10_000);
    await h.waitUntil(() => h.callLog.reconcileEntries().length === 2, 10_000, 'second reconcile poll');
    expect(h.db.repos.attempts.get(a!.id).state).toBe('unknown');
    mc.advance(10_000);
    await h.waitUntil(() => h.db.repos.attempts.get(a!.id).state !== 'unknown', 10_000, 'reconciled');

    expect(h.callLog.reconcileEntries()).toHaveLength(3);
    expect(h.db.repos.attempts.get(a!.id).state).toBe('reconciled_succeeded');
    const page = h.db.repos.ledger.list(runId, { limit: 200, sort: 'created_asc' });
    const mine = page.ok ? page.value.items.filter((e) => e.attemptId === a!.id) : [];
    expect(mine.map((e) => [e.type, e.bucket])).toEqual([['reserve', 'reserved'], ['move_to_unknown', 'reserved'], ['move_to_unknown', 'unknown'], ['resolve_unknown', 'unknown'], ['settle', 'settled']]);
    expect(mine.find((e) => e.type === 'resolve_unknown')?.deltaMicrousd).toBe(0 - N);
    expect(mine.find((e) => e.type === 'settle')?.certainty).toBe('calculated');
    expect(h.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: 0 }));
    expect(h.calls({ runId, stepKey: 'implement' })).toHaveLength(1); // no new call
    expect((await h.waitFor(runId, (r) => !['queued', 'running'].includes(r.status))).status).toBe('completed');
    expect(h.calls({ runId, stepKey: 'implement' })).toHaveLength(1);
    expectNoNegativeReserved(h.db);
    expectLedgerMatchesAttempts(h.db, runId);
  });

  it('failed without usage → resolve_unknown −N + settle 0 (calculated) @m3', async () => {
    const { h, runId } = await unknownThenRestart({ scenario: scenarioWith(['failed']), fakeCapabilityOverrides: LOOKUP });
    const [a] = h.attempts(runId, 'implement');

    await h.waitUntil(() => h.db.repos.attempts.get(a!.id).state !== 'unknown', 10_000, 'reconciled');

    expect(h.db.repos.attempts.get(a!.id).state).toBe('reconciled_failed');
    const page = h.db.repos.ledger.list(runId, { limit: 200, sort: 'created_asc' });
    const mine = page.ok ? page.value.items.filter((e) => e.attemptId === a!.id) : [];
    expect(mine.slice(-2).map((e) => [e.type, e.deltaMicrousd, e.certainty])).toEqual([['resolve_unknown', 0 - a!.reservationMicrousd, null], ['settle', 0, 'calculated']]);
    expect(h.db.repos.ledger.attemptBalances(a!.id)).toEqual({ reserved: 0, unknown: 0, settled: 0 });
    expect(h.calls({ runId, stepKey: 'implement' })).toHaveLength(1);
  });

  it('not_found → the attempt stays unknown (liability kept, no new call) @m3', async () => {
    const { h, runId } = await unknownThenRestart({ scenario: scenarioWith(['not_found']), fakeCapabilityOverrides: LOOKUP });
    const [a] = h.attempts(runId, 'implement');

    await h.waitUntil(() => h.callLog.reconcileEntries().length === 1, 10_000, 'reconcile attempted');
    await new Promise((r) => setTimeout(r, 100));

    expect(h.db.repos.attempts.get(a!.id).state).toBe('unknown');
    expect(h.db.repos.ledger.attemptBalances(a!.id).unknown).toBe(a!.reservationMicrousd);
    expect(h.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'unknown_outcome' }));
    expect(h.calls({ runId, stepKey: 'implement' })).toHaveLength(1);
  });
});
