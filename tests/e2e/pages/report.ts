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
    return this.page.getByRole('main').locator('header .status-line');
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

  /** Export both files; the "Export saved" toast confirms it (the export dir must already be stubbed). */
  async exportBoth(): Promise<void> {
    await this.page.getByRole('main').locator('header').getByRole('button', { name: 'Export…' }).click();
    const dialog = this.page.getByRole('dialog', { name: 'Export the run' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: /^Both/ }).check();
    await dialog.getByRole('button', { name: 'Export 2 files', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(this.page.getByText('Export saved')).toBeVisible();
  }

  /** Report.v1 approvals: one list item per approval the run opened. */
  approvals(): Locator {
    return this.section('Approvals').getByRole('listitem');
  }

  revisions(): Locator {
    return this.section('Revisions');
  }

  /** The value next to a Revisions term ("Quality revision cycles", "Plan revisions", …). */
  revisionsValue(term: string): Locator {
    return this.revisions()
      .getByRole('term')
      .filter({ hasText: new RegExp(`^${term}$`) })
      .locator('xpath=following-sibling::dd[1]');
  }
}
