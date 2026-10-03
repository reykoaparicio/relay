// Decision 2: Pause and Export while a run is in progress.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '../fixtures.js';
import { FAKE_ANTHROPIC_KEY, setupOwnProject, startRunViaNewRun } from '../flows.js';
import { RunInspector } from '../pages/run-inspector.js';
import { makeTempDir, safeRemove } from '../safe-remove.js';

const GOAL = 'Validate the user id parameter in the user handler.';

test.describe('pause while running', { tag: '@m4' }, () => {
  // slow-review: the review call takes 5 s, so the pause is requested while a request is in flight.
  test.use({ scenario: 'slow-review' });

  test('Pause during the in-flight request takes effect after it; Resume continues and the run completes', async ({
    page,
    stubDialogs,
    project,
    callLog,
  }) => {
    await setupOwnProject(page, stubDialogs, project);
    await startRunViaNewRun(page, GOAL);
    const inspector = new RunInspector(page);
    await inspector.waitForStatus('Running');
    await expect.poll(async () => (await callLog()).map((c) => c.stepKey)).toEqual(['review']);

    await inspector.pause();
    // The request in flight finishes first: "Pausing after the current request…" until the status changes.
    await expect(inspector.banner()).toContainText('Pausing after the current request…');
    await inspector.waitForStatus('Paused by you');
    await expect(inspector.banner()).toContainText(/Paused by you — resumes from .+; nothing is lost/);
    await inspector.expectActions(['Resume', 'Stop run']);
    // The in-flight review finished and was kept; nothing new started while paused.
    expect((await callLog()).map((c) => c.stepKey)).toEqual(['review']);
    await expect(inspector.timelineStep('Review input')).toContainText('Done');

    await inspector.bannerAction('Resume').click();
    await inspector.expectAwaitingApproval();
    await inspector.approve();
    await inspector.waitForStatus('Completed');
    // Resumed exactly where it stopped: the review was not sent again.
    expect((await callLog()).filter((c) => c.stepKey === 'review')).toHaveLength(1);
  });
});

test.describe('export while in progress', { tag: '@m4' }, () => {
  test.use({ scenario: 'happy-path' });

  test('Export… while awaiting approval writes an interim report', async ({ page, stubDialogs, project }) => {
    await setupOwnProject(page, stubDialogs, project);
    await startRunViaNewRun(page, GOAL);
    const inspector = new RunInspector(page);
    await inspector.expectAwaitingApproval();
    // Pause is offered while awaiting approval too.
    await expect(inspector.headerAction('Pause')).toBeVisible();

    const exportDir = await makeTempDir('export-interim-');
    try {
      await stubDialogs({ exportDir });
      const dialog = await inspector.openInterimExport();
      await expect(dialog.getByTestId('export-progress-note')).toHaveText(
        /^The run is still in progress; the export includes results finished so far \(\d+ of \d+ steps\)\.$/,
      );
      await dialog.getByRole('button', { name: 'Export', exact: true }).click();
      await expect(page.getByText('Export saved')).toBeVisible();
      await expect.poll(async () => (await readdir(exportDir)).filter((f) => f.endsWith('.md')).length).toBe(1);
      const md = (await readdir(exportDir)).find((f) => f.endsWith('.md')) ?? '';
      const body = await readFile(path.join(exportDir, md), 'utf8');
      expect(body).toContain('In progress — exported');
      expect(body).not.toContain(FAKE_ANTHROPIC_KEY);
    } finally {
      await safeRemove(exportDir);
    }
    // The run is unchanged by the export.
    await inspector.waitForStatus('Awaiting your approval');
  });
});
