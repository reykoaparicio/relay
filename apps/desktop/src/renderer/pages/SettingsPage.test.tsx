import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { appError, providerStatusSchema } from '@relay/contracts';
import { renderApp } from '../features/testing/render-app';

const NOT_IMPLEMENTED = appError('INTERNAL', {
  userMessage: 'This feature is not available in this build yet.',
  details: { reason: 'not_implemented', channel: 'relay/v1/providers.test' },
});

async function providersReady() {
  await screen.findByRole('heading', { level: 1, name: 'Settings' });
  return screen.findByRole('region', { name: 'Anthropic' });
}

describe('SettingsPage (J10 M1 sections)', () => {
  it('connected: providers show redacted labels and storage; Models shows the CatalogTable with profile checks', async () => {
    const { bridge } = renderApp('/settings/providers', { scenario: 'awaiting-approval' });
    const anthropic = await providersReady();
    expect(within(anthropic).getByText('sk-ant-…a1F9')).toBeInTheDocument();
    expect(within(anthropic).getByText('Connected')).toBeInTheDocument();
    expect(within(anthropic).getByText(/Keychain protection/)).toBeInTheDocument();
    const models = screen.getByRole('region', { name: 'Models' });
    const table = await within(models).findByRole('table', { name: /Model catalog, version 2026-09-25/ });
    expect(within(table).getByRole('columnheader', { name: 'Profile checks' })).toBeInTheDocument();
    expect(within(table).getAllByText('No issues').length).toBeGreaterThan(0);
    expect(bridge.callsTo('relay/v1/profiles.list').length).toBeGreaterThan(0);
  });

  it('shows engine capability warnings per model (grouped from profiles.list)', async () => {
    const { bridge } = renderApp('/settings/providers', { scenario: 'awaiting-approval' });
    const row = bridge.world.profiles.find((p) => p.profile.modelId === 'gpt-5-mini');
    if (row !== undefined) {
      row.warnings = [
        {
          stepKey: null,
          profileId: row.profile.id,
          code: 'missing_credential',
          message: 'Balanced needs an OpenAI credential.',
        },
      ];
    }
    await providersReady();
    expect(await screen.findByText('Balanced needs an OpenAI credential.')).toBeInTheDocument();
  });

  it('no-secure-storage: offers a session-only key and never a plaintext or Keychain save', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/providers', { scenario: 'no-secure-storage' });
    await providersReady();
    expect(await screen.findByText('OS credential protection is unavailable')).toBeInTheDocument();
    const gemini = screen.getByRole('region', { name: 'Google Gemini' });
    expect(within(gemini).getByRole('button', { name: 'Save to Keychain (unavailable)' })).toBeDisabled();
    expect(
      within(gemini).queryByRole('button', { name: 'Test and save to Keychain' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/plaintext file/i)).not.toBeInTheDocument();
    const key = within(gemini).getByLabelText(/Google Gemini API key/);
    expect(key).toHaveAttribute('type', 'password');
    await user.type(key, 'AIzaSyEXAMPLEEXAMPLEEXAMPLE1234');
    await user.click(within(gemini).getByRole('button', { name: 'Test and use for this session' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/providers.connect')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/providers.connect')[0]?.input).toMatchObject({
      providerId: 'gemini',
      storage: 'session',
    });
    expect(document.body.innerHTML).not.toContain('AIzaSyEXAMPLEEXAMPLEEXAMPLE1234');
  });

  it('providers.test not implemented in this build: "Not available yet in this build" via ErrorView', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/providers', { scenario: 'awaiting-approval' });
    const anthropic = await providersReady();
    bridge.failNext('relay/v1/providers.test', NOT_IMPLEMENTED);
    await user.click(within(anthropic).getByRole('button', { name: 'Test connection' }));
    const alert = await within(anthropic).findByRole('alert');
    expect(alert).toHaveTextContent('Not available yet in this build');
    expect(alert).toHaveTextContent('INTERNAL');
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
  });

  it('auth-failed: the rejected key is flagged; Remove key asks for confirmation then disconnects', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/providers', { scenario: 'auth-failed' });
    await providersReady();
    expect(await screen.findByText('OpenAI rejected the stored key')).toBeInTheDocument();
    const openai = screen.getByRole('region', { name: 'OpenAI' });
    expect(within(openai).getByText('Auth failed')).toBeInTheDocument();
    expect(within(openai).getByText('sk-…Q7d2 (rejected)')).toBeInTheDocument();
    await user.click(within(openai).getByRole('button', { name: 'Remove key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove the OpenAI key?' });
    expect(bridge.callsTo('relay/v1/providers.disconnect')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Remove key' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/providers.disconnect')).toHaveLength(1);
    });
  });

  it('diagnostics: runner state, schema version, unresolved calls, provider mode, version and build', async () => {
    renderApp('/settings/diagnostics', { scenario: 'interrupted' });
    const section = await screen.findByRole('region', { name: 'Diagnostics' });
    expect(await within(section).findByText('Healthy')).toBeInTheDocument();
    expect(within(section).getByText('Runner heartbeat')).toBeInTheDocument();
    expect(within(section).getByText(/Version 1 · current/)).toBeInTheDocument();
    expect(within(section).getByText(/1 with an unknown outcome/)).toBeInTheDocument();
    expect(within(section).getByText(/Fake providers · scenario interrupted/)).toBeInTheDocument();
    expect(within(section).getByText('0.1.0')).toBeInTheDocument();
    expect(within(section).getByText('dev-fake')).toBeInTheDocument();
  });

  it('unbuilt sections say "coming soon"; unknown sections redirect to providers', async () => {
    const { router } = renderApp('/settings/projects', { scenario: 'awaiting-approval' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByText('Coming soon.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');
    await router.navigate('/settings/nope');
    await providersReady();
    expect(router.state.location.pathname).toBe('/settings/providers');
  });

  // ----- Referee regressions -----

  it('B5: a disconnect error next action routes (Restart runner → diagnostics) and never re-sends', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp('/settings/providers', { scenario: 'awaiting-approval' });
    const anthropic = await providersReady();
    bridge.failNext('relay/v1/providers.disconnect', appError('RUNNER_UNAVAILABLE'));
    await user.click(within(anthropic).getByRole('button', { name: 'Remove key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove the Anthropic key?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove key' }));
    await user.click(await within(anthropic).findByRole('button', { name: 'Restart runner' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/diagnostics');
    });
    expect(bridge.callsTo('relay/v1/providers.disconnect')).toHaveLength(1);
  });

  it('B6: "Use a key for this session only" switches to session mode and asks to re-paste; no empty submit', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/providers', { scenario: 'awaiting-approval' });
    await providersReady();
    const gemini = screen.getByRole('region', { name: 'Google Gemini' });
    bridge.failNext('relay/v1/providers.connect', appError('SECURE_STORAGE_UNAVAILABLE'));
    await user.type(within(gemini).getByLabelText(/Google Gemini API key/), GEMINI_KEY);
    await user.click(within(gemini).getByRole('button', { name: 'Test and save to Keychain' }));
    await user.click(
      await within(gemini).findByRole('button', { name: 'Use a key for this session only' }),
    );
    expect(bridge.callsTo('relay/v1/providers.connect')).toHaveLength(1);
    const key = within(gemini).getByLabelText(/Google Gemini API key/);
    expect(key).toHaveValue('');
    await waitFor(() => {
      expect(key).toHaveFocus();
    });
    expect(key).toHaveAccessibleDescription(/Paste it again to use it for this session only/);
    expect(key).not.toHaveAttribute('aria-invalid');
    expect(
      within(gemini).queryByRole('button', { name: 'Test and save to Keychain' }),
    ).not.toBeInTheDocument();
    await user.type(key, GEMINI_KEY);
    await user.click(within(gemini).getByRole('button', { name: 'Test and use for this session' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/providers.connect')).toHaveLength(2);
    });
    expect(bridge.callsTo('relay/v1/providers.connect')[1]?.input).toMatchObject({
      providerId: 'gemini',
      storage: 'session',
    });
    expect(document.body.innerHTML).not.toContain(GEMINI_KEY);
  });

  it('B7: a failed test that is not AUTH_REQUIRED is not shown as "Auth failed"', async () => {
    const { bridge } = renderApp('/settings/providers', { scenario: 'awaiting-approval' });
    bridge.world.providers = bridge.world.providers.map((p) =>
      p.providerId === 'anthropic' ? providerStatusSchema.parse({ ...p, lastTest: { at: Date.now(), ok: false, code: 'RATE_LIMITED' } }) : p,
    );
    const anthropic = await providersReady();
    expect(await within(anthropic).findByText('Test failed')).toBeInTheDocument();
    expect(within(anthropic).queryByText('Auth failed')).not.toBeInTheDocument();
    expect(within(anthropic).queryByText(/\(rejected\)/)).not.toBeInTheDocument();
    expect(screen.queryByText('Anthropic rejected the stored key')).not.toBeInTheDocument();
    expect(screen.getByText('The last Anthropic connection test failed')).toBeInTheDocument();
    expect(screen.getByText(/The provider is rate limiting requests/)).toBeInTheDocument();
  });

  it('B7: auth-failed copy does not claim that nothing was sent with the rejected key', async () => {
    renderApp('/settings/providers', { scenario: 'auth-failed' });
    await providersReady();
    const banner = (await screen.findByText('OpenAI rejected the stored key')).closest('.banner');
    expect(banner).not.toBeNull();
    expect(banner).not.toHaveTextContent(/Nothing was sent/);
    expect(banner).toHaveTextContent(/small test request/);
  });
});

const GEMINI_KEY = 'AIzaSyEXAMPLEEXAMPLEEXAMPLE1234';
