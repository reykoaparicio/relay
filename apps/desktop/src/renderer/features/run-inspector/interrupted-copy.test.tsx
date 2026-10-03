// The interrupted-run cause on the Overview banner follows AppInfo.lastShutdown (E2): clean quit vs runner stopped.
import { describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { epochMs, lastShutdownSchema } from '@relay/contracts';
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
  const shutdown = (clean: boolean) => lastShutdownSchema.parse({ clean, at: 1_000, runActive: true });
  it('maps the shutdown record to a cause when the run was interrupted after it, neutral otherwise', () => {
    expect(interruptionCauseOf(shutdown(true), 2_000)).toBe('quit');
    expect(interruptionCauseOf(shutdown(false), 2_000)).toBe('runner_stopped');
    expect(interruptionCauseOf(null, 2_000)).toBe('unknown');
    expect(interruptionCauseOf(undefined, 2_000)).toBe('unknown');
  });

  it('a run interrupted before the last session ended (an older session), or with no interruption time, is neutral', () => {
    expect(interruptionCauseOf(shutdown(true), 500)).toBe('unknown');
    expect(interruptionCauseOf(shutdown(false), 1_000)).toBe('unknown');
    expect(interruptionCauseOf(shutdown(true), null)).toBe('unknown');
    expect(interruptionCauseOf(shutdown(true), undefined)).toBe('unknown');
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

  it('a run interrupted before the last recorded shutdown: never blamed on that session ("Relay stopped while")', async () => {
    const bridge = createFakeBridge('interrupted-quit');
    // The last session (a clean quit) ended after this run became interrupted: its cause is not this run's.
    const lastShutdown = bridge.world.info.lastShutdown;
    if (lastShutdown === null || lastShutdown === undefined) throw new Error('no shutdown record');
    bridge.world.info = { ...bridge.world.info, lastShutdown: { ...lastShutdown, at: epochMs(Date.now() - 60_000) } };
    renderApp(OVERVIEW, { bridge });
    await waitFor(async () => {
      expect(await interruptedBannerText()).toMatch(/Relay stopped while Produce patch was running\./);
    });
    // The run page says the same.
    const run = bridge.world.runs.find((r) => r.status === 'interrupted');
    if (run === undefined) throw new Error('no interrupted run');
    cleanup();
    renderApp(`${OVERVIEW}/runs/${run.id}`, { bridge });
    const banner = await screen.findByTestId('status-banner', {}, { timeout: 3000 });
    await waitFor(() => {
      expect(banner).toHaveTextContent(/Relay stopped while Produce patch was running\./);
    });
    expect(banner).not.toHaveTextContent(/Relay was closed while/);
  });

  it('run page: the cause follows the interruption event and the shutdown record', async () => {
    const bridge = createFakeBridge('interrupted-quit');
    const run = bridge.world.runs.find((r) => r.status === 'interrupted');
    if (run === undefined) throw new Error('no interrupted run');
    renderApp(`${OVERVIEW}/runs/${run.id}`, { bridge });
    const banner = await screen.findByTestId('status-banner', {}, { timeout: 3000 });
    await waitFor(() => {
      expect(banner).toHaveTextContent(/Relay was closed while Produce patch was running\./);
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
