// 12 §L3 Run inspector (10 J8) page object: role / label / text locators from RunInspectorPage and
// features/run-inspector/* (StatusBanner, StepOutput, InspectorPanels, RunActionDialogs) and the ui/domain widgets
// (ApprovalCard, AttemptsTable, BudgetLedger, RecoveryPanel, StepTimeline, ResponsivePanels).
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/** The timeline titles of the review-propose-fix template (inspector-model STEP_TITLES). */
export type StepTitle = 'Review input' | 'Plan a fix' | 'Approve plan' | 'Produce patch' | 'Review patch';

export type PrimaryTabName = 'Output' | 'Context' | 'Attempts' | 'Events' | 'Ledger';
/** Below 1280 px the secondary panels join the tab strip (ResponsivePanels). */
export type SecondaryPanelName = 'Budget' | 'Context summary';

/** Rows of the BudgetLedger "tracked usage" table. */
export type LedgerBucket =
  | 'Reported by provider'
  | 'Calculated from usage'
  | 'Estimated'
  | 'Reserved (in flight)'
  | 'Unknown liability'
  | 'Allowance';

/** Parses the first "$1,234.56" amount in a text (Money renders "$0.12", "≈ $0.48 est."). */
export function dollars(text: string | null): number {
  const m = /\$([\d,]+(?:\.\d+)?)/.exec(text ?? '');
  if (m?.[1] === undefined) throw new Error(`no dollar amount in ${JSON.stringify(text)}`);
  return Number(m[1].replaceAll(',', ''));
}

export class RunInspector {
  constructor(readonly page: Page) {}

  async expectLoaded(): Promise<void> {
    await expect(this.page.getByRole('heading', { level: 1, name: 'Run inspection' })).toBeVisible();
  }

  /** The run's id from the inspector route. */
  runId(): string {
    const id = /\/runs\/(run_[^/?]+)/.exec(this.page.url())?.[1];
    if (id === undefined) throw new Error(`not on a run route: ${this.page.url()}`);
    return id;
  }

  // ---- header ------------------------------------------------------------------------------------------------

  /** The live run status badge in the page header (PageHeader role=status). */
  status(): Locator {
    return this.page.getByRole('main').locator('header').getByRole('status');
  }

  async waitForStatus(text: string | RegExp, timeout = 30_000): Promise<void> {
    await expect(this.status()).toContainText(text, { timeout });
  }

  headerAction(name: string | RegExp): Locator {
    return this.page.getByRole('main').locator('header').getByRole('button', { name });
  }

  viewReportLink(): Locator {
    return this.page.getByRole('main').locator('header').getByRole('link', { name: 'View report' });
  }

  /** Header "Cancel run" → the best-effort confirmation dialog. Returns the dialog (not yet confirmed). */
  async openCancel(): Promise<Locator> {
    await this.headerAction('Cancel run').click();
    const dialog = this.page.getByRole('dialog', { name: 'Cancel this run?' });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  async cancel(): Promise<void> {
    const dialog = await this.openCancel();
    await dialog.getByRole('button', { name: 'Cancel run' }).click();
    await expect(dialog).toBeHidden();
  }

  async pause(): Promise<void> {
    await this.headerAction('Pause').click();
  }

  // ---- timeline ------------------------------------------------------------------------------------------------

  timeline(): Locator {
    return this.page.getByRole('list', { name: 'Run steps' });
  }

  /** Timeline rows of a step title (a retry / revision adds another row with the same title). */
  timelineStep(title: StepTitle): Locator {
    return this.timeline().getByRole('button', { name: new RegExp(`^${title}`) });
  }

  async selectStep(title: StepTitle): Promise<void> {
    await this.timelineStep(title).last().click();
    await expect(this.stepHeading()).toHaveText(title);
  }

  /** Heading of the selected step panel. */
  stepHeading(): Locator {
    return this.page.locator('#inspector-step-heading');
  }

  // ---- tabs / panels ---------------------------------------------------------------------------------------------

  tabList(): Locator {
    return this.page.getByRole('tablist', { name: 'Step details' });
  }

  tab(name: PrimaryTabName | SecondaryPanelName): Locator {
    return this.tabList().getByRole('tab', { name, exact: true });
  }

  async openTab(name: PrimaryTabName | SecondaryPanelName): Promise<Locator> {
    await this.tab(name).click();
    await expect(this.tab(name)).toHaveAttribute('aria-selected', 'true');
    return this.page.getByRole('tabpanel', { name });
  }

  /** Budget / Context summary: a labelled section when wide, a tab when narrow (< 1280 px). */
  async secondaryPanel(name: SecondaryPanelName): Promise<Locator> {
    if ((await this.tab(name).count()) > 0) return this.openTab(name);
    return this.page.getByRole('region', { name, exact: true });
  }

  /** Names of the tabs in the step-details tab strip. */
  async secondaryPanelTabs(): Promise<string[]> {
    return (await this.tabList().getByRole('tab').allTextContents()).map((t) => t.trim());
  }

  // ---- budget ------------------------------------------------------------------------------------------------------

  /** The BudgetLedger "tracked usage" table. */
  async budgetTable(): Promise<Locator> {
    const panel = await this.secondaryPanel('Budget');
    return panel.getByRole('table', { name: /tracked usage/ });
  }

  /** Amount cell of one tracked-usage bucket. */
  async ledgerRow(bucket: LedgerBucket): Promise<Locator> {
    const table = await this.budgetTable();
    return table
      .getByRole('row', { name: new RegExp(`^${bucket.replace(/[()]/g, '\\$&')}`) })
      .getByRole('cell');
  }

  async ledgerAmount(bucket: LedgerBucket): Promise<number> {
    return dollars(await (await this.ledgerRow(bucket)).textContent());
  }

  async reservedAmount(): Promise<number> {
    return this.ledgerAmount('Reserved (in flight)');
  }

  // ---- attempts ------------------------------------------------------------------------------------------------------

  async attemptsTable(): Promise<Locator> {
    const panel = await this.openTab('Attempts');
    return panel.getByRole('table', { name: /^Attempts for / });
  }

  /** Data rows of the Attempts tab of the selected step. */
  async attemptRows(): Promise<Locator> {
    const table = await this.attemptsTable();
    return table.getByRole('row').filter({ has: this.page.getByRole('cell') });
  }

  /**
   * Provider latency and app time of the selected step's last attempt, read from their two separately labelled
   * columns ("Provider time", "App time").
   */
  async attemptTimings(): Promise<{ providerLatency: string; appTime: string }> {
    const table = await this.attemptsTable();
    const headers = (await table.getByRole('columnheader').allTextContents()).map((h) => h.trim());
    const p = headers.indexOf('Provider time');
    const a = headers.indexOf('App time');
    if (p < 0 || a < 0) throw new Error(`timing columns missing: ${headers.join(' | ')}`);
    const row = table
      .getByRole('row')
      .filter({ has: this.page.getByRole('cell') })
      .last();
    // Direct children only (a cell's own content may hold nested roles).
    const cells = (await row.locator(':scope > th, :scope > td').allTextContents()).map((c) => c.trim());
    return { providerLatency: cells[p] ?? '', appTime: cells[a] ?? '' };
  }

  // ---- approval ------------------------------------------------------------------------------------------------------

  approvalCard(): Locator {
    return this.page.getByRole('region', { name: 'Proposed plan' });
  }

  async expectAwaitingApproval(timeout = 30_000): Promise<void> {
    await this.waitForStatus('Awaiting your approval', timeout);
    const card = await this.showApproval();
    await expect(card.getByRole('button', { name: 'Approve plan' })).toBeVisible();
  }

  /** Selects the pending approval step's Output tab, where the approval card lives. */
  async showApproval(): Promise<Locator> {
    if ((await this.stepHeading().textContent())?.trim() !== 'Approve plan')
      await this.selectStep('Approve plan');
    if ((await this.tab('Output').getAttribute('aria-selected')) !== 'true') await this.openTab('Output');
    await expect(this.approvalCard()).toBeVisible();
    return this.approvalCard();
  }

  async approve(): Promise<void> {
    await this.showApproval();
    await this.approvalCard().getByRole('button', { name: 'Approve plan' }).click();
  }

  /** Opens the revision form; returns its submit button ("Send revision request"). */
  async openRevision(): Promise<Locator> {
    const card = await this.showApproval();
    await card.getByRole('button', { name: 'Request revision' }).click();
    const submit = card.getByRole('button', { name: 'Send revision request' });
    await expect(submit).toBeVisible();
    return submit;
  }

  revisionNote(): Locator {
    return this.approvalCard().getByRole('textbox', { name: /What should the planner change\?/ });
  }

  async requestRevision(note: string): Promise<void> {
    const submit = await this.openRevision();
    await this.revisionNote().fill(note);
    await submit.click();
  }

  async reject(): Promise<void> {
    await this.showApproval();
    await this.approvalCard().getByRole('button', { name: 'Reject plan' }).click();
    const dialog = this.page.getByRole('dialog', { name: 'Reject this plan?' });
    await dialog.getByRole('button', { name: 'Reject plan' }).click();
    await expect(dialog).toBeHidden();
  }

  // ---- status banner / recovery ----------------------------------------------------------------------------------------

  /** The run-level status banner (non-semantic container → data-testid, 12 §L3). */
  banner(): Locator {
    return this.page.getByTestId('status-banner');
  }

  bannerAction(name: string | RegExp): Locator {
    return this.banner().getByRole('button', { name }).or(this.banner().getByRole('link', { name }));
  }

  /** Asserts the banner offers exactly these actions (buttons + links, in order). */
  async expectActions(names: readonly string[]): Promise<void> {
    // The InlineAlert's own action row (not the RawResponseToggle inside its body).
    const row = this.banner().locator('.body > .actions');
    await expect(row.getByRole('button').or(row.getByRole('link'))).toHaveText([...names]);
  }

  recoveryPanel(): Locator {
    return this.page.getByRole('region', { name: 'Recovery' });
  }

  /** A RecoveryPanel per-attempt decision button ("Retry (may incur another charge)", "Accept the estimated charge", …). */
  async decideUnknown(label: string | RegExp): Promise<void> {
    await this.recoveryPanel().getByRole('button', { name: label }).first().click();
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: label }).click();
    await expect(dialog).toBeHidden();
  }

  async increaseAllowance(amount: string): Promise<void> {
    await this.bannerAction('Increase allowance').click();
    const dialog = this.page.getByRole('dialog', { name: 'Increase the run allowance' });
    await dialog.getByLabel('New run allowance (USD)').fill(amount.replace(/^\$/, ''));
    await dialog.getByRole('button', { name: 'Save allowance and continue' }).click();
    await expect(dialog).toBeHidden();
  }

  async raiseLimits(o: { maxAttempts?: number; timeoutMinutes?: number }): Promise<void> {
    await this.bannerAction('Raise limits').click();
    const dialog = this.page.getByRole('dialog', { name: 'Raise limits for this run' });
    if (o.maxAttempts !== undefined) await dialog.getByLabel('Max attempts').fill(String(o.maxAttempts));
    if (o.timeoutMinutes !== undefined)
      await dialog.getByLabel('Execution timeout (minutes)').fill(String(o.timeoutMinutes));
    await dialog.getByRole('button', { name: 'Save limits and resume' }).click();
    await expect(dialog).toBeHidden();
  }

  async retryStep(): Promise<void> {
    await this.bannerAction('Retry step').click();
  }

  async acknowledgeOverrun(): Promise<void> {
    await this.bannerAction('Acknowledge overrun').click();
  }

  /** The "Completed …" verdict text of a completed run. */
  verdictNote(): Locator {
    return this.banner().getByText(/does not guarantee the code is correct/);
  }
}
