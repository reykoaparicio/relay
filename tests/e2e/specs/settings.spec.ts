import { test, expect } from '../fixtures.js';
import { invokeAsAnotherSession, projectIdOf, setupOwnProject, startRunViaNewRun } from '../flows.js';
import { Settings } from '../pages/app-pages.js';
import { Memory } from '../pages/memory.js';
import { RunInspector } from '../pages/run-inspector.js';
import { Shell } from '../pages/shell.js';

// Settings → Projects / Storage & data (10 J10): edits survive a refetch, `?project=` deep links, archive guard.
const GOAL = 'Validate the user id parameter in the user handler.';

interface ProjectDto {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly exclusions: string[];
  readonly monthlyAllowanceMicrousd: number | null;
}

test.describe('settings', { tag: '@m4' }, () => {
  test('the project form keeps the user’s edits when a newer project is loaded', async ({ page, stubDialogs, project }) => {
    await setupOwnProject(page, stubDialogs, project);
    const projectId = projectIdOf(page);
    await new Shell(page).nav('Settings');
    const settings = new Settings(page);
    await settings.expectLoaded();
    await settings.section('Projects');
    const form = settings.projectForm();
    const exclusions = form.getByRole('textbox', { name: 'Exclusions (one pattern per line)' });
    await exclusions.fill('fixtures/**');

    // Another session saves a monthly allowance; my save is then stale → CONFLICT → the newer project is refetched.
    const current = await invokeAsAnotherSession<ProjectDto>(page, 'relay/v1/projects.get', { projectId });
    await invokeAsAnotherSession(page, 'relay/v1/projects.update', {
      projectId,
      expectedUpdatedAt: current.updatedAt,
      patch: { monthlyAllowanceMicrousd: 5_000_000 },
    });
    await form.getByRole('button', { name: 'Save project settings' }).click();

    const section = settings.projectsSection();
    const changed = section.getByRole('status').filter({ hasText: 'This project changed since you started editing' });
    await expect(changed).toBeVisible();
    const table = changed.getByRole('table', { name: 'Saved project settings compared with your edits' });
    await expect(table.getByRole('row', { name: /^Monthly allowance/ })).toContainText('(changed on the server)');
    await expect(table.getByRole('row', { name: /^Monthly allowance/ })).toContainText('$5.00');
    await expect(table.getByRole('row', { name: /^Exclusions/ })).toContainText('fixtures/**');
    // The refetch did not remount the form: my edit is still there and the server value is not applied behind my back.
    await expect(exclusions).toHaveValue('fixtures/**');
    await expect(form.getByRole('textbox', { name: 'Monthly allowance (optional)' })).toHaveValue('');
    await expect(form.getByRole('button', { name: 'Save project settings' })).toBeDisabled();

    // Keep my changes on top of the saved settings → save → both changes are stored.
    await changed.getByRole('button', { name: 'Keep my changes on top of the saved settings' }).click();
    await expect(form.getByRole('textbox', { name: 'Monthly allowance (optional)' })).toHaveValue('5.00');
    await form.getByRole('button', { name: 'Save project settings' }).click();
    await expect(new Shell(page).toast(`Saved “${project.name}”`)).toBeVisible();
    const saved = await invokeAsAnotherSession<ProjectDto>(page, 'relay/v1/projects.get', { projectId });
    expect(saved.exclusions).toEqual(['fixtures/**']);
    expect(saved.monthlyAllowanceMicrousd).toBe(5_000_000);
  });

  test('Memory → "Purge project history" lands on Storage & data for that project, and the purge dialog names it', async ({
    page,
    stubDialogs,
    project,
  }) => {
    await setupOwnProject(page, stubDialogs, project);
    const projectId = projectIdOf(page);
    // A second project becomes the active one, so a Settings fallback would pick the wrong project.
    const sample = await invokeAsAnotherSession<ProjectDto>(page, 'relay/v1/projects.createSample', {
      idempotencyKey: `e2e-sample-${String(Date.now())}`,
    });
    expect(sample.id).not.toBe(projectId);
    await invokeAsAnotherSession(page, 'relay/v1/app.updateSettings', { activeProjectId: sample.id });
    await page.reload(); // load both projects and the new active project into the renderer

    await page.evaluate((id) => {
      window.location.hash = `#/p/${id}/memory`;
    }, projectId);
    const memory = new Memory(page);
    await memory.expectLoaded();
    await memory.addRule({ title: 'Response format', content: 'Preserve the existing public response format.' });
    const del = await memory.openDelete('Approved', 'Response format');
    await del.getByRole('link', { name: 'Purge project history' }).click();

    await expect(page).toHaveURL(new RegExp(`#/settings/data\\?project=${projectId}$`));
    const settings = new Settings(page);
    await expect(settings.data()).toBeVisible();
    await expect(settings.projectPicker()).toHaveValue(projectId);
    await expect(settings.fallbackProjectNote()).toHaveCount(0);
    const dialog = await settings.openPurge();
    await expect(dialog).toHaveAccessibleName(`Purge the history of “${project.name}”?`);
    await expect(dialog).toContainText(`Project: ${project.name}`);
    await expect(dialog.getByRole('textbox', { name: `Type “purge” to confirm purging the history of “${project.name}”` })).toBeVisible();
    expect(sample.name).not.toBe(project.name);
    await expect(dialog).not.toContainText(sample.name);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('archiving a project with an active run shows the active_run message', async ({ page, stubDialogs, project }) => {
    await setupOwnProject(page, stubDialogs, project);
    const runId = await startRunViaNewRun(page, GOAL);
    await new RunInspector(page).expectAwaitingApproval();

    await new Shell(page).nav('Settings');
    const settings = new Settings(page);
    await settings.expectLoaded();
    await settings.section('Projects');
    const dialog = await settings.archiveProject(project.name);
    const notice = dialog.getByRole('alert').filter({ hasText: 'This project has an active run' });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('A project cannot be archived while a run has not ended.');
    await expect(notice).toContainText('Nothing was changed.');
    await expect(notice.getByRole('list', { name: 'Active runs' }).getByRole('link')).toHaveCount(1);
    await expect(notice.getByRole('list', { name: 'Active runs' }).getByRole('link')).toHaveAttribute('href', new RegExp(`${runId}$`));
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    // Still not archived.
    await expect(settings.projectsSection().getByText('This project is archived')).toHaveCount(0);
  });
});
