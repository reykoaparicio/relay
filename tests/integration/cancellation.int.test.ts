// 11 §K5 / §17.1 "Cancel during request" (@m3): hang → runs.cancel → abort → cancelled; remaining steps skipped;
// the attempt ends unknown (never left dispatching) with the liability retained (R = 0, U = N); no call after cancel.
import { afterEach, describe, expect, it } from 'vitest';
import { expectLedgerMatchesAttempts, expectNoNegativeReserved } from '../helpers/assert-ledger.js';
import { createHarness, sleep } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

describe('cancellation @m3', () => {
  it('hang → cancel → cancelled, open steps skipped, attempt unknown with R = 0 and U = N, unresolvedCharges returned, call log frozen @m3', async () => {
    h = await createHarness({ scenario: 'hang' });
    const runId = await h.startRun();
    await h.waitUntil(() => h!.calls({ runId, stepKey: 'review' }).length === 1, 10_000, 'review in flight');
    await h.waitUntil(() => h!.attempts(runId, 'review')[0]?.state === 'dispatching', 10_000, 'attempt dispatching');

    const res = await h.call('relay/v1/runs.cancel', { runId });
    const run = await h.waitFor(runId, 'cancelled');

    expect(res.ok && ['cancelling', 'cancelled']).toContain(res.ok ? res.data.status : null);
    const [a, ...rest] = h.attempts(runId, 'review');
    expect(rest).toEqual([]);
    expect(a?.state).toBe('unknown');
    const N = a!.reservationMicrousd;
    expect(h.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: N }));
    const detail = await h.call('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.unresolvedAttempts.map((x) => x.id)).toEqual([a!.id]);
    if (res.ok && res.data.status === 'cancelled') expect(res.data.unresolvedCharges).toEqual([{ attemptId: a!.id, liabilityMicrousd: N }]);
    else {
      const again = await h.call('relay/v1/runs.cancel', { runId });
      expect(again.ok ? again.data.unresolvedCharges : again.error.code).toEqual(expect.anything());
    }
    for (const k of ['plan', 'approve', 'implement', 'verify']) {
      expect(h.steps(runId, k).at(-1)?.state, k).toBe('skipped');
    }
    expect(run.endedAt).not.toBeNull();
    const frozen = h.calls().length;
    await sleep(200);
    expect(h.calls()).toHaveLength(frozen); // no further calls after cancel
    expect(frozen).toBe(1);
    expectNoNegativeReserved(h.db);
    expectLedgerMatchesAttempts(h.db, runId);
  });
});
