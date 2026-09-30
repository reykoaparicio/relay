import { test, expect } from '../fixtures.js';
import type { PerfMeasure } from '../fixtures.js';
import { setupOwnProject, startRunViaNewRun } from '../flows.js';
import { Overview, Runs, Settings } from '../pages/app-pages.js';
import { Shell } from '../pages/shell.js';
import type { NavName } from '../pages/shell.js';

const GOAL = 'Check that navigation stays responsive during a slow review.';
const ROUTE_BUDGET_MS = 1000;

// §6.4: the provider call runs in the runner process, so the UI keeps navigating while it is in flight.
// slow-review: the review call takes 5 s (04 §D7), which keeps the run "Running" long enough to observe.
test.use({ scenario: 'slow-review' });

/** Duration of the most recent measure named `name`. */
function latestDuration(measures: readonly PerfMeasure[], name: string): number {
  const m = measures.filter((x) => x.name === name).at(-1);
  if (m === undefined) throw new Error(`no ${name} measure`);
  return m.duration;
}

test.describe('responsiveness', { tag: '@m1' }, () => {
  test('every route renders in < 1 s while the review call is in flight', async ({
    page,
    stubDialogs,
    project,
    perfMeasures,
    callLog,
  }, testInfo) => {
    await setupOwnProject(page, stubDialogs, project);
    await startRunViaNewRun(page, GOAL);

    const shell = new Shell(page);
    await shell.nav('Runs');
    const runs = new Runs(page);
    await runs.expectLoaded();
    const row = runs.row(GOAL);
    await expect(runs.statusCell(row)).toContainText('Running');
    // The review call has been dispatched and has not returned (plan not called yet).
    await expect.poll(async () => (await callLog()).map((c) => c.stepKey)).toEqual(['review']);

    const routes: { nav: NavName; route: string; ready: () => Promise<void> }[] = [
      { nav: 'Memory', route: 'memory', ready: () => expect(page.getByRole('heading', { level: 1, name: 'Project memory' })).toBeVisible() },
      { nav: 'Settings', route: 'settings', ready: () => new Settings(page).expectLoaded() },
      { nav: 'Overview', route: 'overview', ready: () => new Overview(page).expectLoaded() },
      { nav: 'Runs', route: 'runs', ready: async () => { await runs.expectLoaded(); await expect(row).toBeVisible(); } },
    ];
    const results: { route: string; duration: number }[] = [];
    for (const r of routes) {
      const before = (await perfMeasures()).filter((m) => m.name === `relay:nav:${r.route}`).length;
      await shell.nav(r.nav);
      await r.ready();
      await expect.poll(async () => (await perfMeasures()).filter((m) => m.name === `relay:nav:${r.route}`).length).toBe(before + 1);
      results.push({ route: r.route, duration: latestDuration(await perfMeasures(), `relay:nav:${r.route}`) });
    }

    // Every navigation happened while the review call was still in flight.
    await expect(runs.statusCell(row)).toContainText('Running');
    expect((await callLog()).map((c) => c.stepKey)).toEqual(['review']);

    await testInfo.attach('nav-during-provider-call', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    for (const r of results) expect(r.duration, `relay:nav:${r.route}`).toBeLessThan(ROUTE_BUDGET_MS);

    // The run then proceeds to its approval checkpoint.
    await expect(runs.statusCell(row)).toContainText('Awaiting your approval', { timeout: 20_000 });
  });
});
