// E2 #7 (R2): a project folder that was moved → "Project folder not found" on Overview → "Locate folder…" (stubbed
// folder dialog) → Relay cannot verify the new folder (no earlier files) → the user confirms → the project works again.
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '../fixtures.js';
import { setupOwnProject } from '../flows.js';
import { Overview } from '../pages/app-pages.js';

test.describe('missing project folder', { tag: '@m4' }, () => {
  test('moved folder: Overview offers Locate folder…; an unverified folder is confirmed, then the project is back', async ({
    page,
    stubDialogs,
    project,
  }) => {
    await setupOwnProject(page, stubDialogs, project);
    const moved = path.join(path.dirname(project.dir), `${project.name}-moved`);
    // Move the folder (a rename: nothing is deleted); it is moved back before the fixture re-hashes it.
    await rename(project.dir, moved);
    try {
      await page.reload();
      const overview = new Overview(page);
      await overview.expectLoaded();
      const panel = page.getByRole('main').locator('.banner').filter({ hasText: 'Project folder not found' });
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel).toContainText(project.name);

      await stubDialogs({ directory: moved });
      await panel.getByRole('button', { name: 'Locate folder…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Use this folder anyway?' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Relay has no earlier files of this project to compare with this folder.');
      await dialog.getByRole('button', { name: 'Use this folder' }).click();
      await expect(page.getByText(/^Project folder updated: /).first()).toBeVisible();
      await expect(panel).toBeHidden();
    } finally {
      await rename(moved, project.dir);
    }
  });
});
