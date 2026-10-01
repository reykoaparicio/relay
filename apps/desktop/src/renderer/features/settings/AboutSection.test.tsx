import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { errors } from '@relay/contracts';
import { renderApp } from '../testing/render-app';
import { ELECTRON_LICENSE_URL } from './DiagnosticsSection';

const MIT_REACT = 'MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates.';
const notices = vi.hoisted(() => ({
  value: {
    partial: false,
    packageCount: 5,
    groups: [
      {
        license: 'MIT',
        text: 'MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates.',
        packages: [
          { name: 'react', version: '19.3.0' },
          { name: 'react-dom', version: '19.3.0' },
          { name: 'scheduler', version: '0.27.0' },
          { name: 'use-sync-external-store', version: '1.6.0' },
        ],
      },
      { license: 'ISC', text: 'ISC License\n\nCopyright (c) Lucide Contributors', packages: [{ name: 'lucide-react', version: '1.49.0' }] },
    ],
  },
}));
// The loader is mocked: the virtual module only exists in builds with the notices plugin.
vi.mock('./third-party-notices', () => ({ loadThirdPartyNotices: () => Promise.resolve(notices.value) }));

async function about() {
  await screen.findByRole('heading', { level: 1, name: 'Settings' });
  return screen.findByRole('heading', { level: 2, name: 'About' });
}

describe('Settings → About', () => {
  it('lists the bundled packages as one <details> per license group, and points to the Chromium notices', async () => {
    renderApp('/settings/about', { scenario: 'awaiting-approval' });
    await about();

    expect(screen.getByRole('heading', { level: 3, name: 'Third-party licenses' })).toBeInTheDocument();
    expect(await screen.findByText(/includes 5 open-source packages/)).toBeInTheDocument();
    expect(screen.getByText('LICENSES.chromium.html')).toBeInTheDocument();
    const groups = document.querySelectorAll('details');
    expect(groups).toHaveLength(2);
    const mit = groups[0] as HTMLElement;
    expect(mit.querySelector('summary')).toHaveTextContent('MIT · react@19.3.0, react-dom@19.3.0, scheduler@0.27.0 +1 more');
    expect(within(mit).getByText(/use-sync-external-store@1\.6\.0/)).toBeInTheDocument();
    expect(within(mit).getByLabelText(/^License text for react@19\.3\.0/)).toHaveTextContent('Copyright (c) Meta Platforms');
    expect(screen.queryByText(/later milestone/)).not.toBeInTheDocument();
    expect(screen.queryByText(/does not include the full list/)).not.toBeInTheDocument();
  });

  it('copies a group\'s license text with its CopyButton', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderApp('/settings/about', { scenario: 'awaiting-approval' });
    await about();
    const mit = (await screen.findAllByRole('group')).find((d) => d.tagName === 'DETAILS') ?? document.querySelectorAll('details')[0];

    await user.click(within(mit as HTMLElement).getByRole('button', { name: /^Copy license text \(MIT:/ }));

    expect(writeText).toHaveBeenCalledWith(MIT_REACT);
    writeText.mockRestore();
  });

  it('says the list is incomplete when the build marked it partial', async () => {
    const saved = notices.value;
    notices.value = { ...saved, partial: true };
    try {
      renderApp('/settings/about', { scenario: 'awaiting-approval' });
      await about();

      expect(await screen.findByText(/This list is incomplete for this build/)).toBeInTheDocument();
    } finally {
      notices.value = saved;
    }
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
