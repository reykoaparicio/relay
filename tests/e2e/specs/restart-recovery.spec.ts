import { test, expect } from '../fixtures.js';
import { setupOwnProject, startRunViaNewRun } from '../flows.js';
import { Overview } from '../pages/app-pages.js';
import { RunInspector } from '../pages/run-inspector.js';
import { Shell } from '../pages/shell.js';

const GOAL = 'Validate the user id parameter in the user handler.';

// The runner process dies right after the plan step commits (06 crash grammar `<hook>@<stepKey>`).
test.use({ crashAt: 'afterStepCommit@plan' });

test.describe('restart recovery', { tag: '@m3' }, () => {
  test('a run interrupted after the plan commit resumes from its checkpoint without re-running steps', async ({
    page,
    stubDialogs,
    project,
    relaunch,
    callLog,
  }, testInfo) => {
    await setupOwnProject(page, stubDialogs, project);
    const runId = await startRunViaNewRun(page, GOAL);

    // The plan call happened and committed, then the runner died.
    await expect
      .poll(async () => (await callLog()).map((c) => c.stepKey), { timeout: 30_000 })
      .toEqual(['review', 'plan']);
    const inspector = new RunInspector(page);
    // The supervisor restarts the runner; the run is then marked Interrupted (never resumed on its own).
    await inspector.waitForStatus('Interrupted', 45_000);
    testInfo.annotations.push({
      type: 'first-launch',
      description: 'runner crashed after plan commit; run shown Interrupted',
    });

    // Relaunch the app without the crash hook (relaunch() launches without RELAY_CRASH_AT).
    const page2 = await relaunch();
    const overview = new Overview(page2);
    await overview.expectLoaded();
    const banner = page2.getByRole('main').getByText(`Run ${runId.slice(-4)} was interrupted`);
    await expect(banner).toBeVisible();
    await expect(page2.getByRole('main')).toContainText(/The last completed step is\s*Plan\b/);

    await page2.getByRole('main').getByRole('link', { name: 'Review recovery options' }).first().click();
    const inspector2 = new RunInspector(page2);
    await inspector2.expectLoaded();
    await inspector2.waitForStatus('Interrupted');
    const recovery = inspector2.recoveryPanel();
    await expect(recovery).toContainText(/Last completed step:\s*Plan/);
    await recovery.getByRole('button', { name: 'Continue from last checkpoint' }).click();

    await inspector2.expectAwaitingApproval();
    await expect(inspector2.timelineStep('Plan a fix')).toHaveCount(1);
    const calls = await callLog();
    expect(calls.filter((c) => c.stepKey === 'review')).toHaveLength(1);
    expect(calls.filter((c) => c.stepKey === 'plan')).toHaveLength(1);
    await expect(new Shell(page2).runnerBanner()).toBeHidden();
  });
});
