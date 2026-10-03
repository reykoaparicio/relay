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
 * or the project's .env value.
 */
async function expectExportedFiles(exportDir: string): Promise<void> {
  await expect.poll(async () => (await readdir(exportDir)).length).toBe(2);
  const files = (await readdir(exportDir)).sort();
  expect(files.filter((f) => f.endsWith('.md'))).toHaveLength(1);
  expect(files.filter((f) => f.endsWith('.patch'))).toHaveLength(1);
  for (const f of files) {
    const body = await readFile(path.join(exportDir, f), 'utf8');
    expect(body, f).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(body, f).not.toContain(SECRET_VALUE);
    if (f.endsWith('.md')) {
      expect(body, f).toContain('Limitations');
      expect(body, f).toContain('## Approvals');
      expect(body, f).toContain('## Revisions');
    }
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

    // Ledger: calculated usage > $0, nothing reserved or estimated once the run ended (FR-09); the exact total has no "~".
    await expect.poll(async () => inspector.ledgerAmount('Calculated from usage')).toBeGreaterThan(0);
    await expect(await inspector.ledgerRow('Reserved (in flight)')).toHaveText(RunInspector.amountText('$0.00'));
    await expect(await inspector.ledgerRow('Estimated')).toHaveText(RunInspector.amountText('$0.00'));
    await expect(await inspector.ledgerRow('Tracked total')).toHaveText(/^\$/);
    expect(new Set((await callLog()).map((c) => c.stepKey))).toEqual(
      new Set(['review', 'plan', 'implement', 'verify']),
    );

    // Report: limitations, "not modified" banner; export both to a stubbed folder.
    await inspector.viewReportLink().click();
    const report = new Report(page);
    await report.expectLoaded();
    await report.expectNotModifiedBanner();
    await expect(report.limitations()).toBeVisible();
    // report.v1 approvals / revisions (06 F17): the one plan approval, decided "approved"; no revision cycle used.
    await expect(report.approvals()).toHaveCount(1);
    await expect(report.approvals().first()).toContainText('Approve plan: approved');
    await expect(report.approvals().first()).toContainText(/Decided /);
    await expect(report.approvals().first()).not.toContainText('invalidated:');
    await expect(report.revisionsValue('Revision cycles')).toHaveText(/^0 of \d+$/);
    await expect(report.revisionsValue('Plan revisions')).toHaveText('0');
    await expect(report.revisions().getByText('Why the run is incomplete')).toHaveCount(0);

    const exportDir = await makeTempDir('export-');
    try {
      await stubDialogs({ exportDir });
      await report.exportBoth();
      await expectExportedFiles(exportDir);
    } finally {
      await safeRemove(exportDir);
    }

    // Project export (Settings → Storage & data → Export project…): one JSON bundle in the stubbed save folder,
    // secret-free and without the project's absolute folder path (02 `projects.export`: "project (no realpath)").
    await new Shell(page).nav('Settings');
    const settings = new Settings(page);
    await settings.expectLoaded();
    await settings.section('Storage & data');
    const bundleDir = await makeTempDir('export-project-');
    try {
      await stubDialogs({ exportDir: bundleDir });
      await settings.exportProject();
      await expect(new Shell(page).toast('Project export saved')).toBeVisible();
      await expect.poll(async () => readdir(bundleDir)).toEqual([`relay-project-${project.name}.json`]);
      const body = await readFile(path.join(bundleDir, `relay-project-${project.name}.json`), 'utf8');
      const bundle: unknown = JSON.parse(body);
      expect(bundle).toBeTruthy();
      await testInfo.attach('project-export.json', { body, contentType: 'application/json' });
      expect(body).toContain(`"${project.name}"`);
      for (const needle of ['sk-', 'AIza', FAKE_ANTHROPIC_KEY, SECRET_VALUE, project.dir]) {
        expect(body, `project export must not contain ${needle}`).not.toContain(needle);
      }
    } finally {
      await safeRemove(bundleDir);
    }
  });
});
