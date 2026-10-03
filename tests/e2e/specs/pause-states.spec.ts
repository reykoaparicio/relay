import { test, expect } from '../fixtures.js';
import { setupOwnProject, startRunViaNewRun } from '../flows.js';
import { dollars, RunInspector } from '../pages/run-inspector.js';

const GOAL = 'Validate the user id parameter in the user handler.';

test.describe('pause states', { tag: '@m4' }, () => {
  test.describe('output invalid', () => {
    // malformed-twice: the review output and its schema repair are both invalid → paused(output_invalid).
    test.use({ scenario: 'malformed-twice' });

    test('Retry step after paused(output_invalid) → completes with a user_retry call', async ({
      page,
      stubDialogs,
      project,
      callLog,
    }) => {
      await setupOwnProject(page, stubDialogs, project);
      await startRunViaNewRun(page, GOAL);
      const inspector = new RunInspector(page);
      await inspector.waitForStatus("Paused: output didn't match schema");
      await expect(inspector.banner()).toContainText(/returned output in the wrong format/);
      await expect(inspector.banner()).toContainText(/repair attempts used: \d+ of \d+/);
      await inspector.expectActions(['Retry step', 'Choose another profile', 'Stop run']);
      expect((await callLog()).filter((c) => c.stepKey === 'review').map((c) => c.purpose)).toEqual([
        'initial',
        'schema_repair',
      ]);

      await inspector.retryStep();
      await inspector.expectAwaitingApproval();
      await inspector.approve();
      await inspector.waitForStatus('Completed');
      const review = (await callLog()).filter((c) => c.stepKey === 'review').map((c) => c.purpose);
      expect(review).toEqual(['initial', 'schema_repair', 'user_retry']);
    });
  });

  test.describe('budget overrun', () => {
    // overrun: the review reports far more output than its reservation (§9.5).
    test.use({ scenario: 'overrun' });

    test('paused(budget_overrun) shows actual > reserved → Acknowledge overrun → completes', async ({
      page,
      stubDialogs,
      project,
    }) => {
      await setupOwnProject(page, stubDialogs, project);
      await startRunViaNewRun(page, GOAL, { allowance: '$3.00' });
      const inspector = new RunInspector(page);
      await inspector.waitForStatus('Paused: cost exceeded reservation');
      const banner = inspector.banner();
      await expect(banner).toContainText(/The last call cost \$[\d.]+, more than the \$[\d.]+ reserved/);
      const reserved = dollars(await banner.getByRole('definition').nth(0).textContent());
      const actual = dollars(await banner.getByRole('definition').nth(1).textContent());
      expect(actual).toBeGreaterThan(reserved);
      await expect(banner.getByRole('term').nth(0)).toHaveText('Reserved');
      // The actual amount is labelled by its certainty, as in the Budget card (never a fixed "Reported by provider").
      await expect(banner.getByRole('term').nth(1)).toHaveText(/^(Reported by provider|Calculated from usage|Estimated)$/);

      await inspector.acknowledgeOverrun();
      await inspector.expectAwaitingApproval();
      await inspector.approve();
      await inspector.waitForStatus('Completed');
    });
  });

  test.describe('attempt limit', () => {
    test('paused(limit_attempts) → Raise limits (8, bounded by RUN_LIMIT_MAXIMUMS) → completes', async ({
      page,
      stubDialogs,
      project,
      callLog,
    }) => {
      await setupOwnProject(page, stubDialogs, project);
      await startRunViaNewRun(page, GOAL, { maxAttempts: 2 });
      const inspector = new RunInspector(page);
      await inspector.expectAwaitingApproval();
      await inspector.approve();
      await inspector.waitForStatus('Paused: attempt limit reached');
      await expect(inspector.banner()).toContainText('Attempt limit reached (2 of 2)');
      expect(await callLog()).toHaveLength(2);

      // The dialog enforces the upper bound (RUN_LIMIT_MAXIMUMS.maxAttempts = 50).
      await inspector.bannerAction('Raise limits').click();
      const dialog = page.getByRole('dialog', { name: 'Raise limits for this run' });
      await expect(dialog.getByLabel('Max attempts')).toHaveAttribute('max', '50');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();

      await inspector.raiseLimits({ maxAttempts: 8 });
      await inspector.waitForStatus('Completed');
      expect(await callLog()).toHaveLength(4);
    });
  });
});
