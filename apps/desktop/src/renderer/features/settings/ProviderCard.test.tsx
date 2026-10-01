import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { appError } from '@relay/contracts';
import { renderApp } from '../testing/render-app';

describe('ProviderCard error actions', () => {
  it('a BUDGET_BLOCKED connection test offers "Increase allowance", which opens Storage & data', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp('/settings/providers', { scenario: 'awaiting-approval' });
    const anthropic = await screen.findByRole('region', { name: 'Anthropic' });
    bridge.failNext('relay/v1/providers.test', appError('BUDGET_BLOCKED'));

    await user.click(within(anthropic).getByRole('button', { name: 'Test connection' }));
    const action = await within(anthropic).findByRole('button', { name: 'Increase allowance' });
    expect(action.closest('[role="alert"]')).toHaveTextContent('Error code BUDGET_BLOCKED');
    expect(router.state.location.pathname).toBe('/settings/providers');
    await user.click(action);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/data');
    });
  });
});
