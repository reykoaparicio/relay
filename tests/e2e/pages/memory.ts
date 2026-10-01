// 12 §L3 Project memory (10 J9) page object: role / label / text locators from MemoryPage and features/memory/*
// (AddRuleDialog, MemoryDetail, MemoryEditForm, SuggestionCard, ConflictResolver).
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { Shell } from './shell.js';

export type MemoryTabName = 'Approved' | 'Suggested' | 'Archived';

export interface NewRule {
  readonly title: string;
  readonly content: string;
  readonly pinned?: boolean;
}

export class Memory {
  constructor(readonly page: Page) {}

  async expectLoaded(): Promise<void> {
    await expect(this.page.getByRole('heading', { level: 1, name: 'Project memory' })).toBeVisible();
  }

  /** A status tab; its accessible name carries the count ("Approved (2)"). */
  tab(name: MemoryTabName): Locator {
    return this.page.getByRole('tablist', { name: 'Filter records by status' }).getByRole('tab', { name: new RegExp(`^${name}\\b`) });
  }

  async openTab(name: MemoryTabName): Promise<void> {
    await this.tab(name).click();
    await expect(this.tab(name)).toHaveAttribute('aria-selected', 'true');
  }

  /** The record list of the Approved / Archived tab. */
  records(tab: Exclude<MemoryTabName, 'Suggested'>): Locator {
    return this.page.getByRole('list', { name: `${tab} records` });
  }

  /** A record card (a button) in a list, by title. */
  record(tab: Exclude<MemoryTabName, 'Suggested'>, title: string): Locator {
    return this.records(tab).getByRole('button', { name: new RegExp(`^${escape(title)}`) });
  }

  /** The detail panel of the selected record (a region named by its title). */
  detail(title: string): Locator {
    return this.page.getByRole('region', { name: title, exact: true });
  }

  // ---- add rule ----------------------------------------------------------------------------------------------------

  ruleDialog(): Locator {
    return this.page.getByRole('dialog', { name: 'Add project rule' });
  }

  async openAddRule(): Promise<Locator> {
    await this.page.getByRole('main').locator('header').getByRole('button', { name: 'Add project rule' }).click();
    const dialog = this.ruleDialog();
    await expect(dialog).toBeVisible();
    return dialog;
  }

  ruleFields(dialog: Locator = this.ruleDialog()): { title: Locator; content: Locator; pinned: Locator } {
    return {
      title: dialog.getByRole('textbox', { name: 'Title' }),
      content: dialog.getByRole('textbox', { name: 'Rule' }),
      pinned: dialog.getByRole('checkbox', { name: /^Pin: always include/ }),
    };
  }

  /** Fills and submits "Add project rule". Does not wait for the outcome (success closes the dialog). */
  async submitRule(rule: NewRule): Promise<Locator> {
    const dialog = await this.openAddRule();
    const f = this.ruleFields(dialog);
    await f.title.fill(rule.title);
    await f.content.fill(rule.content);
    if (rule.pinned === true) await f.pinned.check();
    await dialog.getByRole('button', { name: 'Add rule', exact: true }).click();
    return dialog;
  }

  /** Adds an approved rule and waits for it to be selected in the Approved list. */
  async addRule(rule: NewRule): Promise<void> {
    const dialog = await this.submitRule(rule);
    await expect(dialog).toBeHidden();
    await expect(this.tab('Approved')).toHaveAttribute('aria-selected', 'true');
    await expect(this.record('Approved', rule.title)).toBeVisible();
  }

  // ---- edit --------------------------------------------------------------------------------------------------------

  /** The open edit form ("Edit: <title>"; the title follows the latest saved revision). */
  editForm(): Locator {
    return this.page.getByRole('region', { name: /^Edit: / });
  }

  async startEdit(title: string): Promise<Locator> {
    await this.record('Approved', title).click();
    await this.detail(title).getByRole('button', { name: 'Edit', exact: true }).click();
    const form = this.editForm();
    await expect(form).toBeVisible();
    return form;
  }

  /** The revision-conflict comparison table of the edit form. */
  conflictTable(form: Locator): Locator {
    return form.getByRole('table', { name: 'Saved revision compared with your edit' });
  }

  keepMyChanges(form: Locator): Locator {
    return form.getByRole('button', { name: /^Keep my changes and save over revision \d+$/ });
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------

  async archive(title: string): Promise<void> {
    await this.record('Approved', title).click();
    await this.detail(title).getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(this.toast(`Archived “${title}”`)).toBeVisible();
  }

  async restore(title: string): Promise<void> {
    await this.openTab('Archived');
    await this.record('Archived', title).click();
    await this.detail(title).getByRole('button', { name: 'Restore to approved' }).click();
  }

  /** Opens "Delete…" on a record; returns the confirm dialog. */
  async openDelete(tab: Exclude<MemoryTabName, 'Suggested'>, title: string): Promise<Locator> {
    await this.record(tab, title).click();
    await this.detail(title).getByRole('button', { name: 'Delete…' }).click();
    const dialog = this.page.getByRole('alertdialog', { name: `Delete “${title}”?` }).or(this.page.getByRole('dialog', { name: `Delete “${title}”?` }));
    await expect(dialog).toBeVisible();
    return dialog;
  }

  // ---- suggestions -------------------------------------------------------------------------------------------------

  suggestion(title: string): Locator {
    return this.page.getByRole('article', { name: title, exact: true });
  }

  async approveSuggestion(title: string): Promise<void> {
    await this.suggestion(title).getByRole('button', { name: 'Approve', exact: true }).click();
  }

  toast(title: string): Locator {
    return new Shell(this.page).toast(title);
  }
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
