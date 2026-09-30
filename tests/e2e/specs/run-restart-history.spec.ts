import { test, expect } from '../fixtures.js';
import { setupOwnProject, startRunViaNewRun } from '../flows.js';
import { Overview, RunInspector, Runs } from '../pages/app-pages.js';
import { Shell } from '../pages/shell.js';

const GOAL = 'Validate the user id parameter in the user handler.';
const AWAITING = 'Awaiting your approval';

// M1 variant of the exit gate "run appears in history after restart": approval UI lands in Wave 2, so the run is
// taken to its approval checkpoint (review + plan done) rather than to Completed.
test.describe('run history across restart', { tag: '@m1' }, () => {
  test('a run awaiting approval is listed with its status and cost after relaunch', async ({
    page,
    stubDialogs,
    project,
    relaunch,
    callLog,
  }) => {
    await setupOwnProject(page, stubDialogs, project);
    const runId = await startRunViaNewRun(page, GOAL);
    await new RunInspector(page).expectLoaded();

    const shell = new Shell(page);
    await shell.nav('Runs');
    const runs = new Runs(page);
    await runs.expectLoaded();
    await runs.expectColumns();
    const row = runs.row(GOAL);
    await expect(row).toHaveCount(1);
    await expect(runs.statusCell(row)).toContainText(AWAITING, { timeout: 30_000 });
    await expect(row).toContainText(`Run ${runId.slice(-4)}`);
    await expect(shell.runsBadgeCount()).toHaveText('1 waiting for approval');

    // The tracked cost is settled for review + plan (non-zero, labelled).
    const costCell = runs.costCell(row);
    await expect(costCell).toContainText(/\$\d+\.\d{2}/);
    await expect(costCell).not.toHaveText(/^\$0\.00/);
    const costBefore = ((await costCell.textContent()) ?? '').replace(/\s+/g, ' ').trim();

    await shell.nav('Overview');
    const overview = new Overview(page);
    await overview.expectLoaded();
    await expect(overview.summary()).toContainText('Waiting for your approval');

    const callsBefore = await callLog();
    expect(callsBefore.filter((c) => c.stepKey === 'review')).toHaveLength(1);
    expect(callsBefore.filter((c) => c.stepKey === 'plan')).toHaveLength(1);

    // Relaunch on the same userData.
    const page2 = await relaunch();
    const overview2 = new Overview(page2);
    await overview2.expectLoaded();
    await expect(overview2.summary()).toContainText('Waiting for your approval');

    const shell2 = new Shell(page2);
    await shell2.nav('Runs');
    const runs2 = new Runs(page2);
    await runs2.expectLoaded();
    const row2 = runs2.row(GOAL);
    await expect(row2).toHaveCount(1);
    await expect(row2).toContainText(`Run ${runId.slice(-4)}`);
    await expect(runs2.statusCell(row2)).toContainText(AWAITING);
    await expect(runs2.costCell(row2)).toHaveText(costBefore);
    await expect(shell2.runsBadgeCount()).toHaveText('1 waiting for approval');

    // Nothing was re-executed on relaunch (the call log is the source of truth, 12 §L6).
    expect(await callLog()).toHaveLength(callsBefore.length);
  });
});
