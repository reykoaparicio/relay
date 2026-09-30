import { test, expect } from '../fixtures.js';
import { setupOwnProject, startRunViaNewRun } from '../flows.js';
import { RunInspector } from '../pages/run-inspector.js';

const GOAL = 'Validate the user id parameter in the user handler.';

// hang: the review request never answers until it is aborted (04 §D7).
test.use({ scenario: 'hang' });

test.describe('cancel', { tag: '@m4' }, () => {
  test('cancelling an in-flight request is best effort and keeps an honest charge status', async ({
    page,
    stubDialogs,
    project,
    callLog,
  }, testInfo) => {
    await setupOwnProject(page, stubDialogs, project);
    await startRunViaNewRun(page, GOAL);
    const inspector = new RunInspector(page);
    await inspector.waitForStatus('Running');
    await expect.poll(async () => (await callLog()).map((c) => c.stepKey)).toEqual(['review']);
    await expect(inspector.timelineStep('Review input')).toContainText('Running');

    // FR-11: the confirmation explains that stopping the in-flight request is best effort.
    const dialog = await inspector.openCancel();
    await expect(dialog).toContainText('Stopping the in-flight request is best effort');
    await expect(dialog).toContainText('its charge may stay unknown');
    await dialog.getByRole('button', { name: 'Cancel run' }).click();

    // "Cancelling…" (best effort, may be brief) then "Cancelled".
    const seen: string[] = [];
    await expect
      .poll(
        async () => {
          const s = ((await inspector.status().textContent()) ?? '').trim();
          if (seen.at(-1) !== s) seen.push(s);
          return s;
        },
        { timeout: 30_000 },
      )
      .toContain('Cancelled');
    testInfo.annotations.push({ type: 'status-sequence', description: seen.join(' → ') });

    await expect(inspector.banner()).toContainText('Run cancelled');
    for (const step of ['Plan a fix', 'Produce patch', 'Review patch'] as const) {
      await expect(inspector.timelineStep(step)).toContainText('Skipped');
    }
    // Honest charge status: the aborted request may have been charged → Unknown > $0, nothing left reserved.
    await expect.poll(async () => inspector.ledgerAmount('Unknown liability')).toBeGreaterThan(0);
    await expect(await inspector.ledgerRow('Reserved (in flight)')).toHaveText('$0.00');
    expect(await callLog()).toHaveLength(1);
  });
});
