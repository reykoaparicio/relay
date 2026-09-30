import { test, expect, FIXTURE_ENV_SECRET } from '../fixtures.js';
import { RunInspector } from '../pages/app-pages.js';
import { Onboarding } from '../pages/onboarding.js';
import { Shell } from '../pages/shell.js';

const KEY = 'sk-ant-e2e-ABCDEFGHIJKLMNOP';
const REDACTED = 'sk-…MNOP';
const SECRET_VALUE = FIXTURE_ENV_SECRET.split('=')[1] ?? FIXTURE_ENV_SECRET;

// The committed fixture has no `.env`; the per-test copy gets one so the secret exclusion is exercised.
test.use({ projectEnvSecret: true });

test.describe('onboarding', { tag: '@m1' }, () => {
  test('first-run setup: fake key stays out of the DOM, excluded reasons shown, run starts', async ({
    page,
    stubDialogs,
    project,
    callLog,
  }) => {
    const ob = new Onboarding(page);
    await ob.startWithOwnFolder();

    // FR-02: connect with a fake key; only the redacted label is shown and the key never reaches the DOM.
    await ob.connectProvider('Anthropic', KEY, 'session');
    await expect(ob.connectOutcome('Anthropic')).toContainText(REDACTED);
    await expect(page.getByRole('textbox', { name: 'Anthropic API key' })).toHaveValue('');
    expect(await page.content()).not.toContain(KEY);
    await expect(new Shell(page).providerStatus()).toHaveText('1 provider connected');
    await ob.continue();

    // FR-01: select the project copy; the preview lists excluded files with their reason as text.
    await ob.expectStep('Select the project folder');
    await stubDialogs({ directory: project.dir });
    await ob.chooseFolder();
    await expect(ob.fileTree()).toBeVisible();
    await expect(ob.fileRow('.env')).toContainText(/Excluded: .*secret/i);
    await expect(ob.fileRow('node_modules')).toContainText(/Excluded: Dependency/i);
    await expect(ob.fileRow('assets/logo.png')).toContainText(/Excluded: Binary/i);
    await expect(ob.fileRow('src/handlers/user.ts')).not.toContainText('Excluded');
    await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue(project.name);
    await ob.continue('Create project and continue');

    // Project rule (memory.create may still be stubbed in M1: then the graceful notice is asserted and skipped).
    const rule = await ob.addRule('Preserve the existing public response format');
    test.info().annotations.push({ type: 'project-rule', description: rule });

    await ob.expectStep('Choose a workflow template');
    await expect(page.getByRole('radio', { name: /Review and propose a fix · v1/ })).toBeChecked();
    await ob.continue();

    await ob.expectStep('Pick role profiles and a run allowance');
    await ob.setAllowance('$3.00');
    await ob.continue();

    await ob.expectStep('Review the input and start');
    await ob.fillGoal('Reject invalid request values consistently, without changing the public response format.');
    const review = ob.step('Review the input and start');
    await expect(review.getByRole('definition').filter({ hasText: '$3.00' })).toBeVisible();
    await expect(review.getByText('Excluded files such as .env are never sent.')).toBeVisible();
    await expect(review.getByRole('listitem').filter({ hasText: /^Anthropic:/ })).toBeVisible();
    await ob.startButton().click();

    // Lands on the run inspector (a placeholder in M1).
    await new RunInspector(page).expectLoaded();
    await expect(page).toHaveURL(/#\/p\/prj_[^/]+\/runs\/run_[^/]+$/);

    const html = await page.content();
    expect(html).not.toContain(KEY);
    expect(html).not.toContain(SECRET_VALUE);
    // The fake provider really ran (review, plan) and never saw the key or the .env value.
    await expect.poll(async () => (await callLog()).map((c) => c.stepKey)).toEqual(expect.arrayContaining(['review']));
    expect(JSON.stringify(await callLog())).not.toContain(KEY);
  });
});
