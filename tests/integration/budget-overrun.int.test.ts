// 11 §K5 / §17.1 "Provider usage exceeds reservation" (@m3): the settled amount is the actual cost (> N, never capped);
// the run pauses budget_overrun REGARDLESS of L and makes no further call; acknowledge_overrun resumes to completion.
import { afterEach, describe, expect, it } from 'vitest';
import { computeCost } from '@relay/contracts';
import { expectLedgerMatchesAttempts, expectNoNegativeReserved } from '../helpers/assert-ledger.js';
import { createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

describe('budget overrun @m3', () => {
  it('overrun with L = $3.00 well above X: settle = actual > N (not capped), costSummary.overrun, paused(budget_overrun), no further call; acknowledge_overrun → completes @m3', async () => {
    h = await createHarness({ scenario: 'overrun' });
    const runId = await h.startRun({ limits: { budgetMicrousd: 3_000_000 } });

    const paused = await h.waitFor(runId, (r) => r.status !== 'queued' && r.status !== 'running');

    expect([paused.status, paused.pauseReason]).toEqual(['paused', 'budget_overrun']);
    const [a] = h.attempts(runId, 'review');
    const N = a!.reservationMicrousd;
    const X = computeCost(a!.usage!, a!.profileSnapshot.prices).microusd;
    expect(X).toBeGreaterThan(N);
    expect(X).toBeLessThan(3_000_000); // L well above X: the pause is not an allowance pause
    expect(h.db.repos.ledger.attemptBalances(a!.id)).toEqual({ reserved: 0, unknown: 0, settled: X }); // actual, never capped
    const callsAtPause = h.calls({ runId }).length;
    expect(callsAtPause).toBe(1);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.calls({ runId })).toHaveLength(callsAtPause); // no further call while paused

    const ack = await h.resume(runId, { kind: 'acknowledge_overrun' });
    expect(ack.ok && ack.data.status).toBe('queued'); // RESUME_RESOLVED
    await h.waitFor(runId, 'awaiting_approval');
    await h.approve(runId);
    expect((await h.waitFor(runId, ['completed', 'paused', 'failed', 'incomplete'])).status).toBe('completed');
    expectNoNegativeReserved(h.db);
    expectLedgerMatchesAttempts(h.db, runId);
  });

  // PRODUCT BUG (reported): views.ts computes costSummary.overrun as `remaining < 0` (C+R+U > L), so an attempt overrun
  // X > N with L ≫ X reports overrun=false. 11 §K5 requires `costSummary.overrun = true` for this row.
  it('costSummary.overrun is true after an attempt overrun even when L ≫ X @m3', async () => {
    h = await createHarness({ scenario: 'overrun' });
    const runId = await h.startRun({ limits: { budgetMicrousd: 3_000_000 } });
    await h.waitFor(runId, 'paused');

    const summary = await h.call('relay/v1/ledger.runSummary', { runId });
    const detail = await h.call('relay/v1/runs.get', { runId });

    expect(summary.ok && summary.data.overrun).toBe(true);
    expect(detail.ok && detail.data.cost.overrun).toBe(true);
  });
});
