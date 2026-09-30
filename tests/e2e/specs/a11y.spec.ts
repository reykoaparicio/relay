import { AxeBuilder } from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from '../fixtures.js';
import { FAKE_ANTHROPIC_KEY, startRunViaNewRun } from '../flows.js';
import { NewRun, Overview, Runs, Settings } from '../pages/app-pages.js';
import { Onboarding } from '../pages/onboarding.js';
import { Report } from '../pages/report.js';
import { RunInspector } from '../pages/run-inspector.js';
import { Shell } from '../pages/shell.js';

const GOAL = 'Validate the user id parameter in the user handler.';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21aa'];

interface AxeNode {
  readonly target: string;
  readonly html: string;
  readonly summary: string | undefined;
}
interface AxeViolation {
  readonly id: string;
  readonly impact: string | null | undefined;
  readonly help: string;
  readonly nodes: AxeNode[];
}

/**
 * KNOWN APP BUG (design system): ErrorView renders "Error code … · reference …" as `.subtle` text inside a
 * `.banner.danger` InlineAlert: #5b6b80 on #fee2e2 = 4.45:1 (< 4.5:1, WCAG 1.4.3). On New run it shows because the
 * memory picker's memory.* call is still a not_implemented notice (Wave 3). Tracked by its own expected-fail test
 * below; excluded here only for exactly that node so every other violation still fails the page.
 */
function isKnownErrorViewContrast(v: AxeViolation, n: AxeNode): boolean {
  return (
    v.id === 'color-contrast' &&
    /#5b6b80/.test(n.summary ?? '') &&
    /#fee2e2/.test(n.summary ?? '') &&
    /Error code|<code>/.test(n.html)
  );
}

async function axeViolations(page: Page): Promise<AxeViolation[]> {
  // Legacy mode runs axe in-page: the default mode opens a helper page, which Electron does not support.
  const res = await new AxeBuilder({ page }).withTags(WCAG).setLegacyMode(true).analyze();
  return res.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => ({
      target: n.target.join(' '),
      html: n.html.slice(0, 200),
      summary: n.failureSummary,
    })),
  }));
}

/** Runs axe on the current page; attaches the result and asserts 0 violations (minus the one tracked known bug). */
async function expectNoViolations(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  const all = await axeViolations(page);
  await testInfo.attach(`axe-${name}`, {
    body: JSON.stringify(all, null, 2),
    contentType: 'application/json',
  });
  const known = all.flatMap((v) =>
    v.nodes.filter((n) => isKnownErrorViewContrast(v, n)).map((n) => n.target),
  );
  if (known.length > 0)
    testInfo.annotations.push({
      type: 'known-bug:errorview-contrast',
      description: `${name}: ${known.join(', ')}`,
    });
  const rest = all
    .map((v) => ({ ...v, nodes: v.nodes.filter((n) => !isKnownErrorViewContrast(v, n)) }))
    .filter((v) => v.nodes.length > 0);
  expect.soft(rest, `axe violations on ${name}`).toEqual([]);
}

/** Onboarding with axe on step 3 (Connect a model provider), then the rest of setup. */
async function setupWithAxe(
  page: Page,
  stubDialogs: (s: { directory?: string }) => Promise<void>,
  projectDir: string,
  testInfo: TestInfo,
): Promise<void> {
  const ob = new Onboarding(page);
  await ob.startWithOwnFolder();
  await expectNoViolations(page, 'onboarding-step-3', testInfo);
  await ob.connectProvider('Anthropic', FAKE_ANTHROPIC_KEY, 'session');
  await expect(ob.connectOutcome('Anthropic')).toBeVisible();
  await ob.continue();
  await ob.expectStep('Select the project folder');
  await stubDialogs({ directory: projectDir });
  await ob.chooseFolder();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('sample-api');
  await ob.continue('Create project and continue');
  await ob.expectStep('Add one project rule');
  await page.getByRole('button', { name: 'Skip setup' }).click();
  await new Overview(page).expectLoaded();
}

/** Presses Tab until the focused element's accessible text matches `name` (keyboard only). */
async function tabTo(page: Page, name: RegExp, maxTabs = 80): Promise<void> {
  const seen: string[] = [];
  for (let i = 0; i < maxTabs; i += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (el === null || el === document.body) return { label: '', outline: 'none', visible: false };
      const cs = getComputedStyle(el);
      return {
        label: (el.getAttribute('aria-label') ?? el.innerText).replace(/\s+/g, ' ').trim(),
        outline: cs.outlineStyle,
        visible: el.matches(':focus-visible'),
      };
    });
    seen.push(focused.label);
    // The focus ring is visible on every element reached by keyboard (§5.7).
    expect(focused.outline, `focus ring on "${focused.label}"`).not.toBe('none');
    if (name.test(focused.label)) return;
  }
  throw new Error(`never focused ${String(name)} after ${String(maxTabs)} tabs; saw: ${seen.join(' | ')}`);
}

test.describe('accessibility', { tag: '@a11y' }, () => {
  test('axe: 0 violations on every page, including the inspector at approval and the report', async ({
    page,
    stubDialogs,
    project,
  }, testInfo) => {
    test.setTimeout(120_000);
    await setupWithAxe(page, stubDialogs, project.dir, testInfo);
    const shell = new Shell(page);
    await expectNoViolations(page, 'overview-empty', testInfo);

    await shell.nav('Runs');
    await new Runs(page).expectLoaded();
    await expectNoViolations(page, 'runs-empty', testInfo);

    await new Runs(page).startWorkflow();
    const form = new NewRun(page);
    await form.expectLoaded();
    await form.fillGoal(GOAL);
    await form.expectReady();
    await expectNoViolations(page, 'new-run', testInfo);

    await startRunViaNewRun(page, GOAL);
    const inspector = new RunInspector(page);
    await inspector.expectAwaitingApproval();
    await expectNoViolations(page, 'inspector-awaiting-approval', testInfo);
    await inspector.openRevision();
    await expectNoViolations(page, 'inspector-revision-form', testInfo);

    await shell.nav('Overview');
    await new Overview(page).expectLoaded();
    await expect(new Overview(page).attentionCard()).toBeVisible();
    await expectNoViolations(page, 'overview-awaiting-approval', testInfo);

    await shell.nav('Runs');
    await expect(new Runs(page).rows()).toHaveCount(1);
    await expectNoViolations(page, 'runs-list', testInfo);

    await shell.nav('Memory');
    await expect(page.getByRole('heading', { level: 1, name: 'Project memory' })).toBeVisible();
    await expectNoViolations(page, 'memory', testInfo);

    await shell.nav('Settings');
    await new Settings(page).expectLoaded();
    await expectNoViolations(page, 'settings-providers', testInfo);
    await new Settings(page).section('Diagnostics');
    await expectNoViolations(page, 'settings-diagnostics', testInfo);

    // Complete the run → report.
    await page.goBack();
    await shell.nav('Runs');
    await new Runs(page).row(GOAL).first().getByRole('link').first().click();
    await inspector.expectAwaitingApproval();
    await inspector.approve();
    await inspector.waitForStatus('Completed');
    await expectNoViolations(page, 'inspector-completed', testInfo);
    await inspector.viewReportLink().click();
    const report = new Report(page);
    await report.expectLoaded();
    await expectNoViolations(page, 'report', testInfo);
    await report.patchTab();
    await expectNoViolations(page, 'report-patch', testInfo);
  });

  test('keyboard-only approval journey with a visible focus ring and a working skip link', async ({
    page,
    stubDialogs,
    project,
  }) => {
    await setupWithAxe(page, stubDialogs, project.dir, test.info());
    await startRunViaNewRun(page, GOAL);
    await new RunInspector(page).expectAwaitingApproval();

    // From a fresh window load of the start route: keyboard only from here on (no mouse).
    await new Shell(page).nav('Overview');
    await page.reload();
    const overview = new Overview(page);
    await overview.expectLoaded();

    // The skip link is the first stop and moves focus to <main>.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();

    await tabTo(page, /^Inspect plan$/);
    await page.keyboard.press('Enter');
    const inspector = new RunInspector(page);
    await inspector.waitForStatus('Awaiting your approval');
    await expect(inspector.approvalCard()).toBeVisible();
    await tabTo(page, /^Approve plan$/);
    await expect(inspector.approvalCard().getByRole('button', { name: 'Approve plan' })).toBeFocused();
    await page.keyboard.press('Enter');
    await inspector.waitForStatus('Completed');
  });

  test('at 1100 px the inspector secondary panels become tabs, still 0 axe violations', async ({
    app,
    page,
    stubDialogs,
    project,
  }, testInfo) => {
    await setupWithAxe(page, stubDialogs, project.dir, testInfo);
    await startRunViaNewRun(page, GOAL);
    const inspector = new RunInspector(page);
    await inspector.expectAwaitingApproval();
    // Wide (1440 px): Budget / Context summary are labelled sections, not tabs.
    await expect(inspector.tab('Budget')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Budget', exact: true })).toBeVisible();

    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w === undefined) throw new Error('no window');
      w.setSize(1100, 900);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(1100);
    await expect(inspector.tab('Budget')).toBeVisible();
    await expect(inspector.tab('Context summary')).toBeVisible();
    expect(await inspector.secondaryPanelTabs()).toEqual([
      'Output',
      'Context',
      'Attempts',
      'Events',
      'Ledger',
      'Budget',
      'Context summary',
    ]);
    const budget = await inspector.openTab('Budget');
    await expect(budget.getByRole('table', { name: /tracked usage/ })).toBeVisible();
    await expectNoViolations(page, 'inspector-1100px-budget-tab', testInfo);
    await inspector.openTab('Output');
    await expectNoViolations(page, 'inspector-1100px-output', testInfo);
  });

  test('New run with a not-available notice: ErrorView text meets 4.5:1 contrast', async ({
    page,
    stubDialogs,
    project,
  }) => {
    test.fail(true, 'app bug: ErrorView .subtle text on .banner.danger is 4.45:1 (#5b6b80 on #fee2e2)');
    await setupWithAxe(page, stubDialogs, project.dir, test.info());
    await new Shell(page).nav('Runs');
    await new Runs(page).startWorkflow();
    await new NewRun(page).expectLoaded();
    await expect(page.getByText(/Error code/).first()).toBeVisible();
    const contrast = (await axeViolations(page)).filter((v) => v.id === 'color-contrast');
    expect(contrast).toEqual([]);
  });
});
