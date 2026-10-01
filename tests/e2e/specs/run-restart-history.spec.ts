import type { Locator } from '@playwright/test';
import { test, expect } from '../fixtures.js';
import { setupOwnProject, startRunViaNewRun } from '../flows.js';
import { Overview, RunInspector, Runs } from '../pages/app-pages.js';
import { Shell } from '../pages/shell.js';

const GOAL = 'Validate the user id parameter in the user handler.';
const AWAITING = 'Awaiting your approval';

/** "$1.23" (+ certainty) of a cost cell, whitespace-normalised. */
async function costText(cell: Locator): Promise<string> {
  return ((await cell.textContent()) ?? '').replace(/\s+/g, ' ').trim();
}

// 12 §L4 exit gate "run appears in history after restart": the run is listed at its approval checkpoint, then
// approved to Completed, and after a relaunch it is still listed as Completed with the same tracked cost, with nothing
// re-executed.
test.describe('run history across restart', { tag: '@m1' }, () => {
  test('a completed run is listed with its status and cost after relaunch', async ({
    page,
    stubDialogs,
    project,
    relaunch,
    callLog,
  }) => {
    await setupOwnProject(page, stubDialogs, project);
    const runId = await startRunViaNewRun(page, GOAL);
    const inspector = new RunInspector(page);
    await inspector.expectLoaded();

    // Approval checkpoint in the history: review + plan done, a non-zero settled cost.
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
    const costAtApproval = runs.costCell(row);
    await expect(costAtApproval).toContainText(/\$\d+\.\d{2}/);
    await expect(costAtApproval).not.toHaveText(/^\$0\.00/);

    // Approve → Completed (implement + verify run).
    await row.getByRole('link').first().click();
    await inspector.expectLoaded();
    await inspector.approve();
    await inspector.waitForStatus('Completed', 45_000);

    await shell.nav('Runs');
    await runs.expectLoaded();
    await expect(runs.statusCell(row)).toContainText('Completed');
    const costCell = runs.costCell(row);
    await expect(costCell).toContainText(/\$\d+\.\d{2}/);
    await expect(costCell).not.toHaveText(/^\$0\.00/);
    const costBefore = await costText(costCell);

    const callsBefore = await callLog();
    expect(new Set(callsBefore.map((c) => c.stepKey))).toEqual(new Set(['review', 'plan', 'implement', 'verify']));

    // Relaunch on the same userData.
    const page2 = await relaunch();
    const overview2 = new Overview(page2);
    await overview2.expectLoaded();

    const shell2 = new Shell(page2);
    await shell2.nav('Runs');
    const runs2 = new Runs(page2);
    await runs2.expectLoaded();
    const row2 = runs2.row(GOAL);
    await expect(row2).toHaveCount(1);
    await expect(row2).toContainText(`Run ${runId.slice(-4)}`);
    await expect(runs2.statusCell(row2)).toContainText('Completed');
    await expect(runs2.costCell(row2)).toHaveText(costBefore);
    await expect(shell2.runsBadgeCount()).toHaveCount(0);

    // Nothing was re-executed on relaunch (the call log is the source of truth, 12 §L6).
    expect(await callLog()).toHaveLength(callsBefore.length);
  });
});
