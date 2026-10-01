import { test, expect } from '../fixtures.js';
import { setupOwnProject } from '../flows.js';
import { Overview, Runs, Settings } from '../pages/app-pages.js';
import { Shell } from '../pages/shell.js';

test.describe('smoke', { tag: '@m1' }, () => {
  test('launches with a ready runner, fake providers, diagnostics and nav perf marks', async ({
    page,
    stubDialogs,
    project,
    perfMeasures,
  }, testInfo) => {
    await expect(page).toHaveTitle('Relay');
    const shell = new Shell(page);
    await expect(shell.fakeProviderBadge()).toBeVisible();
    await expect(shell.runnerBanner()).toBeHidden();

    // First launch lands in setup; create a project from the per-test copy so every nav item exists.
    await setupOwnProject(page, stubDialogs, project);

    // Diagnostics: runner healthy, schema current (no pending migrations), provider mode fake.
    await shell.nav('Settings');
    const settings = new Settings(page);
    await settings.expectLoaded();
    await settings.section('Diagnostics');
    await expect(settings.diagnosticsValue('Runner heartbeat')).toContainText('Healthy');
    await expect(settings.diagnosticsValue('Runner heartbeat')).toContainText(/Last beat/);
    await expect(settings.diagnosticsValue('Database schema')).toContainText(/^Version \d+ · current/);
    await expect(settings.diagnosticsValue('Provider mode')).toHaveText(
      'Fake providers · scenario happy-path (no real requests)',
    );

    // Overview → Runs → Settings, recording the nav measures as a timing baseline.
    await shell.nav('Overview');
    await new Overview(page).expectLoaded();
    await shell.nav('Runs');
    const runs = new Runs(page);
    await runs.expectLoaded();
    await expect(page.getByRole('heading', { name: 'No runs yet' })).toBeVisible();
    await shell.nav('Settings');
    await settings.expectLoaded();

    await expect
      .poll(async () => (await perfMeasures()).map((m) => m.name))
      .toEqual(expect.arrayContaining(['relay:nav:overview', 'relay:nav:runs', 'relay:nav:settings', 'relay:history-loaded']));
    const measures = await perfMeasures();
    await testInfo.attach('perf-marks', { body: JSON.stringify(measures, null, 2), contentType: 'application/json' });
    for (const m of measures) expect(m.duration, m.name).toBeGreaterThanOrEqual(0);
  });
});
