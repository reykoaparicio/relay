import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, FIXTURE_ENV_SECRET } from '../fixtures.js';
import { FAKE_ANTHROPIC_KEY, setupOwnProject, startRunViaNewRun } from '../flows.js';
import { Settings } from '../pages/app-pages.js';
import { Report } from '../pages/report.js';
import { RunInspector } from '../pages/run-inspector.js';
import { Shell } from '../pages/shell.js';
import { makeTempDir, safeRemove } from '../safe-remove.js';

const GOAL = 'Validate the user id parameter in the user handler.';
const SECRET_VALUE = FIXTURE_ENV_SECRET.split('=')[1] ?? FIXTURE_ENV_SECRET;
/** formatDuration output: "850 ms", "1.2 s", "5 s", "1 min 5 s". */
const DURATION = /^\d[\d.,]*\s?(ms|s|min)\b/;

/**
 * Exported files: exactly a Markdown report (with "Limitations") and a .patch, neither containing the provider key
 * or the project's .env value. While `artifacts.exportTo` is still stubbed (outcome 'not_available'), nothing may be
 * written at all.
 */
async function expectExportedFiles(outcome: 'exported' | 'not_available', exportDir: string): Promise<void> {
  if (outcome === 'not_available') {
    expect(await readdir(exportDir)).toEqual([]);
    return;
  }
  await expect.poll(async () => (await readdir(exportDir)).length).toBe(2);
  const files = (await readdir(exportDir)).sort();
  expect(files.filter((f) => f.endsWith('.md'))).toHaveLength(1);
  expect(files.filter((f) => f.endsWith('.patch'))).toHaveLength(1);
  for (const f of files) {
    const body = await readFile(path.join(exportDir, f), 'utf8');
    expect(body, f).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(body, f).not.toContain(SECRET_VALUE);
    if (f.endsWith('.md')) expect(body, f).toContain('Limitations');
  }
}

// slow-review: the review call takes 5 s, so the in-flight reservation is observable (12 §L6).
test.use({ scenario: 'slow-review', projectEnvSecret: true });

test.describe('run happy path', { tag: '@m2' }, () => {
  test('approve → completed with honest costs, report limitations, and secret-free exports', async ({
    page,
    stubDialogs,
    project,
    callLog,
  }, testInfo) => {
    await setupOwnProject(page, stubDialogs, project);
    await startRunViaNewRun(page, GOAL);
    const inspector = new RunInspector(page);
    await inspector.expectLoaded();

    // While the review call is in flight, the budget panel shows a reservation (FR-04 / §9.3).
    await inspector.waitForStatus('Running');
    await expect.poll(async () => (await callLog()).map((c) => c.stepKey)).toEqual(['review']);
    await expect.poll(async () => inspector.reservedAmount()).toBeGreaterThan(0);
    expect(
      (await callLog()).map((c) => c.stepKey),
      'still only the review call in flight',
    ).toEqual(['review']);

    // Approval checkpoint: review + plan done, the plan with the exact hashes it covers.
    await inspector.expectAwaitingApproval();
    await expect(inspector.timelineStep('Review input')).toContainText('Done');
    await expect(inspector.timelineStep('Plan a fix')).toContainText('Done');
    const card = inspector.approvalCard();
    await expect(card.getByText('What this approval covers')).toBeVisible();
    await expect(card).toContainText(/Covers plan hash .+ and context snapshot .+ only/);
    await expect(card.getByRole('heading', { name: 'Files the plan may change' })).toBeVisible();

    // Provider latency and app time are two separately labelled values (§3.3, R3-20).
    await inspector.selectStep('Review input');
    // (The step detail cached while the review was executing refreshes with the settled timings.)
    await expect.poll(async () => (await inspector.attemptTimings()).providerLatency).toMatch(DURATION);
    const timings = await inspector.attemptTimings();
    testInfo.annotations.push({ type: 'review-attempt-timings', description: JSON.stringify(timings) });
    expect(timings.appTime).toMatch(DURATION);

    await inspector.selectStep('Approve plan');
    await inspector.approve();
    await inspector.waitForStatus('Completed');
    await expect(inspector.verdictNote()).toBeVisible();

    // Ledger: calculated usage > $0, nothing reserved or unknown once the run ended (FR-09).
    await expect.poll(async () => inspector.ledgerAmount('Calculated from usage')).toBeGreaterThan(0);
    await expect(await inspector.ledgerRow('Reserved (in flight)')).toHaveText('$0.00');
    await expect(await inspector.ledgerRow('Unknown liability')).toHaveText('$0.00');
    expect(new Set((await callLog()).map((c) => c.stepKey))).toEqual(
      new Set(['review', 'plan', 'implement', 'verify']),
    );

    // Report: limitations, "not modified" banner; export both to a stubbed folder.
    await inspector.viewReportLink().click();
    const report = new Report(page);
    await report.expectLoaded();
    await report.expectNotModifiedBanner();
    await expect(report.limitations()).toBeVisible();

    const exportDir = await makeTempDir('export-');
    try {
      await stubDialogs({ exportDir });
      const outcome = await report.exportBoth();
      testInfo.annotations.push({ type: 'artifacts.export', description: outcome });
      await expectExportedFiles(outcome, exportDir);
    } finally {
      await safeRemove(exportDir);
    }

    // Project export (Settings → Storage & data): projects.export has no UI in this build; the section says so.
    await new Shell(page).nav('Settings');
    const settings = new Settings(page);
    await settings.expectLoaded();
    await settings.section('Storage & data');
    const data = page.getByRole('region', { name: 'Storage & data' });
    await expect(data.getByText('Coming soon.')).toBeVisible();
    await expect(data).toContainText('project and ledger exports');
    await expect(data.getByRole('button', { name: /Export project/ })).toHaveCount(0);
    testInfo.annotations.push({
      type: 'projects.export',
      description: 'not available in this build (Coming soon notice asserted)',
    });
  });
});
