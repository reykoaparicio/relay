// 11 §K5 / §17.1 "Remaining allowance below new reservation" (@m3): admission blocks BEFORE any provider call;
// increaseAllowance auto-resumes (RESUME_RESOLVED) and the step dispatches.
import { afterEach, describe, expect, it } from 'vitest';
import { expectNoNegativeReserved } from '../helpers/assert-ledger.js';
import { DEFAULT_REL_PATHS, createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

describe('budget admission @m3', () => {
  it('L below N(review) → no provider call, paused(budget_run) with BUDGET_BLOCKED {L,C,R,U,N}; increaseAllowance → auto resume → dispatch @m3', async () => {
    h = await createHarness({ scenario: 'happy-path' });
    const pre = await h.call('relay/v1/runs.preflight', {
      projectId: h.projectId, workflowId: h.workflowId, workflowVersion: 1, goal: 'Fix the defects in the handlers.',
      input: { kind: 'files', relPaths: [...DEFAULT_REL_PATHS] },
    });
    if (!pre.ok) throw new Error(pre.error.code);
    const N = pre.data.firstReservation.N;
    expect(N).toBeGreaterThan(0);
    const L = Math.floor((N * 2) / 3); // "$0.10 vs N = $0.15"

    const runId = await h.startRun({ limits: { budgetMicrousd: L } });
    const run = await h.waitFor(runId, (r) => r.status === 'paused' || r.status === 'awaiting_approval' || r.status === 'completed');

    expect([run.status, run.pauseReason]).toEqual(['paused', 'budget_run']);
    expect(h.calls({ runId })).toHaveLength(0); // no provider call
    expect(h.db.repos.attempts.listForRun(runId).filter((a) => a.state !== 'failed_before_dispatch')).toEqual([]);
    expect(run.statusDetail?.code).toBe('BUDGET_BLOCKED');
    expect(run.statusDetail?.details).toEqual(expect.objectContaining({ L, C: 0, R: 0, U: 0, N: expect.any(Number) as number, scope: 'run', allowed: false }));
    expect(Number(run.statusDetail?.details?.['N'])).toBeGreaterThan(L);
    expect(h.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ L, C: 0, R: 0, U: 0 }));

    const raised = await h.call('relay/v1/runs.increaseAllowance', { idempotencyKey: 'raise-allowance-0001', runId, newAllowanceMicrousd: 500_000 });

    expect(raised.ok && raised.data.status).toBe('queued'); // RESUME_RESOLVED
    await h.waitUntil(() => h!.calls({ runId, stepKey: 'review' }).length === 1, 10_000, 'review dispatched');
    await h.waitFor(runId, (r) => r.status !== 'queued' && r.status !== 'running');
    expect(h.attempts(runId, 'review').map((a) => a.state)).toContain('succeeded');
    const entries = h.db.repos.ledger.list(runId, { limit: 200, sort: 'created_asc' });
    expect(entries.ok && entries.value.items.filter((e) => e.type === 'allowance_change').map((e) => e.deltaMicrousd)).toEqual([500_000 - L]);
    expectNoNegativeReserved(h.db);
  });
});
