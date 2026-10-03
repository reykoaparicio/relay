// 12 §L3 Workflow editor (10 J10, workflow-editor.html) page object: role / label / text locators from
// WorkflowEditorPage and features/workflow-editor/WorkflowEditorPanels.
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { Shell } from './shell.js';

export class WorkflowEditor {
  constructor(readonly page: Page) {}

  /** Primary nav → Workflows (redirects to the first workflow's editor). */
  async open(): Promise<void> {
    await new Shell(this.page).nav('Workflows');
    await this.expectLoaded();
  }

  async expectLoaded(): Promise<void> {
    await expect(this.page.getByRole('heading', { level: 1, name: 'Workflow editor' })).toBeVisible();
    await expect(this.limits()).toBeVisible();
  }

  /** Header status badge ("Validated", "Draft, unsaved changes", "Draft valid", …). */
  status(): Locator {
    return this.page.getByRole('main').locator('header .status-line');
  }

  /** Breadcrumb version label ("Version 1", "Draft revision 1 · based on v1"). */
  versionLabel(): Locator {
    return this.page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('listitem').last();
  }

  saveButton(): Locator {
    return this.page.getByRole('main').locator('header').getByRole('button', { name: 'Save draft' });
  }

  validateButton(): Locator {
    return this.page.getByRole('main').locator('header').getByRole('button', { name: /^Validate( again)?$/ });
  }

  limits(): Locator {
    return this.page.getByRole('region', { name: 'Workflow limits' });
  }

  limitField(label: 'Run allowance (USD)' | 'Revision cycles' | 'Max attempts (run)' | 'Timeout (minutes)'): Locator {
    return this.limits().getByLabel(label, { exact: true });
  }

  /** "Draft revision N is valid" alert with the Publish button. */
  validAlert(): Locator {
    return this.page.getByRole('status').filter({ hasText: /^Draft revision \d+ is valid/ });
  }

  publishButton(): Locator {
    return this.page.getByRole('button', { name: /^Publish as v\d+$/ });
  }

  /** "vN validated — new runs will snapshot vN …" banner after publishing. */
  publishedBanner(): Locator {
    return this.page.getByRole('status').filter({ hasText: /^v\d+ validated — new runs will snapshot/ });
  }

  async save(): Promise<void> {
    await this.saveButton().click();
  }

  async validate(): Promise<void> {
    await this.validateButton().click();
  }
}
