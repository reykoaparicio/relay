import { test, expect } from '../fixtures.js';
import { setupOwnProject, startRunViaNewRun } from '../flows.js';
import { Runs } from '../pages/app-pages.js';
import { Report } from '../pages/report.js';
import { RunInspector } from '../pages/run-inspector.js';
import { Shell } from '../pages/shell.js';

const GOAL = 'Reject invalid request values consistently in the user handler.';
const GOAL_REJECT = 'Tighten validation of the age field.';

// revise-then-accept: the workflow reviewer (verify) asks for one revision, then accepts (04 §D7).
test.use({ scenario: 'revise-then-accept' });

test.describe('approval controls', { tag: '@m2' }, () => {
  test('revision needs a note and re-runs the planner; approve completes; reject cancels', async ({
    page,
    stubDialogs,
    project,
    callLog,
  }) => {
    await setupOwnProject(page, stubDialogs, project);
    await startRunViaNewRun(page, GOAL);
    const inspector = new RunInspector(page);
    await inspector.expectAwaitingApproval();

    // FR-08: a revision request without a note cannot be sent.
    const send = await inspector.openRevision();
    await expect(send).toBeDisabled();
    await inspector.revisionNote().fill('   ');
    await expect(send).toBeDisabled();
    await expect(inspector.approvalCard()).toContainText(/This is revision cycle 1 of \d+\./);

    // With a note: the planner re-runs (call log plan ×2) and a new approval is requested.
    await inspector.revisionNote().fill('Keep the existing 400 response body shape; only add the id check.');
    await send.click();
    await expect
      .poll(async () => (await callLog()).filter((c) => c.stepKey === 'plan').length, { timeout: 30_000 })
      .toBe(2);
    await inspector.expectAwaitingApproval();
    await expect(inspector.timelineStep('Plan a fix').last()).toContainText('revision 2');
    expect((await callLog()).filter((c) => c.stepKey === 'review')).toHaveLength(1);

    await inspector.approve();
    await inspector.waitForStatus('Completed', 45_000);
    await expect(inspector.verdictNote()).toBeVisible();
    const calls = await callLog();
    expect(calls.filter((c) => c.stepKey === 'plan')).toHaveLength(2);
    // revise-then-accept: the reviewer's revise verdict repeats implement + verify once.
    expect(calls.filter((c) => c.stepKey === 'implement')).toHaveLength(2);
    expect(calls.filter((c) => c.stepKey === 'verify')).toHaveLength(2);

    // Report (report.v1 approvals / revisions, 06 F17): the sent-back plan with its note, then the approved one;
    // one plan revision and one quality revision cycle.
    await inspector.viewReportLink().click();
    const report = new Report(page);
    await report.expectLoaded();
    await expect(report.approvals()).toHaveCount(2);
    await expect(report.approvals().nth(0)).toContainText('Approve plan: revision requested');
    await expect(report.approvals().nth(0)).toContainText(
      'Note: Keep the existing 400 response body shape; only add the id check.',
    );
    await expect(report.approvals().nth(1)).toContainText('Approve plan: approved');
    await expect(report.approvals().nth(1)).not.toContainText('invalidated:');
    await expect(report.revisionsValue('Plan revisions')).toHaveText('1');
    await expect(report.revisionsValue('Revision cycles')).toHaveText(/^1 of \d+$/);

    // Reject path on a new run → Cancelled; nothing after the approval runs.
    const rejectRunId = await startRunViaNewRun(page, GOAL_REJECT);
    await inspector.expectAwaitingApproval();
    const before = (await callLog()).length;
    await inspector.reject();
    await inspector.waitForStatus('Cancelled');
    await expect(inspector.timelineStep('Produce patch')).toContainText('Skipped');
    expect((await callLog()).filter((c) => c.runId === rejectRunId).map((c) => c.stepKey)).toEqual([
      'review',
      'plan',
    ]);
    expect(await callLog()).toHaveLength(before);
    await inspector.viewReportLink().click();
    await report.expectLoaded();
    await expect(report.approvals()).toHaveCount(1);
    await expect(report.approvals().first()).toContainText('Approve plan: rejected');

    await new Shell(page).nav('Runs');
    const runs = new Runs(page);
    await runs.expectLoaded();
    await expect(runs.statusCell(runs.row(GOAL_REJECT))).toContainText('Cancelled');
    await expect(runs.statusCell(runs.row(GOAL))).toContainText('Completed');
  });
});
