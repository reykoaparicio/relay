// The interrupted-run cause on the Overview banner follows AppInfo.lastShutdown (E2): clean quit vs runner stopped.
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { lastShutdownSchema } from '@relay/contracts';
import { createFakeBridge, FAKE_PROJECT_ID } from '../../api/fake-bridge';
import { renderApp } from '../testing/render-app';
import { interruptionCauseOf } from './inspector-model';

const OVERVIEW = `/p/${FAKE_PROJECT_ID}`;

async function interruptedBannerText(): Promise<string> {
  const title = await screen.findByText(/was interrupted/);
  const banner = title.closest('.banner') ?? title.parentElement?.parentElement;
  if (banner === null || banner === undefined) throw new Error('no banner');
  return banner.textContent;
}

describe('interruptionCauseOf', () => {
  it('maps the shutdown record to a cause, neutral without one', () => {
    expect(interruptionCauseOf(lastShutdownSchema.parse({ clean: true, at: 1, runActive: true }))).toBe(
      'quit',
    );
    expect(interruptionCauseOf(lastShutdownSchema.parse({ clean: false, at: 1, runActive: true }))).toBe(
      'runner_stopped',
    );
    expect(interruptionCauseOf(null)).toBe('unknown');
    expect(interruptionCauseOf(undefined)).toBe('unknown');
  });
});

describe('Overview InterruptedBanner wording', () => {
  it('interrupted (crash): the background runner stopped responding while the step was running', async () => {
    renderApp(OVERVIEW, { scenario: 'interrupted' });
    await waitFor(async () => {
      expect(await interruptedBannerText()).toMatch(
        /The background runner stopped responding while Produce patch was running\./,
      );
    });
  });

  it('interrupted-quit (clean): Relay was closed while the step was running', async () => {
    renderApp(OVERVIEW, { scenario: 'interrupted-quit' });
    await waitFor(async () => {
      expect(await interruptedBannerText()).toMatch(/Relay was closed while Produce patch was running\./);
    });
  });

  it('no shutdown record: a neutral cause', async () => {
    const bridge = createFakeBridge('interrupted');
    bridge.world.info = { ...bridge.world.info, lastShutdown: null };
    renderApp(OVERVIEW, { bridge });
    await waitFor(async () => {
      expect(await interruptedBannerText()).toMatch(/Relay stopped while Produce patch was running\./);
    });
  });
});
