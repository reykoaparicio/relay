import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { errors } from '@relay/contracts';
import { renderApp } from '../testing/render-app';
import { ELECTRON_LICENSE_URL } from './DiagnosticsSection';

async function about() {
  await screen.findByRole('heading', { level: 1, name: 'Settings' });
  return screen.findByRole('heading', { level: 2, name: 'About' });
}

describe('Settings → About', () => {
  it('states that third-party notices are not bundled yet (no "later milestone" stub copy)', async () => {
    renderApp('/settings/about', { scenario: 'awaiting-approval' });
    await about();

    expect(screen.getByRole('heading', { level: 3, name: 'Third-party licenses' })).toBeInTheDocument();
    expect(screen.getByText(/does not include the full list of third-party license notices/)).toBeInTheDocument();
    expect(screen.queryByText(/later milestone/)).not.toBeInTheDocument();
  });

  it('the Electron license link goes through app.openExternal (main confirms; the renderer never navigates)', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp('/settings/about', { scenario: 'awaiting-approval' });
    await about();

    await user.click(screen.getByRole('button', { name: /Electron license/ }));

    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/app.openExternal').map((c) => c.input)).toEqual([{ url: ELECTRON_LICENSE_URL }]);
    });
    expect(ELECTRON_LICENSE_URL.startsWith('https://')).toBe(true);
    expect(router.state.location.pathname).toBe('/settings/about');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a refused openExternal shows the error', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp('/settings/about', { scenario: 'awaiting-approval' });
    await about();
    bridge.failNext('relay/v1/app.openExternal', errors.permissionDenied('outside_root'));

    await user.click(screen.getByRole('button', { name: /Electron license/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('PERMISSION_DENIED');
  });
});
