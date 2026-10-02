import { lazy } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import type { RouteObject } from 'react-router';
import { App } from '../../App';
import { installBridge } from '../../api/bridge';
import { createFakeBridge, FAKE_PROJECT_ID } from '../../api/fake-bridge';
import { createTestQueryClient } from '../../components/ui/test-utils';
import { routes } from '../../router';
import { reloadApp } from './reload';

vi.mock('./reload', () => ({ reloadApp: vi.fn() }));

afterEach(() => {
  vi.mocked(reloadApp).mockClear();
});

/** The app routes with the Memory page's lazy chunk failing to load (as a rejected dynamic import does). */
function withFailingMemoryPage(rs: readonly RouteObject[]): RouteObject[] {
  const Failing = lazy(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')));
  const swap = (list: readonly RouteObject[]): RouteObject[] =>
    list.map((r) =>
      r.id === 'memory' ? ({ ...r, element: <Failing /> }) : r.children === undefined ? r : ({ ...r, children: swap(r.children) }),
    );
  return swap(rs);
}

function renderAt(path: string) {
  installBridge(createFakeBridge('awaiting-approval'));
  const router = createMemoryRouter(withFailingMemoryPage(routes), { initialEntries: [path] });
  render(<App queryClient={createTestQueryClient()} router={router} />);
  return router;
}

describe('page error boundary (lazy page load failure)', () => {
  it('replaces only the page: the shell and its navigation stay usable, Reload reloads the window', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // React logs the caught error
    const user = userEvent.setup();
    const router = renderAt(`/p/${FAKE_PROJECT_ID}/memory`);

    expect(await screen.findByRole('heading', { level: 1, name: 'This page failed to load' })).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Reload the window to try again/);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getAllByRole('link').length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Something went wrong' })).not.toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    expect(reloadApp).toHaveBeenCalledTimes(1);

    // Navigating away clears the page error; the other pages still load.
    await user.click(within(nav).getByRole('link', { name: /Runs/ }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/p/${FAKE_PROJECT_ID}/runs`);
    });
    expect(await screen.findByRole('heading', { level: 1, name: /Runs/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'This page failed to load' })).not.toBeInTheDocument();
  });
});
