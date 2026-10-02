// Visual review tour (@tour): full-page screenshots of every page and the main run states, for a human (or agent)
// to look at. It asserts only that each state is reached; it never compares pixels. Skipped unless TOUR_DIR is set:
//   env -u ELECTRON_RUN_AS_NODE TOUR_DIR=/abs/out pnpm exec playwright test tests/e2e/specs/screenshot-tour.spec.ts
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test } from '../fixtures.js';
import { setupOwnProject, startRunViaNewRun } from '../flows.js';
import { NewRun, Runs, Settings } from '../pages/app-pages.js';
import type { SettingsSectionName } from '../pages/app-pages.js';
import { Memory } from '../pages/memory.js';
import { Report } from '../pages/report.js';
import { RunInspector } from '../pages/run-inspector.js';
import { Shell } from '../pages/shell.js';

const OUT = process.env['TOUR_DIR'] ?? '';
const GOAL = 'Validate the user id parameter in the user handler.';
const SECTIONS: SettingsSectionName[] = ['Providers', 'Model profiles', 'Projects', 'Storage & data', 'Diagnostics', 'About'];
const WIDE = { width: 1280, height: 860 };
const NARROW = { width: 1024, height: 768 };

function shooter(page: Page, group: string): (name: string) => Promise<void> {
  const dir = path.join(OUT, group);
  mkdirSync(dir, { recursive: true });
  let n = 0;
  return async (name) => {
    n += 1;
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(dir, `${String(n).padStart(2, '0')}-${name}.png`), fullPage: true });
  };
}

test.describe('screenshot tour', { tag: '@tour' }, () => {
  test.skip(OUT === '', 'set TOUR_DIR to an absolute output folder');
  test.describe.configure({ timeout: 240_000 });

  test.describe('happy path and every page', () => {
    test.use({ scenario: 'happy-path' });
    test('pages', async ({ page, stubDialogs, project }) => {
      await page.setViewportSize(WIDE);
      const shot = shooter(page, 'a-happy');
      await shot('onboarding-welcome');
      await setupOwnProject(page, stubDialogs, project);
      await shot('overview-empty');

      const shell = new Shell(page);
      await shell.nav('Runs');
      await shot('runs-empty');
      await new Runs(page).startWorkflow();
      const form = new NewRun(page);
      await form.expectLoaded();
      await shot('new-run-blank');
      await form.fillGoal(GOAL);
      await form.expectReady();
      await shot('new-run-ready');

      await startRunViaNewRun(page, GOAL);
      const inspector = new RunInspector(page);
      await inspector.expectLoaded();
      await inspector.expectAwaitingApproval();
      await shot('inspector-awaiting-approval');
      for (const tab of ['Context', 'Attempts', 'Events', 'Ledger'] as const) {
        await inspector.openTab(tab);
        await shot(`inspector-tab-${tab.toLowerCase()}`);
      }
      await inspector.openTab('Output');
      await inspector.openRevision();
      await shot('inspector-request-revision');
      await page.keyboard.press('Escape');
      await inspector.approve();
      await inspector.waitForStatus('Completed', 60_000);
      await shot('inspector-completed');
      await inspector.viewReportLink().click();
      const report = new Report(page);
      await report.expectLoaded();
      await shot('report');
      await report.patchTab();
      await shot('report-patch');

      await shell.nav('Overview');
      await shot('overview-with-run');
      await shell.nav('Runs');
      await shot('runs-list');
      await shell.nav('Memory');
      const memory = new Memory(page);
      await memory.expectLoaded();
      await shot('memory-approved');
      await memory.openTab('Suggested');
      await shot('memory-suggested');
      await memory.openAddRule();
      await shot('memory-add-rule');
      await page.keyboard.press('Escape');
      await shell.nav('Workflows');
      await shot('workflow-editor');
      await shell.nav('Settings');
      const settings = new Settings(page);
      await settings.expectLoaded();
      for (const s of SECTIONS) {
        await settings.section(s);
        await shot(`settings-${s.toLowerCase().replace(/[^a-z]+/g, '-')}`);
      }

      await page.setViewportSize(NARROW);
      for (const nav of ['Overview', 'Runs', 'Memory'] as const) {
        await shell.nav(nav);
        await shot(`narrow-${nav.toLowerCase()}`);
      }
      await page.setViewportSize(WIDE);
      await page.emulateMedia({ colorScheme: 'dark' });
      for (const nav of ['Overview', 'Runs', 'Settings'] as const) {
        await shell.nav(nav);
        await shot(`dark-${nav.toLowerCase()}`);
      }
    });
  });

  const STATES: readonly { scenario: string; status: string; allowance?: string; approveFirst?: boolean }[] = [
    { scenario: 'budget-exhaustion', status: 'Paused: run budget', allowance: '$0.10' },
    { scenario: 'unknown-outcome', status: 'Paused: unknown request outcome', approveFirst: true },
    { scenario: 'malformed-twice', status: "Paused: output didn't match schema" },
    { scenario: 'auth-fail', status: 'Paused: provider sign-in needed' },
    { scenario: 'overrun', status: 'Paused: cost exceeded reservation' },
  ];
  for (const s of STATES) {
    test.describe(`state ${s.scenario}`, () => {
      test.use({ scenario: s.scenario });
      test(s.scenario, async ({ page, stubDialogs, project }) => {
        await page.setViewportSize(WIDE);
        const shot = shooter(page, `b-${s.scenario}`);
        await setupOwnProject(page, stubDialogs, project);
        await startRunViaNewRun(page, GOAL, s.allowance === undefined ? {} : { allowance: s.allowance });
        const inspector = new RunInspector(page);
        await inspector.expectLoaded();
        if (s.approveFirst === true) {
          await inspector.expectAwaitingApproval();
          await inspector.approve();
        }
        await inspector.waitForStatus(s.status, 60_000);
        await shot('inspector');
        await inspector.openTab('Attempts');
        await shot('attempts');
        await new Shell(page).nav('Overview');
        await shot('overview');
      });
    });
  }
});
