import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '../fixtures.js';
import { setupOwnProject, startRunViaNewRun } from '../flows.js';
import { Report } from '../pages/report.js';
import { RunInspector } from '../pages/run-inspector.js';

const GOAL = 'Validate the user id parameter in the user handler.';
const CHANGED = 'src/handlers/user.ts';

test.describe('approval stale', { tag: '@m3' }, () => {
  test('a project file changed at approval → PROJECT_CHANGED banner → preserved snapshot → completes', async ({
    page,
    stubDialogs,
    project,
    callLog,
  }) => {
    await setupOwnProject(page, stubDialogs, project);
    await startRunViaNewRun(page, GOAL);
    const inspector = new RunInspector(page);
    await inspector.expectAwaitingApproval();

    // The user edits a snapshotted file while the plan waits (§11.2). The test restores it afterwards, so the
    // fixture's "project tree unchanged" check still proves the app itself never wrote to the project.
    const file = path.join(project.dir, CHANGED);
    const original = await readFile(file);
    try {
      await writeFile(
        file,
        `${original.toString('utf8')}\n// edited by the user while the plan awaited approval\n`,
      );
      await inspector.approve();

      await inspector.waitForStatus('Paused: approval out of date');
      const banner = inspector.banner();
      await expect(banner).toContainText('Project files changed after the plan was proposed');
      await expect(banner.getByRole('listitem').filter({ hasText: CHANGED })).toContainText(
        'changed since the context snapshot',
      );
      await expect(banner).toContainText(/Error code\s*PROJECT_CHANGED/);
      await expect(inspector.bannerAction('Re-snapshot files and re-plan')).toBeVisible();
      const callsBefore = (await callLog()).length;

      await inspector.bannerAction('Use preserved snapshot').click();
      await inspector.expectAwaitingApproval();
      await inspector.approve();
      await inspector.waitForStatus('Completed');
      // Nothing before the approval was re-run: the preserved snapshot was used as is.
      const calls = await callLog();
      expect(calls.filter((c) => c.stepKey === 'plan')).toHaveLength(1);
      expect(calls.length).toBeGreaterThan(callsBefore);
    } finally {
      await writeFile(file, original);
    }

    await inspector.viewReportLink().click();
    const report = new Report(page);
    await report.expectLoaded();
    await expect(
      page.getByText('The preserved snapshot was used; files changed after it are not reflected.'),
    ).toBeVisible();
  });

  // KNOWN APP BUG: the engine sends PROJECT_CHANGED `details.before` / `details.after` as { relPath: sha256 } maps
  // (engine approval-binding.ts projectChangedError, context.ts staleCheck), but the StatusBanner reads them with
  // stringDetail(detail, 'before'|'after') (strings only), so the before → after hashes are never shown.
  test('the stale banner shows the before → after file hashes', async ({ page, stubDialogs, project }) => {
    test.fail(true, 'app bug: StatusBanner expects string before/after; engine sends per-path hash maps');
    await setupOwnProject(page, stubDialogs, project);
    await startRunViaNewRun(page, GOAL);
    const inspector = new RunInspector(page);
    await inspector.expectAwaitingApproval();
    const file = path.join(project.dir, CHANGED);
    const original = await readFile(file);
    try {
      await writeFile(file, `${original.toString('utf8')}\n// edited\n`);
      await inspector.approve();
      await inspector.waitForStatus('Paused: approval out of date');
      await expect(inspector.banner().getByRole('listitem').filter({ hasText: CHANGED })).toContainText(
        /\(hash .+ → .+\)/,
        {
          timeout: 5_000,
        },
      );
    } finally {
      await writeFile(file, original);
    }
  });
});
