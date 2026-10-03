import { test, expect } from '../fixtures.js';
import { patchIpcReply, setupOwnProject } from '../flows.js';
import { Settings } from '../pages/app-pages.js';
import { Shell } from '../pages/shell.js';
import { WorkflowEditor } from '../pages/workflow-editor.js';

// Workflow editor (§5.3, 10 J10): draft → save → validate → publish, and the profile_in_use guard in Settings.
const WORKFLOW = 'Review and propose a fix';

test.describe('workflow editor', { tag: '@m4' }, () => {
  test('edit + save a draft; Publish is disabled while dirty; publishing shows its capability-warning banner', async ({
    page,
    stubDialogs,
    project,
  }) => {
    await setupOwnProject(page, stubDialogs, project);
    const editor = new WorkflowEditor(page);
    await editor.open();
    await expect(editor.versionLabel()).toHaveText(/Version 1$/);
    await expect(editor.status()).toHaveText('Validated');
    await expect(editor.saveButton()).toBeDisabled();

    // Edit → dirty → Save draft → draft revision 1 based on v1.
    const attempts = editor.limitField('Max attempts (run)');
    await expect(attempts).toHaveValue('10');
    await attempts.fill('8');
    await expect(editor.status()).toHaveText('Draft, unsaved changes');
    await editor.save();
    await expect(new Shell(page).toast('Draft revision 1 saved')).toBeVisible();
    await expect(editor.versionLabel()).toHaveText(/Draft revision 1 · based on v1$/);
    await expect(editor.status()).toHaveText('Draft, not validated');
    await expect(attempts).toHaveValue('8');

    // Validate → "Draft revision 1 is valid" with Publish as v2.
    await editor.validate();
    await expect(editor.validAlert()).toBeVisible();
    await expect(editor.publishButton()).toHaveAccessibleName('Publish as v2');
    await expect(editor.publishButton()).toBeEnabled();

    // An unsaved edit disables Publish (it would publish the saved draft, not the form) and says why.
    await attempts.fill('9');
    await expect(editor.publishButton()).toBeDisabled();
    await expect(editor.validAlert()).toContainText('Publishing is unavailable while you have unsaved changes.');
    await expect(editor.publishButton()).toHaveAccessibleDescription(/Publishing is unavailable while you have unsaved changes/);
    await attempts.fill('8');
    await expect(editor.publishButton()).toBeEnabled();

    // Publish → banner names v2 and lists the capability warnings, or says there are none.
    await editor.publishButton().click();
    const banner = editor.publishedBanner();
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('v2 validated — new runs will snapshot v2; active runs keep their version.');
    await expect(banner).toContainText(/No capability warnings\.|\d+ capability warnings?:/);
    await expect(banner.getByRole('link', { name: 'Start a run with v2' })).toBeVisible();
    await expect(editor.versionLabel()).toHaveText(/Version 2$/);
    await expect(attempts).toHaveValue('8');
  });

  test('renaming a profile a workflow uses is refused with profile_in_use and a link to the workflow', async ({
    page,
    stubDialogs,
    project,
  }) => {
    await setupOwnProject(page, stubDialogs, project);
    await new Shell(page).nav('Settings');
    const settings = new Settings(page);
    await settings.expectLoaded();
    await settings.section('Model profiles');
    const form = await settings.editProfile('Economy');
    await form.getByRole('textbox', { name: 'Name' }).fill('Economy renamed');
    await form.getByRole('button', { name: /^Save revision \d+$/ }).click();

    const notice = form.getByRole('alert').filter({ hasText: 'This profile is used by workflows' });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(`Used by “${WORKFLOW}”`);
    await expect(notice).toContainText('Nothing was changed.');
    await expect(notice).toContainText('CONFLICT');
    const link = notice.getByRole('list', { name: 'Workflows using this profile' }).getByRole('link', { name: new RegExp(`^${WORKFLOW}`) });
    await expect(link).toBeVisible();
    // The profile kept its name.
    await expect(settings.profilesSection().getByRole('rowheader', { name: 'Economy', exact: true })).toBeVisible();

    await link.click();
    const editor = new WorkflowEditor(page);
    await editor.expectLoaded();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(WORKFLOW);
  });

  test('locked limits show the run allowance read-only', async ({ app, page, stubDialogs, project }) => {
    await setupOwnProject(page, stubDialogs, project);
    // The P0 runner always answers `editable.limits: true`; the locked state is forced in MAIN for this test only.
    await patchIpcReply(app, 'relay/v1/workflows.get', { editable: { limits: false } });
    await page.reload(); // drop any workflows.get already cached by the renderer
    const editor = new WorkflowEditor(page);
    await editor.open();
    const allowance = editor.limitField('Run allowance (USD)');
    await expect(allowance).toHaveValue('3.00');
    await expect(allowance).toHaveAttribute('readonly', '');
    await expect(allowance).not.toBeEditable();
    await expect(allowance).toHaveAccessibleDescription(/Locked for this version\./);
    for (const label of ['Revision cycles', 'Max attempts (run)', 'Timeout (minutes)'] as const) {
      await expect(editor.limitField(label)).not.toBeEditable();
    }
    await expect(editor.saveButton()).toBeDisabled();
  });
});
