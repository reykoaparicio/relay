// Multi-page flows shared by the specs (built on the page objects).
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { DialogStub, ProjectCopy } from './fixtures.js';
import { NewRun, Overview, Runs } from './pages/app-pages.js';
import { Onboarding } from './pages/onboarding.js';
import { Shell } from './pages/shell.js';

/** A syntactically valid fake key (fake provider mode: never sent anywhere). */
export const FAKE_ANTHROPIC_KEY = 'sk-ant-e2e-ABCDEFGHIJKLMNOP';

/**
 * Onboarding with the per-test project copy: own folder → session key → choose folder (stubbed dialog) → create
 * project → "Skip setup" → project overview.
 */
export async function setupOwnProject(
  page: Page,
  stubDialogs: (s: DialogStub) => Promise<void>,
  project: ProjectCopy,
): Promise<void> {
  const ob = new Onboarding(page);
  await ob.startWithOwnFolder();
  await ob.connectProvider('Anthropic', FAKE_ANTHROPIC_KEY, 'session');
  await expect(ob.connectOutcome('Anthropic')).toBeVisible();
  await ob.continue();
  await ob.expectStep('Select the project folder');
  await stubDialogs({ directory: project.dir });
  await ob.chooseFolder();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue(project.name);
  await ob.continue('Create project and continue');
  await ob.expectStep('Add one project rule');
  await page.getByRole('button', { name: 'Skip setup' }).click();
  await new Overview(page).expectLoaded();
  await expect(new Shell(page).activeProject()).toContainText(project.name);
}

/** Runs → Start a workflow → New run (all selected files, defaults) → Start run. Lands on the run inspector route. */
export async function startRunViaNewRun(
  page: Page,
  goal: string,
  opts: { allowance?: string; maxAttempts?: number } = {},
): Promise<string> {
  await new Shell(page).nav('Runs');
  const runs = new Runs(page);
  await runs.expectLoaded();
  await runs.startWorkflow();
  const form = new NewRun(page);
  await form.expectLoaded();
  await form.fillGoal(goal);
  if (opts.allowance !== undefined) await form.setAllowance(opts.allowance);
  if (opts.maxAttempts !== undefined) await form.setLimits({ maxAttempts: opts.maxAttempts });
  await form.expectReady();
  await form.submit();
  await expect(page).toHaveURL(/#\/p\/[^/]+\/runs\/run_[^/?]+$/);
  const runId = /\/runs\/(run_[^/?]+)$/.exec(page.url())?.[1];
  if (runId === undefined) throw new Error(`no run id in ${page.url()}`);
  return runId;
}
