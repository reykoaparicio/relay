// R2 item 1/2: runner recovery (shell banner + Settings → Diagnostics) and a busy database.
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { DATABASE_UNAVAILABLE_MESSAGES, errors } from '@relay/contracts';
import { AppErrorException } from '../../api/client';
import { createFakeBridge, FAKE_PROJECT_ID } from '../../api/fake-bridge';
import { MutationError } from '../common/MutationError';
import { renderApp } from '../testing/render-app';

async function banner() {
  const title = await screen.findByText('The background runner is unavailable');
  return title.closest('.banner, [class*="banner"], div') as HTMLElement;
}

describe('runner recovery (E2 #3/#4)', () => {
  it('runner-unavailable: the banner explains the fatal in plain words and offers restart, restore and relaunch', async () => {
    renderApp('/settings/about', { scenario: 'runner-unavailable' });
    await banner();
    expect(await screen.findAllByText('The Relay database file is damaged. Restore it from a backup.')).not.toHaveLength(0);
    expect(screen.getAllByRole('button', { name: 'Restart runner' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Restore latest backup' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Quit and relaunch' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Open diagnostics' })).toBeInTheDocument();
  });

  it('Settings → Diagnostics while the runner is down: runner-reported rows say "Unknown", and the banner has no "Open diagnostics"', async () => {
    renderApp('/settings/diagnostics', { scenario: 'runner-unavailable' });
    const section = await screen.findByRole('region', { name: 'Diagnostics' });
    await banner();
    const value = async (term: string) => (await within(section).findByText(term)).nextElementSibling?.textContent;
    expect(await value('Price catalog')).toBe('Unknown while the runner is down');
    expect(await value('Prompt templates')).toBe('Unknown while the runner is down');
    expect(within(section).queryByText(/none loaded/)).not.toBeInTheDocument();
    expect(within(section).queryByText('0 loaded')).not.toBeInTheDocument();
    // Already on the diagnostics page: no button that leads back to it.
    expect(screen.queryByRole('button', { name: 'Open diagnostics' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Restart runner' }).length).toBeGreaterThan(0);
  });

  it('restart fails again with a database fatal: the reason is shown in words', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/about', { scenario: 'runner-unavailable' });
    await banner();
    await user.click((await screen.findAllByRole('button', { name: 'Restart runner' }))[0] as HTMLElement);
    expect(await screen.findByText('The runner could not be restarted')).toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/app.restartRunner')).toHaveLength(1);
  });

  it('restore asks first (the current data is moved aside, not deleted), then shows where the backup came from', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/about', { scenario: 'runner-unavailable' });
    await banner();
    await user.click((await screen.findAllByRole('button', { name: 'Restore latest backup' }))[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Restore the latest backup?' });
    expect(within(dialog).getByText(/moved aside to a folder next to it, not deleted/)).toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/app.restoreLatestBackup')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Restore backup' }));
    // The banner closes once the runner is back; the outcome stays as a toast.
    expect(await screen.findByText('Backup restored')).toBeInTheDocument();
    expect(screen.getByText(/The damaged data was moved to .*damaged-.* Nothing was deleted\./)).toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/app.restoreLatestBackup')).toHaveLength(1);
    // The runner is back: the banner goes away.
    await waitFor(() => {
      expect(screen.queryByText('The background runner is unavailable')).not.toBeInTheDocument();
    });
  });

  it('a restore that leaves the runner down is a failure with the reason, never a success', async () => {
    const user = userEvent.setup();
    const bridge = createFakeBridge('runner-unavailable');
    bridge.world.restoreLeavesFatal = { code: 'DATABASE_UNAVAILABLE', reason: 'disk_full', message: DATABASE_UNAVAILABLE_MESSAGES.disk_full };
    renderApp('/settings/diagnostics', { bridge });
    const section = await screen.findByRole('region', { name: 'Diagnostics' });
    await user.click(await within(section).findByRole('button', { name: 'Restore latest backup' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Restore backup' }));
    expect(
      await within(section).findByText(`Backup restored, but the runner still could not start: ${DATABASE_UNAVAILABLE_MESSAGES.disk_full}`, {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Backup restored')).not.toBeInTheDocument();
    expect(screen.getByText('Backup restored, but the runner still could not start')).toBeInTheDocument();
    expect(screen.getByText('The background runner is unavailable')).toBeInTheDocument();
  });

  it('data from a newer Relay: no restore is offered; it says to install the newer version', async () => {
    const bridge = createFakeBridge('runner-unavailable');
    bridge.world.diagnostics = {
      ...bridge.world.diagnostics,
      runner: { ...bridge.world.diagnostics.runner, lastFatal: { code: 'DATABASE_UNAVAILABLE', reason: 'schema_too_new', message: 'x', at: 1 } as never },
    };
    renderApp('/settings/diagnostics', { bridge });
    const section = await screen.findByRole('region', { name: 'Diagnostics' });
    expect(await within(section).findByText('This data was created by a newer Relay. Install the newer version to open it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore latest backup' })).not.toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Restart runner' })).toBeInTheDocument();
  });

  it('no usable backup: says so and changes nothing', async () => {
    const user = userEvent.setup();
    const bridge = createFakeBridge('runner-unavailable');
    bridge.world.backupAvailable = false;
    renderApp('/settings/diagnostics', { bridge });
    const section = await screen.findByRole('region', { name: 'Diagnostics' });
    await user.click(await within(section).findByRole('button', { name: 'Restore latest backup' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Restore backup' }));
    expect(await within(section).findByText('No usable backup')).toBeInTheDocument();
    expect(within(section).getByText(/Nothing was changed/)).toBeInTheDocument();
  });

  it('runner-crashed: restart brings it back; no restore is offered for a crash loop', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/diagnostics', { scenario: 'runner-crashed' });
    const section = await screen.findByRole('region', { name: 'Diagnostics' });
    expect(await within(section).findByText(/stopped several times in a row/)).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Restore latest backup' })).not.toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Restart runner' }));
    expect(await within(section).findByText('The background runner is running again')).toBeInTheDocument();
    expect(bridge.world.runnerState).toBe('ready');
  });

  it('quit and relaunch is confirmed first', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/diagnostics', { scenario: 'awaiting-approval' });
    const section = await screen.findByRole('region', { name: 'Diagnostics' });
    await user.click(await within(section).findByRole('button', { name: 'Quit and relaunch' }));
    const dialog = await screen.findByRole('dialog', { name: 'Quit and relaunch Relay?' });
    expect(bridge.callsTo('relay/v1/app.relaunch')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Quit and relaunch' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/app.relaunch')).toHaveLength(1);
    });
    expect(await within(section).findByText('Relaunching Relay…')).toBeInTheDocument();
  });

  it('diagnostics shows the last fatal, a degraded log file, and how the previous session ended', async () => {
    renderApp('/settings/diagnostics', { scenario: 'runner-unavailable' });
    const section = await screen.findByRole('region', { name: 'Diagnostics' });
    expect(await within(section).findByText('Why it stopped')).toBeInTheDocument();
    expect(within(section).getByText('db_corrupt')).toBeInTheDocument();
    expect(within(section).getByText('Not writable')).toBeInTheDocument();
    expect(within(section).getByText(/Did not quit normally/)).toBeInTheDocument();
  });

  it('a healthy runner: log writing normally, a clean last quit, restart is a no-op', async () => {
    const user = userEvent.setup();
    renderApp('/settings/diagnostics', { scenario: 'interrupted-quit' });
    const section = await screen.findByRole('region', { name: 'Diagnostics' });
    expect(await within(section).findByText('Writing normally')).toBeInTheDocument();
    expect(within(section).getByText(/Quit normally on .* while a run was in progress/)).toBeInTheDocument();
    expect(within(section).queryByText('Why it stopped')).not.toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Restart runner' }));
    expect(await within(section).findByText('The background runner is already running')).toBeInTheDocument();
  });

  it('a RUNNER_UNAVAILABLE error next action "Restart runner" calls app.restartRunner instead of navigating', async () => {
    const user = userEvent.setup();
    const bridge = createFakeBridge('awaiting-approval');
    bridge.failNext('relay/v1/profiles.list', errors.runnerUnavailable());
    const { router } = renderApp('/settings/profiles', { bridge });
    await user.click(await screen.findByRole('button', { name: 'Restart runner' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/app.restartRunner')).toHaveLength(1);
    });
    expect(router.state.location.pathname).toBe('/settings/profiles');
  });
});

describe('busy database (E2 #2)', () => {
  it('a busy database is a wait, not a crash: plain wording, no error code, "Try again now" refetches', async () => {
    const user = userEvent.setup();
    const bridge = createFakeBridge('database-busy');
    // Tests run without query retries: one busy answer reaches the page.
    bridge.world.busyFailures = 0;
    bridge.failNext('relay/v1/runs.list', { ...errors.databaseUnavailable('database_busy'), nextAction: 'wait' });
    renderApp(`/p/${FAKE_PROJECT_ID}/runs`, { bridge });
    expect(await screen.findByText('The database is in use by another program. Try again in a moment.')).toBeInTheDocument();
    expect(screen.queryByText('DATABASE_UNAVAILABLE')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again now' }));
    await waitFor(() => {
      expect(screen.queryByText('The database is in use by another program. Try again in a moment.')).not.toBeInTheDocument();
    });
  });

  it('a busy database on a command never renders a "Try again now" that nothing handles, and says nothing changed', () => {
    const busy = new AppErrorException({ ...errors.databaseUnavailable('database_busy'), nextAction: 'wait' });
    const { unmount } = render(
      <MemoryRouter>
        <MutationError error={busy} />
      </MemoryRouter>,
    );
    expect(screen.getByText('The database is in use by another program, so nothing was changed. Try again in a moment.')).toBeInTheDocument();
    expect(screen.queryByText(/Relay will retry/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again now' })).not.toBeInTheDocument();
    unmount();
    // A page that handles `wait` (re-submits) gets the button, wired to its handler.
    let waited = 0;
    render(
      <MemoryRouter>
        <MutationError error={busy} handlers={{ wait: () => { waited += 1; } }} />
      </MemoryRouter>,
    );
    screen.getByRole('button', { name: 'Try again now' }).click();
    expect(waited).toBe(1);
  });

  it('New run: a busy preflight is a system error with "Retry the check", not a dead button', async () => {
    const user = userEvent.setup();
    const bridge = createFakeBridge('awaiting-approval');
    bridge.failNext('relay/v1/runs.preflight', { ...errors.databaseUnavailable('database_busy'), nextAction: 'wait' });
    renderApp(`/p/${FAKE_PROJECT_ID}/runs/new`, { bridge });
    const summary = await screen.findByRole('region', { name: 'Input summary' });
    expect(await within(summary).findByText('The database is in use by another program. Try again in a moment.', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText('Start unavailable: the run check failed.')).toBeInTheDocument();
    expect(within(summary).queryByRole('button', { name: 'Try again now' })).not.toBeInTheDocument();
    const before = bridge.callsTo('relay/v1/runs.preflight').length;
    await user.click(within(summary).getByRole('button', { name: 'Retry the check' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.preflight').length).toBe(before + 1);
    });
    await waitFor(() => {
      expect(within(summary).queryByText(/in use by another program/)).not.toBeInTheDocument();
    });
  });
});
