import { test, expect } from '../fixtures.js';
import { setupOwnProject, startRunViaNewRun } from '../flows.js';
import { Settings } from '../pages/app-pages.js';
import { RunInspector } from '../pages/run-inspector.js';

const GOAL = 'Validate the user id parameter in the user handler.';
const NEW_KEY = 'sk-ant-e2e-RECONNECT-QRSTUVWXYZ';

test.describe('failure states', { tag: '@m4' }, () => {
  test.describe('malformed then ok', () => {
    test.use({ scenario: 'malformed-then-ok' });

    test('a schema repair is visible in the Attempts tab (2 attempts, "Schema repair")', async ({
      page,
      stubDialogs,
      project,
      callLog,
    }) => {
      await setupOwnProject(page, stubDialogs, project);
      await startRunViaNewRun(page, GOAL);
      const inspector = new RunInspector(page);
      await inspector.expectAwaitingApproval();

      await inspector.selectStep('Review input');
      await expect(inspector.timelineStep('Review input')).toContainText('Done');
      const rows = await inspector.attemptRows();
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText('Review · Initial');
      await expect(rows.nth(1)).toContainText('Review · Schema repair');
      await expect(rows.nth(1)).toContainText('Succeeded');
      const review = (await callLog()).filter((c) => c.stepKey === 'review').map((c) => c.purpose);
      expect(review).toEqual(['initial', 'schema_repair']);
    });
  });

  test.describe('auth failure', () => {
    test.use({ scenario: 'auth-fail' });

    test('pauses with Reconnect, then resumes and completes after reconnecting', async ({
      page,
      stubDialogs,
      project,
      callLog,
    }) => {
      await setupOwnProject(page, stubDialogs, project);
      await startRunViaNewRun(page, GOAL);
      const inspector = new RunInspector(page);
      await inspector.waitForStatus('Paused: provider sign-in needed');
      const runUrl = page.url();
      await expect(inspector.banner()).toContainText('Anthropic rejected the stored credential');
      await expect(inspector.banner()).toContainText('never retried automatically');
      // Auth failures are never retried: exactly one review call.
      expect((await callLog()).map((c) => c.stepKey)).toEqual(['review']);

      // Reconnect provider → Settings → Providers → replace the key.
      await inspector.bannerAction('Reconnect provider').click();
      const settings = new Settings(page);
      await settings.expectLoaded();
      await settings.replaceKey('Anthropic', NEW_KEY);
      await expect(settings.providerKeyLabel('Anthropic')).toHaveText(`sk-…${NEW_KEY.slice(-4)}`);
      expect(await page.content()).not.toContain(NEW_KEY);

      // Back to the run → Resume → completes.
      await page.goto(runUrl);
      await inspector.waitForStatus('Paused: provider sign-in needed');
      await inspector.bannerAction('Resume').click();
      await inspector.expectAwaitingApproval();
      await inspector.approve();
      await inspector.waitForStatus('Completed');
      expect((await callLog()).filter((c) => c.stepKey === 'review')).toHaveLength(2);
    });
  });
});
