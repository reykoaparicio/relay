// Decision 2 pause flows in the UI, ported from the bug hunt on f8c9f0f: U-3 "Pausing…" comes from
// RunDetail.pauseRequested (it survives leaving and reopening the run), U-2 the Overview pause control shows the
// pending pause, U-1 pausing while awaiting approval and resuming brings the approval card back (fake keeps it).
import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeBridge, FAKE_PROJECT_ID } from '../api/fake-bridge';
import { renderApp } from '../features/testing/render-app';

const P = `/p/${FAKE_PROJECT_ID}`;
const PAUSING = 'Pausing after the current request…';

async function inspectorReady(): Promise<void> {
  await screen.findByRole('heading', { level: 1, name: 'Run inspection' });
  await screen.findByRole('tablist', { name: 'Step details' });
}

describe('pause pending state', () => {
  it('U-3: a pending pause (request in flight) is still shown after leaving the inspector and coming back', async () => {
    const user = userEvent.setup();
    const bridge = createFakeBridge('active-run');
    bridge.world.pauseDelayMs = 60_000;
    const run = bridge.world.runs[0];
    if (run === undefined) throw new Error('no run');
    const { router } = renderApp(`${P}/runs/${run.id}`, { bridge });
    await inspectorReady();
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText(PAUSING)).toBeInTheDocument();

    await act(async () => {
      await router.navigate(`${P}/runs`);
    });
    await waitFor(() => expect(screen.queryByRole('heading', { level: 1, name: 'Run inspection' })).not.toBeInTheDocument());
    await act(async () => {
      await router.navigate(`${P}/runs/${run.id}`);
    });
    await inspectorReady();

    expect(bridge.world.runs[0]?.status).toBe('running'); // the pause is still pending in the backend
    expect(await screen.findByText(PAUSING)).toBeInTheDocument();
  });

  it('U-2: the Overview pause control says "Pausing…" and is disabled while the pause waits for the request', async () => {
    const user = userEvent.setup();
    const bridge = createFakeBridge('active-run');
    bridge.world.pauseDelayMs = 60_000;
    renderApp(P, { bridge });
    const button = await screen.findByRole('button', { name: 'Pause after the current request' });

    await user.click(button);

    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.pause')).toHaveLength(1);
    });
    const pausing = await screen.findByRole('button', { name: 'Pausing…' });
    expect(pausing).toBeDisabled();
    expect(bridge.world.runs[0]?.status).toBe('running');
  });

  it('U-1: pause while awaiting approval, then resume: the approval card is back and decidable', async () => {
    const user = userEvent.setup();
    const bridge = createFakeBridge('awaiting-approval');
    const run = bridge.world.runs[0];
    if (run === undefined) throw new Error('no run');
    renderApp(`${P}/runs/${run.id}`, { bridge });
    await inspectorReady();
    await within(await screen.findByRole('region', { name: 'Proposed plan' })).findByRole('button', { name: 'Approve plan' });

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await user.click(await screen.findByRole('button', { name: 'Resume' }));

    await waitFor(() => {
      expect(bridge.world.runs[0]?.status).toBe('awaiting_approval');
    });
    const plan = await screen.findByRole('region', { name: 'Proposed plan' }, { timeout: 2000 });
    expect(await within(plan).findByRole('button', { name: 'Approve plan' })).toBeEnabled();
  });
});
