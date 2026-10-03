import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { appError, errors, providerStatusSchema } from '@relay/contracts';
import { createFakeBridge } from '../../api/fake-bridge';
import { renderApp } from '../testing/render-app';

describe('ProviderCard error actions', () => {
  it('a BUDGET_BLOCKED connection test offers "Increase allowance", which opens Storage & data', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp('/settings/providers', { scenario: 'awaiting-approval' });
    const anthropic = await screen.findByRole('region', { name: 'Anthropic' });
    bridge.failNext('relay/v1/providers.test', appError('BUDGET_BLOCKED'));

    await user.click(within(anthropic).getByRole('button', { name: 'Test connection' }));
    const action = await within(anthropic).findByRole('button', { name: 'Increase allowance' });
    expect(action.closest('.banner')).toHaveTextContent('Error code BUDGET_BLOCKED');
    expect(router.state.location.pathname).toBe('/settings/providers');
    await user.click(action);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/data');
    });
  });
});

describe('ProviderCard Remove key (A11Y-02)', () => {
  it('on success closes the dialog and moves focus to the provider heading, not <body>', async () => {
    const user = userEvent.setup();
    renderApp('/settings/providers', { scenario: 'awaiting-approval' });
    const anthropic = await screen.findByRole('region', { name: 'Anthropic' });

    await user.click(within(anthropic).getByRole('button', { name: 'Remove key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove the Anthropic key?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove key' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(within(anthropic).queryByRole('button', { name: 'Remove key' })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(within(anthropic).getByRole('heading', { name: 'Anthropic' }));
    });
  });

  it('on failure keeps the dialog open with the error inside it', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/providers', { scenario: 'awaiting-approval' });
    const anthropic = await screen.findByRole('region', { name: 'Anthropic' });
    bridge.failNext('relay/v1/providers.disconnect', errors.internal(undefined));

    await user.click(within(anthropic).getByRole('button', { name: 'Remove key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove the Anthropic key?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove key' }));

    expect(await within(dialog).findByText(/Error code/)).toHaveTextContent('INTERNAL');
    expect(screen.getByRole('dialog', { name: 'Remove the Anthropic key?' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Remove key' })).toBeEnabled();
  });
});

describe('ProviderCard rejected-key wording by lastTest.source (E2 #10)', () => {
  it("auth-failed (source 'run'): the key was rejected during a run", async () => {
    renderApp('/settings/providers', { scenario: 'auth-failed' });
    const openai = await screen.findByRole('region', { name: 'OpenAI' });
    expect(within(openai).getByTestId('provider-rejected-during')).toHaveTextContent('The key was rejected during a run.');
    expect(within(openai).getByText(/failed during a run · AUTH_REQUIRED/)).toBeInTheDocument();
    const banner = screen.getByText('OpenAI rejected the stored key').closest('.banner');
    expect(banner).toHaveTextContent('The key was rejected during a run: OpenAI returned AUTH_REQUIRED for a run request made with this key.');
    expect(banner).not.toHaveTextContent(/connection test/);
  });

  it("source 'connection_test': the key was rejected during the last connection test", async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/providers', { scenario: 'awaiting-approval' });
    const anthropic = await screen.findByRole('region', { name: 'Anthropic' });
    bridge.world.authFailing.add('anthropic');
    await user.click(within(anthropic).getByRole('button', { name: 'Test connection' }));
    expect(await within(anthropic).findByTestId('provider-rejected-during')).toHaveTextContent('The key was rejected during the last connection test.');
    const banner = (await screen.findByText('Anthropic rejected the stored key')).closest('.banner');
    expect(banner).toHaveTextContent(/The key was rejected during the last connection test: Anthropic returned AUTH_REQUIRED for Relay's small test request/);
  });

  it('source absent (older mains): the earlier wording', async () => {
    const bridge = createFakeBridge('auth-failed');
    bridge.world.providers = bridge.world.providers.map((p) =>
      p.lastTest === null ? p : providerStatusSchema.parse({ ...p, lastTest: { at: p.lastTest.at, ok: p.lastTest.ok, ...(p.lastTest.code === undefined ? {} : { code: p.lastTest.code }) } }),
    );
    renderApp('/settings/providers', { bridge });
    const openai = await screen.findByRole('region', { name: 'OpenAI' });
    expect(within(openai).queryByTestId('provider-rejected-during')).not.toBeInTheDocument();
    const banner = screen.getByText('OpenAI rejected the stored key').closest('.banner');
    expect(banner).toHaveTextContent(/The last connection test returned AUTH_REQUIRED: OpenAI rejected Relay's small test request/);
  });
});
