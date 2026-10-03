// E1 (audit 2) through the composed runtime with the free-running loop and the REAL monotonic clock: the budget-scope
// dead end resolved by the project allowance edit, an unknown charge settled on a stopped run, and whole-ms execution
// time from the real `performance.now()` segments.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

describe('E1 run actions (integration)', () => {
  it('budget_run whose next admission fails at the project scope → budget_project; the allowance edit resumes it', async () => {
    h = await createHarness({ monthlyAllowanceMicrousd: 10_000 });
    const runId = await h.startRun({ limits: { budgetMicrousd: 10_000 } });
    const paused = await h.waitFor(runId, 'paused');
    expect(paused.pauseReason).toBe('budget_run');

    const inc = await h.call('relay/v1/runs.increaseAllowance', { idempotencyKey: 'e1-int-incr-000001', runId, newAllowanceMicrousd: 5_000_000 });
    expect(inc.ok && [inc.data.status, inc.data.budget?.scope]).toEqual(['paused', 'project']);
    expect(h.db.repos.runs.get(runId).pauseReason).toBe('budget_project');
    const detail = await h.call('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.availableActions).toContain('edit_project_allowance');

    const p = h.db.repos.projects.get(h.projectId);
    const up = await h.call('relay/v1/projects.update', { projectId: h.projectId, expectedUpdatedAt: p.updatedAt, patch: { monthlyAllowanceMicrousd: 50_000_000 } });
    expect(up.ok).toBe(true);
    const run = await h.waitFor(runId, ['awaiting_approval', 'completed']);
    expect(run.status).toBe('awaiting_approval');
    // Real monotonic segments: execution time is whole ms (INTEGER column) and never negative.
    expect(Number.isSafeInteger(run.executionMsUsed) && run.executionMsUsed >= 0).toBe(true);
  });

  it('decision 1: a stopped run with an uncertain attempt holds no unknown charge; runs.decideUnknown is refused (nothing to decide)', async () => {
    h = await createHarness({ scenario: { name: 'u', steps: [{ match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'unknown_after_dispatch' } }] } });
    const runId = await h.startRun();
    await h.waitFor(runId, 'paused');
    const attempt = h.attempts(runId).find((a) => a.state === 'unknown');
    if (attempt === undefined) throw new Error('no unknown attempt');
    const stop = await h.call('relay/v1/runs.cancel', { runId });
    expect(stop.ok && stop.data.status).toBe('cancelled');

    expect(h.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: 0 }));
    const before = h.db.repos.ledger.runBalances(runId);

    const decided = await h.decideUnknown(runId, attempt.id, 'accept_estimated_charge', 'e1-int-decide-0001');
    const detail = await h.call('relay/v1/runs.get', { runId });

    expect(decided.ok ? null : [decided.error.code, decided.error.details?.['reason']]).toEqual(['CONFLICT', 'decision_not_applicable']);
    expect(detail.ok && [detail.data.status, detail.data.availableActions]).toEqual(['cancelled', ['export_report']]);
    expect(h.db.repos.ledger.runBalances(runId)).toEqual(before);
  });
});
