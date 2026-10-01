// 12 §L3 page objects: role/label/text locators only (accessibility doubles as a test).
import type { Locator, Page } from '@playwright/test';

export type NavName = 'Overview' | 'Workflows' | 'Runs' | 'Memory' | 'Settings';

/** App frame: primary nav, project switcher, provider status, fake-provider badge, runner banner. */
export class Shell {
  constructor(readonly page: Page) {}

  get primaryNav(): Locator {
    return this.page.getByRole('navigation', { name: 'Primary' });
  }

  navLink(name: NavName): Locator {
    // The Runs link's accessible name also carries its badge ("Runs 1 waiting for approval").
    return this.primaryNav.getByRole('link', { name: new RegExp(`^${name}\\b`) });
  }

  async nav(name: NavName): Promise<void> {
    await this.navLink(name).click();
  }

  heading(): Locator {
    return this.page.getByRole('main').getByRole('heading', { level: 1 });
  }

  activeProject(): Locator {
    return this.page.getByRole('button', { name: /switch project/ });
  }

  runsBadgeCount(): Locator {
    return this.primaryNav.getByText(/waiting for approval/);
  }

  fakeProviderBadge(): Locator {
    return this.page.getByText('Fake provider: no real model calls');
  }

  providerStatus(): Locator {
    return this.page.getByRole('link', { name: /providers? connected|No providers connected/ });
  }

  /** A toast by its title, inside the Radix toast viewport ("Notifications (F8)"). */
  toast(title: string | RegExp): Locator {
    return this.page.getByRole('region', { name: /^Notifications/ }).getByText(title, { exact: typeof title === 'string' });
  }

  runnerBanner(): Locator {
    return this.page.getByText(/Background runner restarting|The background runner is unavailable/);
  }
}
