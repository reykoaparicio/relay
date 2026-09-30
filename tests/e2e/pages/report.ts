// 12 §L3 Run report (10 J8 report.html) page object: role / label / text locators from ReportPage and
// features/report/ReportSections.
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

export type ExportChoice = 'Report (Markdown)' | 'Patch (.patch)' | 'Both';

export class Report {
  constructor(readonly page: Page) {}

  async expectLoaded(): Promise<void> {
    await expect(this.page.getByRole('heading', { level: 1, name: 'Run report' })).toBeVisible();
    await expect(this.page.getByRole('tablist', { name: 'Report sections' })).toBeVisible();
  }

  status(): Locator {
    return this.page.getByRole('main').locator('header').getByRole('status');
  }

  section(title: string): Locator {
    return this.page.getByRole('region', { name: title, exact: true });
  }

  limitations(): Locator {
    return this.section('Limitations');
  }

  notModifiedBanner(): Locator {
    return this.page.getByText('Original project files were not modified.');
  }

  async expectNotModifiedBanner(): Promise<void> {
    await expect(this.notModifiedBanner()).toBeVisible();
  }

  async patchTab(): Promise<Locator> {
    await this.page
      .getByRole('tablist', { name: 'Report sections' })
      .getByRole('tab', { name: 'Patch' })
      .click();
    return this.page.getByRole('region', { name: 'Proposed patch' });
  }

  /** Header "Export…" → dialog "Export the run" → choice → Export. The export dir must already be stubbed. */
  async export(choice: ExportChoice): Promise<void> {
    await this.page.getByRole('main').locator('header').getByRole('button', { name: 'Export…' }).click();
    const dialog = this.page.getByRole('dialog', { name: 'Export the run' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: new RegExp(`^${choice.replace(/[().]/g, '\\$&')}`) }).check();
    await dialog
      .getByRole('button', { name: choice === 'Both' ? 'Export 2 files' : 'Export', exact: true })
      .click();
    await expect(dialog).toBeHidden();
  }

  /**
   * Export both files. Returns 'exported', or 'not_available' while `artifacts.exportTo` is still stubbed in the
   * runner (INTERNAL not_implemented): the dialog then turns into "Export failed" with the graceful notice, which
   * this asserts and closes.
   */
  async exportBoth(): Promise<'exported' | 'not_available'> {
    await this.page.getByRole('main').locator('header').getByRole('button', { name: 'Export…' }).click();
    const dialog = this.page.getByRole('dialog', { name: 'Export the run' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: /^Both/ }).check();
    await dialog.getByRole('button', { name: 'Export 2 files', exact: true }).click();
    const failed = this.page.getByRole('dialog', { name: 'Export failed' });
    const saved = this.page.getByText('Export saved');
    await expect(saved.or(failed)).toBeVisible();
    if (await saved.isVisible()) return 'exported';
    await expect(failed.getByText('Not available yet in this build')).toBeVisible();
    await expect(failed.getByText('Run is intact; retry export only after updating Relay.')).toBeVisible();
    await failed.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(failed).toBeHidden();
    return 'not_available';
  }
}
