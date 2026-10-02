import { test, expect } from '../fixtures.js';
import { setupOwnProject, startRunViaNewRun } from '../flows.js';
import { dollars, RunInspector } from '../pages/run-inspector.js';

const GOAL = 'Validate every field of the create-user request.';

// budget-exhaustion: every call reports large usage, so the allowance runs out mid-template (04 §D7).
test.use({ scenario: 'budget-exhaustion' });

test.describe('budget pause', { tag: '@m4' }, () => {
  test('pauses before dispatch with the admission arithmetic, then resumes after raising the allowance', async ({
    page,
    stubDialogs,
    project,
    callLog,
  }, testInfo) => {
    await setupOwnProject(page, stubDialogs, project);
    await startRunViaNewRun(page, GOAL, { allowance: '$0.10' });
    const inspector = new RunInspector(page);
    await inspector.waitForStatus('Paused: run budget');

    // FR-05: "Paused before dispatch…" with L = $0.10 and C + R + U + N > L.
    const banner = inspector.banner();
    await expect(banner).toContainText('Paused before dispatch');
    await expect(banner).toContainText('Nothing was sent to the provider.');
    const arith = banner.getByRole('table', { name: /Admission check/ });
    await expect(arith.getByRole('row', { name: /Run allowance/ })).toContainText('$0.10');
    const total = dollars(await arith.getByRole('row', { name: /C \+ R \+ U \+ N/ }).textContent());
    expect(total).toBeGreaterThan(0.1);
    await expect(banner.getByText(/> \$0\.10\d* → blocked/)).toBeVisible();

    // The blocked step was never sent (call log is the source of truth).
    const blockedTitle = ((await inspector.stepHeading().textContent()) ?? '').trim();
    const calls = await callLog();
    testInfo.annotations.push({
      type: 'blocked',
      description: `${blockedTitle}; calls: ${calls.map((c) => c.stepKey).join(',')}`,
    });
    const TITLE_TO_KEY: Record<string, string> = {
      'Review input': 'review',
      'Plan a fix': 'plan',
      'Produce patch': 'implement',
      'Review patch': 'verify',
    };
    const blockedKey = TITLE_TO_KEY[blockedTitle];
    expect(blockedKey, `blocked step "${blockedTitle}"`).toBeDefined();
    expect(calls.filter((c) => c.stepKey === blockedKey)).toHaveLength(0);
    await expect(await inspector.ledgerRow('Reserved (in flight)')).toHaveText(RunInspector.amountText('$0.00'));

    // Increase the allowance → the run continues on its own.
    await inspector.increaseAllowance('$3.00');
    await expect(await inspector.ledgerRow('Allowance')).toHaveText(RunInspector.amountText('$3.00'));
    await inspector.expectAwaitingApproval();
    await inspector.approve();
    await inspector.waitForStatus('Completed');
    const after = await callLog();
    expect(after.filter((c) => c.stepKey === blockedKey)).toHaveLength(1);
  });
});
