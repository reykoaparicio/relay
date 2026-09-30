import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures.js';
import type { DialogStub, ProjectCopy } from '../fixtures.js';
import { setupOwnProject, startRunViaNewRun } from '../flows.js';
import { RunInspector } from '../pages/run-inspector.js';

const GOAL = 'Validate the user id parameter in the user handler.';
const RETRY = 'Retry (may incur another charge)';
const ACCEPT = 'Accept the estimated charge';

// unknown-outcome: the implement request is dispatched, then the connection resets (sent_no_response, §7.5).
test.use({ scenario: 'unknown-outcome' });

/** Setup → run → approve → the implement attempt ends with an unknown outcome. */
async function reachUnknown(
  page: Page,
  stubDialogs: (s: DialogStub) => Promise<void>,
  project: ProjectCopy,
): Promise<RunInspector> {
  await setupOwnProject(page, stubDialogs, project);
  await startRunViaNewRun(page, GOAL);
  const inspector = new RunInspector(page);
  await inspector.expectAwaitingApproval();
  await inspector.approve();
  await inspector.waitForStatus('Paused: unknown request outcome');
  await expect(inspector.banner()).toContainText('The request may have been sent; its charge is unknown');
  const recovery = inspector.recoveryPanel();
  await expect(recovery.getByRole('heading', { name: 'Requests with an unknown outcome' })).toBeVisible();
  await expect(recovery).toContainText(/Produce patch|Implement/);
  await expect(recovery).toContainText('Possible charge (liability kept)');
  return inspector;
}

test.describe('unknown outcome', { tag: '@m3' }, () => {
  test('retry says it may incur another charge; the earlier liability is kept after completion', async ({
    page,
    stubDialogs,
    project,
    callLog,
  }) => {
    const inspector = await reachUnknown(page, stubDialogs, project);
    const liability = await inspector.ledgerAmount('Unknown liability');
    expect(liability).toBeGreaterThan(0);

    // §4.4: the retry label always says it may incur another charge; the confirmation repeats it.
    const retry = inspector.recoveryPanel().getByRole('button', { name: RETRY });
    await expect(retry).toBeVisible();
    await retry.click();
    const dialog = page.getByRole('dialog', { name: 'Retry this request?' });
    await expect(dialog).toContainText('The retry may incur another charge');
    await dialog.getByRole('button', { name: RETRY }).click();
    await expect(dialog).toBeHidden();

    await inspector.waitForStatus('Completed');
    expect((await callLog()).filter((c) => c.stepKey === 'implement')).toHaveLength(2);
    // Not silently dropped: the unknown liability of the first request is still tracked.
    await expect.poll(async () => inspector.ledgerAmount('Unknown liability')).toBeCloseTo(liability, 4);
  });

  test('accepting the estimated charge settles it as "est." and clears the unknown liability', async ({
    page,
    stubDialogs,
    project,
    callLog,
  }, testInfo) => {
    const inspector = await reachUnknown(page, stubDialogs, project);
    expect(await inspector.ledgerAmount('Unknown liability')).toBeGreaterThan(0);

    await inspector.decideUnknown(ACCEPT);
    await expect(await inspector.ledgerRow('Unknown liability')).toHaveText('$0.00');
    await expect.poll(async () => inspector.ledgerAmount('Estimated')).toBeGreaterThan(0);
    await expect(await inspector.ledgerRow('Estimated')).toContainText('est.');

    // The per-attempt ledger rows of that implement attempt carry the "estimated" certainty.
    const ledger = await inspector.openTab('Ledger');
    const table = ledger.getByRole('table', { name: /^Ledger entries for / });
    const estimatedRows = table
      .getByRole('row')
      .filter({ hasText: 'Produce patch' })
      .filter({ hasText: 'estimated' });
    await expect(estimatedRows.first()).toBeVisible();
    await expect(table.getByRole('row').filter({ hasText: 'Produce patch' })).not.toHaveCount(0);
    testInfo.annotations.push({
      type: 'status-after-accept',
      description: ((await inspector.status().textContent()) ?? '').trim(),
    });
    testInfo.annotations.push({
      type: 'implement-calls',
      description: String((await callLog()).filter((c) => c.stepKey === 'implement').length),
    });
  });

  // Regression (engine views.ts toAttemptView): an attempt settled by accept_estimated_charge derives its certainty
  // from its settle entries ('estimated'), so the Attempts tab labels the charge "est.".
  test('the accepted attempt row in the Attempts tab shows the "est." label', async ({
    page,
    stubDialogs,
    project,
  }) => {
    const inspector = await reachUnknown(page, stubDialogs, project);
    await inspector.decideUnknown(ACCEPT);
    await expect(await inspector.ledgerRow('Unknown liability')).toHaveText('$0.00');
    await inspector.selectStep('Produce patch');
    const attempts = await inspector.attemptsTable();
    await expect(attempts.getByRole('row').filter({ hasText: /#1/ })).toContainText(/\$[\d.]+ est\./, {
      timeout: 5_000,
    });
  });
});
