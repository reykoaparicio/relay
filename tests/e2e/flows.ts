// Multi-page flows shared by the specs (built on the page objects).
import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
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

/** The `:projectId` of the current `#/p/<id>/…` route. */
export function projectIdOf(page: Page): string {
  const id = /#\/p\/([^/?]+)/.exec(page.url())?.[1];
  if (id === undefined) throw new Error(`no project id in ${page.url()}`);
  return id;
}

/**
 * Calls a renderer-exposed IPC channel through the preload bridge (`window.relay.invoke`), outside React Query: the
 * write is made "by another session", so the UI's cached copy goes stale exactly like a second window's edit would.
 */
export async function invokeAsAnotherSession<T = unknown>(page: Page, channel: string, input: unknown): Promise<T> {
  const res = await page.evaluate(
    async ([c, i]) => (window as unknown as { relay: { invoke(c: string, i: unknown): Promise<unknown> } }).relay.invoke(c, i),
    [channel, input] as const,
  );
  const r = res as { ok: boolean; data?: T; error?: unknown };
  if (!r.ok) throw new Error(`${channel} failed: ${JSON.stringify(r.error)}`);
  return r.data as T;
}

/**
 * Test-only response override in MAIN: deep-merges `patch` into the `data` of every successful reply on `channel`.
 * Used for UI states the real runner cannot produce yet (e.g. `workflows.get` with `editable.limits: false`). Relies on
 * Electron's internal `ipcMain._invokeHandlers` map (channel → the function given to `ipcMain.handle`); throws when
 * that internal is missing, so the test fails loudly instead of asserting against the unpatched UI.
 */
export async function patchIpcReply(app: ElectronApplication, channel: string, patch: Record<string, unknown>): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, [c, p]) => {
      type Handler = (e: unknown, ...args: unknown[]) => unknown;
      const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })._invokeHandlers;
      const orig = handlers?.get(c);
      if (handlers === undefined || orig === undefined) throw new Error(`no invoke handler for ${c}`);
      const merge = (target: Record<string, unknown>, src: Record<string, unknown>): void => {
        for (const [k, v] of Object.entries(src)) {
          const t = target[k];
          if (v !== null && typeof v === 'object' && !Array.isArray(v) && t !== null && typeof t === 'object') {
            merge(t as Record<string, unknown>, v as Record<string, unknown>);
          } else target[k] = v;
        }
      };
      handlers.set(c, async (e, ...args) => {
        const res = (await orig(e, ...args)) as { ok?: boolean; data?: unknown };
        if (res.ok === true && res.data !== null && typeof res.data === 'object') merge(res.data as Record<string, unknown>, p);
        return res;
      });
    },
    [channel, patch] as const,
  );
}
