import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

export type ProviderName = 'Anthropic' | 'OpenAI' | 'Google Gemini';
export type StorageMode = 'keychain' | 'session';

/** First-run setup (10 J6): 8 steps, each a labelled region with a Back / primary footer. */
export class Onboarding {
  constructor(readonly page: Page) {}

  step(title: string | RegExp): Locator {
    return this.page.getByRole('region', { name: title });
  }

  async expectStep(title: string | RegExp): Promise<void> {
    await expect(this.step(title).getByRole('heading', { level: 2 })).toBeVisible();
  }

  async continue(label = 'Continue'): Promise<void> {
    await this.page.getByRole('main').getByRole('button', { name: label, exact: true }).click();
  }

  async useSample(): Promise<void> {
    await this.page.getByRole('button', { name: 'Use the sample project' }).click();
  }

  /** Welcome → Start point → "My own project folder". */
  async startWithOwnFolder(): Promise<void> {
    await this.expectStep('Welcome to Relay');
    await this.continue();
    await this.expectStep('Choose a starting point');
    await this.page.getByRole('radio', { name: 'My own project folder' }).check();
    await this.continue();
    await this.expectStep('Connect a model provider');
  }

  /** Connect step: pick provider and storage, paste the key, "Connect and test". */
  async connectProvider(provider: ProviderName, key: string, mode: StorageMode): Promise<void> {
    const region = this.step('Connect a model provider');
    await region.getByRole('radio', { name: provider, exact: true }).check();
    const storage = mode === 'keychain' ? 'Store with macOS Keychain protection' : 'Session only';
    const storageRadio = region.getByRole('radio', { name: storage });
    if (await storageRadio.isEnabled()) await storageRadio.check();
    await region.getByLabel(`${provider} API key`).fill(key);
    await region.getByRole('button', { name: 'Connect and test' }).click();
  }

  /** The redacted connect outcome ("Connected to X · sk-…MNOP" / "X key saved (not tested) · …"). */
  connectOutcome(provider: ProviderName): Locator {
    return this.page.getByText(new RegExp(`(Connected to ${provider}|${provider} key saved)`));
  }

  async chooseFolder(): Promise<void> {
    await this.page.getByRole('button', { name: 'Choose folder…' }).click();
  }

  fileTree(): Locator {
    return this.page.getByRole('list', { name: /^Files in / });
  }

  /** A file-tree row by its project-relative path. */
  fileRow(relPath: string): Locator {
    return this.fileTree().getByRole('listitem').filter({ has: this.page.getByText(relPath, { exact: true }) });
  }

  /**
   * Adds one project rule. Returns 'saved', or 'not_available' when `memory.create` is still stubbed in this build
   * (the step then shows the graceful notice and offers "Continue without a rule", which this clicks).
   */
  async addRule(text: string): Promise<'saved' | 'not_available'> {
    await this.expectStep('Add one project rule');
    const region = this.step('Add one project rule');
    await region.getByRole('textbox', { name: 'Rule' }).fill(text);
    await region.getByRole('button', { name: 'Save rule and continue' }).click();
    const templateHeading = this.step('Choose a workflow template').getByRole('heading', { level: 2 });
    const notice = region.getByText('Not available yet in this build');
    await expect(templateHeading.or(notice)).toBeVisible();
    if (await templateHeading.isVisible()) return 'saved';
    await expect(region.getByText('Project rules cannot be saved in this build yet.')).toBeVisible();
    await region.getByRole('button', { name: 'Continue without a rule' }).click();
    await this.expectStep('Choose a workflow template');
    return 'not_available';
  }

  async setAllowance(dollars: string): Promise<void> {
    const input = this.page.getByLabel('Run allowance (USD)');
    await input.fill(dollars.replace(/^\$/, ''));
  }

  async fillGoal(goal: string): Promise<void> {
    await this.page.getByRole('textbox', { name: 'Goal' }).fill(goal);
  }

  startButton(): Locator {
    return this.page.getByRole('button', { name: 'Start run', exact: true });
  }
}
