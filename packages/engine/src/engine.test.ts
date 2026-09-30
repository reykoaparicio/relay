import { afterEach, describe, expect, it } from 'vitest';
import { computeCost } from '@relay/providers';
import type { RunId } from '@relay/contracts';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function approvePending(harness: Harness, runId: RunId): Promise<void> {
  const detail = await harness.engine.handle('relay/v1/runs.get', { runId });
  if (!detail.ok || detail.data.pendingApproval === null) throw new Error('no pending approval');
  const a = detail.data.pendingApproval;
  const decided = await harness.engine.handle('relay/v1/approvals.decide', {
    idempotencyKey: 'approve-key-000001', approvalId: a.id, planHash: a.planHash, contextHash: a.contextHash, decision: 'approved',
  });
  expect(decided.ok).toBe(true);
}

describe('engine @m2-lite', () => {
  it('runs the full template on the fake happy path through approval to completed with 4 model attempts @m2-lite', async () => {
    h = await createHarness();
    await h.engine.start();
    const runId = await h.startRun();

    expect(await h.waitForStatus(runId, ['awaiting_approval'])).toBe('awaiting_approval');
    await approvePending(h, runId);
    expect(await h.waitForStatus(runId, ['completed'])).toBe('completed');

    const r = h.db.repos;
    const attempts = r.attempts.listForRun(runId);
    expect(attempts).toHaveLength(4);
    expect(attempts.every((a) => a.state === 'succeeded')).toBe(true);
    const steps = r.steps.latestPerStepKey(runId);
    expect(steps.map((s) => [s.stepKey, s.state])).toEqual([
      ['intake', 'succeeded'], ['review', 'succeeded'], ['plan', 'succeeded'], ['approve', 'succeeded'],
      ['implement', 'succeeded'], ['verify', 'succeeded'], ['finalize', 'succeeded'],
    ]);
    const expected = attempts.reduce((n, a) => {
      if (a.usage === null) throw new Error('usage missing');
      const u = a.usage;
      const usage = { uncachedInputTokens: u.uncachedInputTokens, cacheReadInputTokens: u.cacheReadInputTokens, cacheWriteInputTokens: u.cacheWriteInputTokens, outputTokens: u.outputTokens };
      return n + computeCost(usage, a.profileSnapshot.prices).microusd;
    }, 0);
    const balances = r.ledger.runBalances(runId);
    expect(balances.C).toBe(expected);
    expect(balances.R).toBe(0);
    expect(balances.U).toBe(0);
    expect(r.ledger.settledByCertainty(runId).calculated).toBe(expected);
    await h.waitFor(() => r.artifacts.listForRun(runId, ['report']).length === 1);
    expect(h.logger.entries.filter((e) => e.level === 'error')).toEqual([]);
    expect(r.runs.inputFiles(runId)).toHaveLength(3);

    const summary = await h.engine.handle('relay/v1/ledger.runSummary', { runId });
    expect(summary.ok && summary.data.settledCalculated).toBe(expected);
    const detail = await h.engine.handle('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.availableActions).toEqual(['export_report', 'export_patch']);
    expect(detail.ok && detail.data.reportArtifactId).not.toBeNull();
  });
});
