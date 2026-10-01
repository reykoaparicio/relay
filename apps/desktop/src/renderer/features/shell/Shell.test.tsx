import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeBridge, FAKE_PROJECT_ID } from '../../api/fake-bridge';
import { sid } from '../../api/fake-scenarios/world';
import { renderApp } from '../testing/render-app';

const OTHER_PROJECT = sid('project', 9);

function twoProjects() {
  const bridge = createFakeBridge('awaiting-approval');
  const first = bridge.world.projects[0];
  if (first === undefined) throw new Error('no project');
  bridge.world.projects.push({ ...first, id: OTHER_PROJECT as typeof first.id, name: 'Billing service', rootDisplayPath: '~/code/billing' });
  return bridge;
}

describe('Shell ProjectSwitcher (J4)', () => {
  it('shows the active project, lists every project, and switching navigates and saves activeProjectId', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp(`/p/${FAKE_PROJECT_ID}`, { bridge: twoProjects() });
    const trigger = await screen.findByRole('button', { name: /Example API, switch project/ });

    await user.click(trigger);
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['Example API~/code/example-api', 'Billing service~/code/billing']);
    expect(within(menu).getByRole('menuitemradio', { name: /Example API/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(menu).getByRole('menuitemradio', { name: /Billing service/ }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/p/${OTHER_PROJECT}`);
    });
    expect(bridge.callsTo('relay/v1/app.updateSettings').map((c) => c.input)).toContainEqual({ activeProjectId: OTHER_PROJECT });
    expect(await screen.findByRole('button', { name: /Billing service, switch project/ })).toBeInTheDocument();
  });

  it('"Add project" opens onboarding at the folder step', async () => {
    const user = userEvent.setup();
    const { router } = renderApp(`/p/${FAKE_PROJECT_ID}`, { scenario: 'awaiting-approval' });

    await user.click(await screen.findByRole('button', { name: /switch project/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add project' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/onboarding/select-project');
    });
  });
});

describe('Shell runner banner (08 H6 → J4)', () => {
  it('follows runner.state pushes: restarting (info), unavailable (alert + diagnostics), back to ready (gone)', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp(`/p/${FAKE_PROJECT_ID}`, { scenario: 'awaiting-approval' });
    await screen.findByRole('button', { name: /switch project/ });
    expect(screen.queryByText(/Background runner/)).not.toBeInTheDocument();

    act(() => {
      bridge.emit({ type: 'runner.state', state: 'restarting' });
    });
    const restarting = (await screen.findByText('Background runner restarting…')).closest('[role="status"]') as HTMLElement;
    expect(restarting).toHaveTextContent('Runs continue from their last checkpoint when it is back.');
    expect(screen.queryByRole('button', { name: 'Open diagnostics' })).not.toBeInTheDocument();

    act(() => {
      bridge.emit({ type: 'runner.state', state: 'unavailable' });
    });
    const alert = (await screen.findByText('The background runner is unavailable')).closest('[role="alert"]') as HTMLElement;
    expect(alert).toHaveTextContent('Runs are paused safely. Relay could not restart the runner automatically.');
    expect(screen.queryByText('Background runner restarting…')).not.toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Open diagnostics' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/diagnostics');
    });

    act(() => {
      bridge.emit({ type: 'runner.state', state: 'ready' });
    });
    await waitFor(() => {
      expect(screen.queryByText('The background runner is unavailable')).not.toBeInTheDocument();
    });
  });
});
