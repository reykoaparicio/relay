// 12 §L3 page objects for Overview, Runs, New run, Run inspector (M1 placeholder) and Settings.
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/** Project overview (10 J4). */
export class Overview {
  constructor(readonly page: Page) {}

  async expectLoaded(): Promise<void> {
    await expect(this.page.getByRole('heading', { level: 1, name: 'Project overview' })).toBeVisible();
  }

  attentionCard(): Locator {
    return this.page.getByRole('region', { name: 'Needs your attention' });
  }

  recentRuns(): Locator {
    return this.page.getByRole('region', { name: 'Recent runs' });
  }

  summary(): Locator {
    return this.page.getByRole('region', { name: 'Project summary' });
  }

  async startWorkflow(): Promise<void> {
    await this.page.getByRole('main').getByRole('link', { name: 'Start a workflow' }).first().click();
  }
}

export const RUNS_COLUMNS = ['Run', 'Goal', 'Workflow version', 'Status', 'Steps', 'Tracked cost', 'Started', 'Duration'] as const;
export type RunsColumn = (typeof RUNS_COLUMNS)[number];

/** Run history (10 J7 list). */
export class Runs {
  constructor(readonly page: Page) {}

  async expectLoaded(): Promise<void> {
    await expect(this.page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
  }

  table(): Locator {
    return this.page.getByRole('table', { name: /^Runs in / });
  }

  /** Data rows (the header row excluded). */
  rows(): Locator {
    return this.table().getByRole('row').filter({ has: this.page.getByRole('cell') });
  }

  row(goal: string | RegExp): Locator {
    return this.rows().filter({ hasText: goal });
  }

  /** A row's cell under a column header (the first column is a row header). */
  columnCell(row: Locator, header: RunsColumn): Locator {
    return row.getByRole('rowheader').or(row.getByRole('cell')).nth(RUNS_COLUMNS.indexOf(header));
  }

  costCell(row: Locator): Locator {
    return this.columnCell(row, 'Tracked cost');
  }

  statusCell(row: Locator): Locator {
    return this.columnCell(row, 'Status');
  }

  /** Asserts the table's header order matches {@link RUNS_COLUMNS}. */
  async expectColumns(): Promise<void> {
    await expect(this.table().getByRole('columnheader')).toHaveText([...RUNS_COLUMNS]);
  }

  async startWorkflow(): Promise<void> {
    await this.page.getByRole('main').getByRole('link', { name: 'Start a workflow' }).first().click();
  }
}

/** New run form (10 J7, §4.2). */
export class NewRun {
  constructor(readonly page: Page) {}

  form(): Locator {
    return this.page.getByRole('form', { name: 'New run' });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.page.getByRole('heading', { level: 1, name: 'Start a workflow' })).toBeVisible();
    await expect(this.form().getByRole('textbox', { name: 'Goal' })).toBeVisible();
  }

  async fillGoal(goal: string): Promise<void> {
    await this.form().getByRole('textbox', { name: 'Goal' }).fill(goal);
  }

  async setAllowance(dollars: string): Promise<void> {
    await this.form().getByLabel('Run allowance (USD)').fill(dollars.replace(/^\$/, ''));
  }

  /** Limits card (bounded by RUN_LIMIT_MAXIMUMS). */
  async setLimits(o: { maxAttempts?: number; revisionCycles?: number; timeoutMinutes?: number }): Promise<void> {
    const f = this.form();
    if (o.maxAttempts !== undefined) await f.getByLabel('Max attempts (run)').fill(String(o.maxAttempts));
    if (o.revisionCycles !== undefined) await f.getByLabel('Revision cycles').fill(String(o.revisionCycles));
    if (o.timeoutMinutes !== undefined) await f.getByLabel('Timeout (minutes)').fill(String(o.timeoutMinutes));
  }

  async expectReady(): Promise<void> {
    await expect(this.page.getByText('All checks passed. Ready to start.')).toBeVisible();
  }

  async submit(): Promise<void> {
    await this.form().getByRole('button', { name: 'Start run' }).click();
  }
}

/** Run inspector (J8): see ./run-inspector.ts. */
export { RunInspector } from './run-inspector.js';

export type StorageMode = 'keychain' | 'session';

export type SettingsSectionName = 'Providers' | 'Model profiles' | 'Projects' | 'Storage & data' | 'Diagnostics' | 'About';

/** Settings (10 J10). */
export class Settings {
  constructor(readonly page: Page) {}

  async expectLoaded(): Promise<void> {
    await expect(this.page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  }

  async section(name: SettingsSectionName): Promise<void> {
    await this.page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name, exact: true }).click();
  }

  /** Diagnostics key/value by its term ("Runner heartbeat", "Database schema", "Provider mode", …). */
  diagnosticsValue(term: string): Locator {
    // <dt>term</dt><dd>value</dd>: the definition that follows the term.
    return this.page
      .getByRole('region', { name: 'Diagnostics' })
      .getByRole('term')
      .filter({ hasText: new RegExp(`^${term}$`) })
      .locator('xpath=following-sibling::dd[1]');
  }

  /**
   * Reads Diagnostics → Credential storage: 'keychain' when OS protection (safeStorage) is available on this machine,
   * otherwise 'session' (keys can only be kept in memory). Leaves the page on the Diagnostics section.
   */
  async preferredStorage(): Promise<{ mode: StorageMode; text: string }> {
    await this.section('Diagnostics');
    const value = this.diagnosticsValue('Credential storage');
    await expect(value).toHaveText(/^(Available|Unavailable) · /);
    const text = (await value.textContent()) ?? '';
    return { mode: text.startsWith('Available') ? 'keychain' : 'session', text };
  }

  static storageText(mode: StorageMode): string {
    return mode === 'keychain' ? 'Stored with macOS Keychain protection (safeStorage)' : 'Memory only · cleared when Relay quits';
  }

  /**
   * Clicks "Test connection" and asserts the outcome: a passed test shows latency and cost; while `providers.test` is
   * still stubbed (INTERNAL not_implemented) the card shows the graceful "Not available yet" notice instead.
   */
  async testAndExpectOutcome(displayName: string): Promise<'passed' | 'not_available'> {
    await this.test(displayName);
    const card = this.providerCard(displayName);
    const passed = card.getByText(/^Test request to /);
    const notAvailable = card.getByText('Not available yet in this build');
    await expect(passed.or(notAvailable)).toBeVisible();
    if (await notAvailable.isVisible()) {
      await expect(card.getByText('The key is saved. Relay uses it when a run starts.')).toBeVisible();
      return 'not_available';
    }
    await expect(passed).toContainText(/\d+(\.\d+)?\s?m?s/);
    await expect(passed).toContainText(/\$\d/);
    return 'passed';
  }

  providerCard(displayName: string): Locator {
    return this.page.getByRole('region', { name: displayName, exact: true });
  }

  /** Card's "Key" value (redacted label). */
  providerKeyLabel(displayName: string): Locator {
    return this.providerCard(displayName).getByRole('definition').first();
  }

  async connect(displayName: string, key: string, mode: StorageMode): Promise<void> {
    const card = this.providerCard(displayName);
    await card.getByLabel(`${displayName} API key`).fill(key);
    if (mode === 'keychain') await card.getByRole('button', { name: 'Test and save to Keychain' }).click();
    else {
      const sessionOnly = card.getByRole('button', { name: 'Use for this session only' });
      if (await sessionOnly.count()) await sessionOnly.click();
      else await card.getByRole('button', { name: 'Test and use for this session' }).click();
    }
  }

  /** "Replace key" on a connected card, then save the new key for this session only. */
  async replaceKey(displayName: string, key: string): Promise<void> {
    const card = this.providerCard(displayName);
    await card.getByRole('button', { name: 'Replace key' }).click();
    await card.getByLabel(`Replacement ${displayName} API key`).fill(key);
    const sessionOnly = card.getByRole('button', { name: 'Use for this session only' });
    if (await sessionOnly.count()) await sessionOnly.click();
    else await card.getByRole('button', { name: 'Test and use for this session' }).click();
  }

  async test(displayName: string): Promise<void> {
    await this.providerCard(displayName).getByRole('button', { name: 'Test connection' }).click();
  }

  async disconnect(displayName: string): Promise<void> {
    await this.providerCard(displayName).getByRole('button', { name: 'Remove key' }).click();
    const dialog = this.page.getByRole('alertdialog').or(this.page.getByRole('dialog'));
    await expect(dialog).toContainText(`Remove the ${displayName} key?`);
    await dialog.getByRole('button', { name: 'Remove key' }).click();
  }
}
