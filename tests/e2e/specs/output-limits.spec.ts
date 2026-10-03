import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures.js';
import { setupOwnProject } from '../flows.js';
import { NewRun, Runs } from '../pages/app-pages.js';
import { dollars } from '../pages/run-inspector.js';
import { Shell } from '../pages/shell.js';

const GOAL = 'Validate the user id parameter in the user handler.';

/** The "First reservation" amount of the New run Input summary (`<dt>` term → its `<dd>`). */
function firstReservation(page: Page): Locator {
  return page
    .getByRole('region', { name: 'Input summary' })
    .getByRole('term')
    .filter({ hasText: /^First reservation$/ })
    .locator('xpath=following-sibling::dd[1]');
}

async function reservationDollars(page: Page): Promise<number> {
  return dollars(await firstReservation(page).textContent());
}

// Decision 3: per-step output limits on New run, checked by the real engine preflight (`stepLimits`,
// `outputTokenOverrides`). The first reservation is for the first model step, so its limit moves N.
test.describe('per-step output limits', { tag: '@m2' }, () => {
  test('a per-step output override changes the first reservation shown', async ({ page, stubDialogs, project }) => {
    await setupOwnProject(page, stubDialogs, project);
    await new Shell(page).nav('Runs');
    const runs = new Runs(page);
    await runs.expectLoaded();
    await runs.startWorkflow();
    const form = new NewRun(page);
    await form.expectLoaded();
    await form.fillGoal(GOAL);
    await form.expectReady();

    // Every model step has an editable limit, labelled by its step name and prefilled with its default.
    const limits = form.form().getByRole('spinbutton', { name: /^Max output tokens for / });
    await expect(limits.first()).toBeVisible();
    const first = limits.first();
    const defaultText = await first.inputValue();
    expect(Number(defaultText)).toBeGreaterThan(0);
    await expect(first).toHaveAccessibleDescription(/^256–[\d,]+/);
    const before = await reservationDollars(page);
    expect(before).toBeGreaterThan(0);

    // Raising the first model step's limit (template default 8,000) to 32,000, within every catalog model's range,
    // raises the first reservation (estimated input + max output).
    expect(Number(defaultText)).toBeLessThan(32_000);
    await first.fill('32000');
    await expect(form.form().getByRole('button', { name: 'Reset all to defaults' })).toBeVisible();
    await expect.poll(async () => reservationDollars(page)).toBeGreaterThan(before);
    await form.expectReady();

    // Back to the default: the reservation returns to what it was.
    await form.form().getByRole('button', { name: 'Reset all to defaults' }).click();
    await expect(first).toHaveValue(defaultText);
    await expect.poll(async () => reservationDollars(page)).toBe(before);

    // An out-of-range value is flagged at the field.
    await first.fill('100');
    await expect(first).toHaveAttribute('aria-invalid', 'true');
    await expect(first).toHaveAccessibleDescription(/Must be at least 256\./);
  });
});
