import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures.js';
import type { DialogStub, ProjectCopy } from '../fixtures.js';
import { setupOwnProject, startRunViaNewRun } from '../flows.js';
import { RunInspector } from '../pages/run-inspector.js';

/** Decision 1: no visible wording says "unknown" (identifiers such as the error code REQUEST_OUTCOME_UNKNOWN aside). */
const NO_UNKNOWN = /(?<!\w)unknown/i;
const GOAL = 'Validate the user id parameter in the user handler.';
/** Decision 1: an amount without an exact cost reads "~$0.03 (estimated)"; never "unknown". */
const ESTIMATE = /~\$[\d.,]+ \(estimated\)/;
const EXPLANATION = /The last request may or may not have completed\. Relay counted ~\$[\d.,]+ \(estimated\) toward the budget/;

/**
 * Setup → run → approve → the implement request ends without a confirmed outcome: the engine settles it as an
 * estimate and pauses with a plain explanation and only Retry step / Stop.
 */
async function reachUncertain(
  page: Page,
  stubDialogs: (s: DialogStub) => Promise<void>,
  project: ProjectCopy,
): Promise<RunInspector> {
  await setupOwnProject(page, stubDialogs, project);
  await startRunViaNewRun(page, GOAL);
  const inspector = new RunInspector(page);
  await inspector.expectAwaitingApproval();
  await inspector.approve();
  await inspector.waitForStatus('Paused: request may not have completed');
  await expect(inspector.banner()).toContainText('The last request may or may not have completed');
  await expect(inspector.banner()).toContainText(EXPLANATION);
  await expect(inspector.banner()).toContainText('Retry the step (this may charge again) or stop.');
  // Only Retry step and Stop: nothing to "decide".
  await inspector.expectActions(['Retry step', 'Stop run']);
  await expect(page.getByRole('button', { name: /decide/i })).toHaveCount(0);
  // The request facts of the uncertain attempt are kept.
  await expect(inspector.banner().getByRole('list', { name: 'Requests that may not have completed' })).toContainText(/Sent/);
  await expect(page.getByRole('main')).not.toContainText(NO_UNKNOWN);
  return inspector;
}

test.describe('unknown outcome', { tag: '@m3' }, () => {
  // unknown-outcome: the implement request is dispatched and a response id arrives, then the connection resets: it
  // reached the provider, so its estimate is likely charged (no "may not have been charged" note).
  test.describe('request reached the provider', () => {
    test.use({ scenario: 'unknown-outcome' });

    test('the estimate counts toward the budget; Retry step (may charge again) completes and keeps it', async ({
      page,
      stubDialogs,
      project,
      callLog,
    }) => {
      const inspector = await reachUncertain(page, stubDialogs, project);
      await expect(inspector.banner()).not.toContainText('may not have been charged');
      // The Budget card: the estimate is an estimated amount and the totals read "~".
      await expect(await inspector.ledgerRow('Estimated')).toContainText(ESTIMATE);
      const estimate = await inspector.ledgerAmount('Estimated');
      expect(estimate).toBeGreaterThan(0);
      await expect(await inspector.ledgerRow('Tracked total')).toContainText(/^~\$/);

      await inspector.retryStep();
      await inspector.waitForStatus('Completed');
      expect((await callLog()).filter((c) => c.stepKey === 'implement')).toHaveLength(2);
      // Not dropped: the first request's estimate is still counted after completion.
      await expect.poll(async () => inspector.ledgerAmount('Estimated')).toBeGreaterThanOrEqual(estimate);
      await expect(page.getByRole('main')).not.toContainText(NO_UNKNOWN);
    });

    test('the attempt row and ledger entries show the estimate; Stop ends the run with it in the report', async ({
      page,
      stubDialogs,
      project,
    }) => {
      const inspector = await reachUncertain(page, stubDialogs, project);
      await inspector.selectStep('Produce patch');
      const attempts = await inspector.attemptsTable();
      await expect(attempts.getByRole('row').filter({ hasText: /#1/ })).toContainText(ESTIMATE, { timeout: 5_000 });

      const ledger = await inspector.openTab('Ledger');
      const table = ledger.getByRole('table', { name: /^Ledger entries for / });
      await expect(table.getByRole('row').filter({ hasText: 'Produce patch' }).filter({ hasText: 'Estimated' }).first()).toBeVisible();
      await expect(ledger).not.toContainText(NO_UNKNOWN);

      await inspector.bannerAction('Stop run').click();
      const dialog = page.getByRole('dialog', { name: 'Stop this run?' });
      await dialog.getByRole('button', { name: 'Stop run' }).click();
      await inspector.waitForStatus('Cancelled');
      await inspector.viewReportLink().click();
      const cost = page.getByRole('region', { name: 'Total tracked cost' });
      await expect(cost.locator('p.text-2xl')).toHaveText(/^~\$/);
      await expect(cost.getByText('Estimated charges')).toBeVisible();
      await expect(cost).toContainText(ESTIMATE);
      await expect(page.getByRole('main')).not.toContainText(NO_UNKNOWN);
    });
  });

  // unknown-before-response: the connection resets before any response byte: the request may never have reached the
  // provider, so the estimate carries the note "may not have been charged".
  test.describe('request may never have reached the provider', () => {
    test.use({ scenario: 'unknown-before-response' });

    test('the estimate says "may not have been charged"', async ({ page, stubDialogs, project }) => {
      const inspector = await reachUncertain(page, stubDialogs, project);
      await expect(inspector.banner()).toContainText(
        /Relay counted ~\$[\d.,]+ \(estimated\) toward the budget, may not have been charged\. Retry the step/,
      );
      await expect(inspector.banner().getByRole('list', { name: 'Requests that may not have completed' })).toContainText(
        'may not have been charged',
      );
    });
  });
});
