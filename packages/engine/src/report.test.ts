import { afterEach, describe, expect, it } from 'vitest';
import { REPORT_LIMITATIONS } from '@relay/templates';
import { reportV1Schema } from '@relay/contracts';
import type { RunId } from '@relay/contracts';
import { fromUtf8 } from './hash.js';
import { generateReport } from './report.js';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function readReport(harness: Harness, runId: RunId) {
  await harness.waitFor(() => harness.db.repos.artifacts.listForRun(runId, ['report']).length === 1);
  const row = harness.db.repos.artifacts.listForRun(runId, ['report'])[0];
  const bytes = await harness.ctx.artifacts.read(row?.relPath ?? '', 1_000_000);
  if (!bytes.ok) throw new Error('read');
  return reportV1Schema.parse(JSON.parse(fromUtf8(bytes.value)));
}

describe('report (F17 Wave-1)', () => {
  it('builds report.v1 for a completed run with verdict, artifacts, totals, and limitations', async () => {
    h = await createHarness();
    await h.engine.start();
    const runId = await h.startRun();
    await h.waitForStatus(runId, ['awaiting_approval']);
    const d = await h.engine.handle('relay/v1/runs.get', { runId });
    const a = d.ok ? d.data.pendingApproval : null;
    await h.engine.handle('relay/v1/approvals.decide', { idempotencyKey: 'approve-key-000003', approvalId: a?.id ?? '', planHash: a?.planHash ?? '', contextHash: a?.contextHash ?? '', decision: 'approved' });
    await h.waitForStatus(runId, ['completed']);

    const report = await readReport(h, runId);

    expect(report).toEqual(expect.objectContaining({ status: 'completed', verdict: 'accept', runId, snapshotUsed: false, unknownLiabilities: [] }));
    expect(Object.values(report.artifacts).every((x) => x !== null)).toBe(true);
    expect(report.steps.map((s) => s.stepKey)).toEqual(['intake', 'review', 'plan', 'approve', 'implement', 'verify', 'finalize']);
    expect(report.steps.find((s) => s.stepKey === 'review')?.cost.settledMicrousd).toBeGreaterThan(0);
    expect(report.totals.settledCalculated).toBe(h.db.repos.ledger.runBalances(runId).C);
    expect(report.limitations).toEqual([REPORT_LIMITATIONS.patch_not_applied, REPORT_LIMITATIONS.tests_not_run, REPORT_LIMITATIONS.model_checks_only, REPORT_LIMITATIONS.cost_tracked]);
    const again = await generateReport(h.ctx, runId);
    expect(again.ok && again.value).toBe(h.db.repos.artifacts.listForRun(runId, ['report'])[0]?.id); // idempotent
  });

  it('reports a cancelled run with its unknown liability and the cancellation limitation; refuses non-terminal runs', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    const queued = await h.startRun();

    const notTerminal = await generateReport(h.ctx, queued);
    await h.engine.handle('relay/v1/runs.cancel', { runId });
    const report = await readReport(h, runId);

    expect(notTerminal.ok ? null : notTerminal.error.code).toBe('CONFLICT');
    expect(report.status).toBe('cancelled');
    expect(report.verdict).toBeNull();
    expect(report.limitations).toContain(REPORT_LIMITATIONS.run_cancelled);
    expect(report.steps.every((s) => s.state === 'skipped')).toBe(true);
  });
});
