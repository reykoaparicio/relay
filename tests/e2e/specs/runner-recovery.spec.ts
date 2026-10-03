// E2 #3/#4 (R2): the runner cannot open a damaged database → the shell banner explains it in plain words and offers
// "Restore latest backup"; the restore moves the damaged files aside (never deletes them) and the app works again.
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '../fixtures.js';
import { setupOwnProject } from '../flows.js';
import { Overview, Settings } from '../pages/app-pages.js';
import { Shell } from '../pages/shell.js';

test.describe('runner recovery', { tag: '@m4' }, () => {
  test('a damaged database: banner with the reason → restore the latest backup (confirmed) → the project is back', async ({
    page,
    stubDialogs,
    project,
    relaunch,
    closeApp,
    userDataDir,
  }) => {
    test.setTimeout(180_000);
    await setupOwnProject(page, stubDialogs, project);

    // A backup of the healthy database.
    await new Shell(page).nav('Settings');
    const settings = new Settings(page);
    await settings.expectLoaded();
    await settings.section('Storage & data');
    await page.getByRole('button', { name: 'Create backup' }).click();
    await expect(page.getByText('Backup created')).toBeVisible();

    // Damage the database while Relay is closed (single files of this test's own userData; nothing recursive).
    await closeApp();
    const dbFile = path.join(userDataDir, 'relay.sqlite');
    await writeFile(dbFile, Buffer.alloc(8192, 0x5a));
    for (const side of ['relay.sqlite-wal', 'relay.sqlite-shm']) await rm(path.join(userDataDir, side), { force: true });

    const page2 = await relaunch();
    const banner = page2.getByRole('main').locator('.banner').filter({ hasText: 'The background runner is unavailable' });
    await expect(banner).toBeVisible({ timeout: 60_000 });
    await expect(banner).toContainText(/The Relay database (file is damaged|failed its integrity check)/);
    await expect(banner.getByRole('button', { name: 'Restart runner' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Quit and relaunch' })).toBeVisible();

    await banner.getByRole('button', { name: 'Restore latest backup' }).click();
    const dialog = page2.getByRole('dialog', { name: 'Restore the latest backup?' });
    await expect(dialog).toContainText('moved aside');
    await expect(dialog).toContainText('not deleted');
    await dialog.getByRole('button', { name: 'Restore backup' }).click();

    await expect(page2.getByText('Backup restored').first()).toBeVisible({ timeout: 60_000 });
    // Where the damaged data went (moved aside, not deleted).
    await expect(page2.getByText(/The damaged data was moved to .* Nothing was deleted\./).first()).toBeVisible();
    await expect(banner).toBeHidden({ timeout: 30_000 });

    // The restored database has the project again.
    await page2.goto(page2.url().replace(/#.*$/, '#/'));
    await new Overview(page2).expectLoaded();
    await expect(new Shell(page2).activeProject()).toContainText(project.name);
  });
});
