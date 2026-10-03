// E2 #11 (R2): a project file whose content looks like a credential is flagged in the New run picker, left out by
// default, and included only after an explicit confirmation (`input.acknowledgedSuspectedSecrets`). The marker is a
// fake Anthropic-shaped string written into the per-test project copy (fixtures.ts); it is never a real key.
import { test, expect, FIXTURE_SUSPECTED_SECRET, FIXTURE_SUSPECTED_SECRET_FILE } from '../fixtures.js';
import { setupOwnProject } from '../flows.js';
import { NewRun, Runs } from '../pages/app-pages.js';
import { Shell } from '../pages/shell.js';

const GOAL = 'Validate the user id parameter in the user handler.';

test.use({ projectSuspectedSecret: true });

test.describe('file safety', { tag: '@m2' }, () => {
  test('a suspected secret is flagged and unticked; ticking it asks to confirm; the value is never shown', async ({
    page,
    stubDialogs,
    project,
  }) => {
    await setupOwnProject(page, stubDialogs, project);
    await new Shell(page).nav('Runs');
    await new Runs(page).startWorkflow();
    const form = new NewRun(page);
    await form.expectLoaded();
    await form.fillGoal(GOAL);

    const box = form.form().getByRole('checkbox', { name: FIXTURE_SUSPECTED_SECRET_FILE, exact: true });
    await expect(box).not.toBeChecked();
    await expect(form.form()).toContainText('Looks like it contains a secret: Anthropic API key, line 2');
    await expect(page.getByText(FIXTURE_SUSPECTED_SECRET)).toHaveCount(0);
    // Left out, the run is ready to start.
    await form.expectReady();

    // Ticking asks first; "Do not send it" leaves it out.
    await box.click();
    const dialog = page.getByRole('dialog', { name: /^Send this file to / });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(FIXTURE_SUSPECTED_SECRET_FILE);
    await dialog.getByRole('button', { name: 'Do not send it' }).click();
    await expect(dialog).toBeHidden();
    await expect(box).not.toBeChecked();

    // Confirmed: ticked and acknowledged, and the preflight raises no suspected-secret problem.
    await box.click();
    await page.getByRole('dialog', { name: /^Send this file to / }).getByRole('button', { name: 'Send this file' }).click();
    await expect(box).toBeChecked();
    await expect(form.form()).toContainText('You confirmed sending it.');
    await form.expectReady();
    await expect(page.getByText(FIXTURE_SUSPECTED_SECRET)).toHaveCount(0);

    // Unticking drops the confirmation; the run starts without the file.
    await box.uncheck();
    await expect(box).not.toBeChecked();
    await form.expectReady();
    await form.submit();
    await expect(page).toHaveURL(/#\/p\/[^/]+\/runs\/run_[^/?]+$/);
  });
});
