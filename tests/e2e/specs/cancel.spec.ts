import { test, expect } from '../fixtures.js';
import { setupOwnProject, startRunViaNewRun } from '../flows.js';
import { RunInspector } from '../pages/run-inspector.js';

/** Decision 1: no visible wording says "unknown" (identifiers such as the error code REQUEST_OUTCOME_UNKNOWN aside). */
const NO_UNKNOWN = /(?<!\w)unknown/i;
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
    await expect(dialog).toContainText('if its exact cost is not reported, Relay counts an estimate');
    await expect(dialog).not.toContainText(NO_UNKNOWN);
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
    // Honest charge status (decision 1): the aborted request may have been charged → counted as an estimate > $0
    // ("~"), never "unknown"; nothing left reserved.
    await expect.poll(async () => inspector.ledgerAmount('Estimated')).toBeGreaterThan(0);
    await expect(await inspector.ledgerRow('Estimated')).toContainText(/~\$[\d.,]+ \(estimated\)/);
    await expect(page.getByRole('main')).not.toContainText(NO_UNKNOWN);
    await expect(await inspector.ledgerRow('Reserved (in flight)')).toHaveText(RunInspector.amountText('$0.00'));
    expect(await callLog()).toHaveLength(1);
  });
});
