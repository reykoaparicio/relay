import { afterEach, describe, expect, it } from 'vitest';
import { REPORT_LIMITATIONS } from '@relay/templates';
import { err, errors, reportV1Schema } from '@relay/contracts';
import type { RunId } from '@relay/contracts';
import { fromUtf8 } from './hash.js';
import type { EngineCtx } from './ports.js';
import { generateReport, regenerateMissingReports } from './report.js';
import type { PostCommitEffect } from './run-machine.js';
import { applyRunEvent, runEffects } from './run-machine.js';
import { tick } from './runner.js';
import { driveThroughApproval } from './testing/drive.js';
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

  it('a failed run (UNRECOVERABLE) gets a failed report: no verdict, run_failed limitation, approvals and revisions recorded', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    await tick(h.ctx); // CHECKS_PASSED → running
    const fx: PostCommitEffect[] = [];
    h.db.tx('immediate', (r) => applyRunEvent(r, r.runs.get(runId), { type: 'UNRECOVERABLE', error: errors.internal('cor_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as never) }, h!.clock.now(), fx));
    await runEffects(h.ctx, fx); // the terminal effect generates the report

    const report = await readReport(h, runId);

    expect(report.status).toBe('failed');
    expect(report.verdict).toBeNull();
    expect(report.limitations).toContain(REPORT_LIMITATIONS.run_failed);
    expect(report.limitations).not.toContain(REPORT_LIMITATIONS.model_checks_only);
    expect(report.approvals).toEqual([]);
    expect(report.revisions).toEqual({ cycles: 0, maxCycles: 2, planRevisions: 0, incompleteCause: null });
    expect(Object.values(report.artifacts)).toEqual([null, null, null, null]);
  });

  it('records each approval decision (incl. a requested revision with its note) and the quality revision cycles', async () => {
    h = await createHarness({ scenario: 'revise-until-limit' });
    const runId = await h.startRun();
    await driveThroughApproval(h, runId, ['awaiting_approval']); // first plan
    const first = await h.engine.handle('relay/v1/runs.get', { runId });
    const a = first.ok ? first.data.pendingApproval : null;
    await h.engine.handle('relay/v1/approvals.decide', { idempotencyKey: 'report-revise-0001', approvalId: a?.id ?? '', planHash: a?.planHash ?? '',
      contextHash: a?.contextHash ?? '', decision: 'revision_requested', note: 'Keep the | public fields.\nNo renames.' });
    await driveThroughApproval(h, runId, ['incomplete']); // re-plan, approve, implement/verify revise ×3 → limit

    const report = await readReport(h, runId);

    expect(report.status).toBe('incomplete');
    expect(report.approvals?.map((x) => [x.stepKey, x.decision, x.note])).toEqual([
      ['approve', 'revision_requested', 'Keep the | public fields.\nNo renames.'],
      ['approve', 'approved', null],
    ]);
    expect(report.revisions).toEqual({ cycles: 2, maxCycles: 2, planRevisions: 1, incompleteCause: 'revision_limit' });
  });

  it('engine.start() regenerates a missing report (terminal commit, post-commit effect lost) exactly once, across restarts', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    // A crash right after the terminal commit: the transition commits but its post-commit effects (the report) never run.
    h.db.tx('immediate', (r) => applyRunEvent(r, r.runs.get(runId), { type: 'CANCEL_REQUESTED' }, h!.clock.now(), []));
    expect(h.db.repos.runs.get(runId).status).toBe('cancelled');
    expect(h.db.repos.artifacts.listForRun(runId, ['report'])).toEqual([]);
    expect(h.db.repos.runs.listTerminalWithoutReport().map((r) => r.id)).toEqual([runId]);

    await h.engine.start();
    await h.engine.stop({ graceMs: 10 });
    await h.engine.start(); // restart: nothing left to regenerate
    const again = await regenerateMissingReports(h.ctx);

    expect(h.db.repos.artifacts.listForRun(runId, ['report'])).toHaveLength(1);
    expect(again).toEqual([]);
    expect(h.db.repos.events.list(runId, 0, 100).filter((e) => e.type === 'report.created')).toHaveLength(1);
    expect((await readReport(h, runId)).status).toBe('cancelled');
  });

  it('two concurrent generations keep exactly one report row', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    h.db.tx('immediate', (r) => applyRunEvent(r, r.runs.get(runId), { type: 'CANCEL_REQUESTED' }, h!.clock.now(), []));

    const [a, b] = await Promise.all([generateReport(h.ctx, runId), generateReport(h.ctx, runId)]);

    expect(a.ok && b.ok && a.value === b.value).toBe(true);
    expect(h.db.repos.artifacts.listForRun(runId, ['report'])).toHaveLength(1);
  });

  it('a failed report put is logged (report.failed), leaves no row, and the report is written at the next start', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    const base = h.ctx.artifacts;
    (h.ctx as { artifacts: EngineCtx['artifacts'] }).artifacts = { ...base, put: () => Promise.resolve(err(errors.artifactWriteFailed())) };

    await h.engine.handle('relay/v1/runs.cancel', { runId }); // queued → cancelled → terminal effect → put fails

    expect(h.db.repos.runs.get(runId).status).toBe('cancelled');
    expect(h.db.repos.artifacts.listForRun(runId, ['report'])).toEqual([]);
    expect(h.logger.entries.some((e) => e.event === 'report.failed' && e.fields?.['code'] === 'ARTIFACT_WRITE_FAILED')).toBe(true);
    (h.ctx as { artifacts: EngineCtx['artifacts'] }).artifacts = base;
    await h.engine.start();
    expect(h.db.repos.artifacts.listForRun(runId, ['report'])).toHaveLength(1);
  });
});
