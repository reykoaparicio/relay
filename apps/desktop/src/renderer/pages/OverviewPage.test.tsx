import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeBridge, FAKE_PROJECT_ID } from '../api/fake-bridge';
import { buildRun, DAY } from '../api/fake-scenarios/world';
import { renderApp } from '../features/testing/render-app';

const OVERVIEW = `/p/${FAKE_PROJECT_ID}`;

async function ready() {
  await screen.findByRole('heading', { level: 1, name: 'Project overview' });
  await screen.findByRole('table', { name: /most recent runs/i }).catch(() => undefined);
}

describe('OverviewPage', () => {
  it('awaiting-approval: the attention card targets the exact approval step', async () => {
    const { bridge } = renderApp(OVERVIEW, { scenario: 'awaiting-approval' });
    const card = await screen.findByRole('region', { name: 'Needs your attention' });
    const run = bridge.world.runs.find((r) => r.status === 'awaiting_approval');
    const approvalStep = run?.steps.find((s) => s.state === 'awaiting_approval');
    expect(approvalStep).toBeDefined();
    const inspect = within(card).getByRole('link', { name: 'Inspect plan' });
    expect(inspect.getAttribute('href')).toBe(`/p/${FAKE_PROJECT_ID}/runs/${run?.id ?? ''}?step=${approvalStep?.id ?? ''}`);
    expect(within(card).getByText('Awaiting your approval')).toBeInTheDocument();
    expect(within(card).getByText('No project files have been modified.')).toBeInTheDocument();
    // Runs nav badge counts the run waiting for approval (screen-reader text, not color only).
    expect(await screen.findByText('1 waiting for approval')).toBeInTheDocument();
  });

  it('runs that need nothing: recent runs move up beside run controls, leaving no empty grid cell', async () => {
    renderApp(OVERVIEW, { scenario: 'completed' });
    const recent = await screen.findByRole('region', { name: 'Recent runs' });
    const controls = screen.getByRole('region', { name: 'Run controls' });
    expect(screen.queryByRole('region', { name: 'Start your first run' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Needs your attention' })).toBeNull();
    expect(recent.parentElement).toBe(controls.parentElement);
    expect(recent.parentElement?.firstElementChild).toBe(recent);
  });

  it('usage tile says "tracked by Relay" and links to the latest run ledger; run budget values link to ?tab=ledger', async () => {
    const { bridge } = renderApp(OVERVIEW, { scenario: 'awaiting-approval' });
    await ready();
    const latest = bridge.world.runs[0];
    const usage = await screen.findByRole('link', { name: 'Open usage ledger' });
    expect(usage.getAttribute('href')).toBe(`/p/${FAKE_PROJECT_ID}/runs/${latest?.id ?? ''}?tab=ledger`);
    const tile = usage.closest('.stat');
    expect(tile).not.toBeNull();
    expect(tile).toHaveTextContent('Usage tracked by Relay');
    expect(tile).toHaveTextContent('Your provider account bill may be higher');
    // Memory tile: the suggestions link is a secondary action (never nested in another link).
    expect(screen.getByRole('link', { name: /suggestions? to review/ }).getAttribute('href')).toMatch(/\/memory\?tab=suggested$/);

    const table = await screen.findByRole('table', { name: /most recent runs/i });
    const ledgerLinks = within(table).getAllByRole('link', { name: /open the ledger/i });
    expect(ledgerLinks).toHaveLength(3);
    for (const link of ledgerLinks) expect(link.getAttribute('href')).toMatch(/\/runs\/run_\w+\?tab=ledger$/);

    const controls = screen.getByRole('region', { name: 'Run controls' });
    const budget = within(controls).getByRole('link', { name: /\$3\.00/ });
    expect(budget.getAttribute('href')).toMatch(/\?tab=ledger$/);
    expect(within(controls).getByText(/tracked by Relay/)).toBeInTheDocument();
  });

  it('active-run: shows the running step and pauses through runs.pause', async () => {
    const { bridge } = renderApp(OVERVIEW, { scenario: 'active-run' });
    const card = await screen.findByRole('region', { name: 'Active run' });
    expect(within(card).getByText(/Step 2 of 6/)).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: /Run allowance/ })).toBeInTheDocument();
    expect(screen.getByText('Running · step 2 of 6')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Pause after this step' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.pause')).toHaveLength(1);
    });
    // Once paused, the run waits for the user (Resume): the attention card names the pause and links its step.
    const attention = await screen.findByRole('region', { name: 'Needs your attention' }, { timeout: 3000 });
    expect(attention).toHaveTextContent('Paused by you');
    // The Active runs hint and the Runs nav badge both count it.
    expect(screen.getAllByText('1 paused run needs you')).toHaveLength(2);
  });

  it('empty: offers the sample project and the template; the sample is created with an idempotency key', async () => {
    const { bridge, router } = renderApp(OVERVIEW, { scenario: 'empty' });
    await screen.findByRole('heading', { name: 'Start your first run' });
    expect(screen.getByRole('link', { name: 'Start: Review & propose a fix' }).getAttribute('href')).toBe(`/p/${FAKE_PROJECT_ID}/runs/new`);
    expect(screen.getByText('No runs yet')).toBeInTheDocument();
    expect(await screen.findByText(/No runs yet\. Runs you start appear here/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Try the sample project' });
    await userEvent.click(button);
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/projects.createSample')).toHaveLength(1);
    });
    const input = bridge.callsTo('relay/v1/projects.createSample')[0]?.input as { idempotencyKey: string };
    expect(input.idempotencyKey).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await waitFor(() => {
      expect(router.state.location.pathname).not.toBe(OVERVIEW);
    });
  });

  it('interrupted: banner + RecoveryPanel with the unresolved liability', async () => {
    renderApp(OVERVIEW, { scenario: 'interrupted' });
    expect(await screen.findByText(/was interrupted/)).toBeInTheDocument();
    const recovery = await screen.findByRole('region', { name: 'Recovery' });
    expect(within(recovery).getByText('Requests with an unknown outcome')).toBeInTheDocument();
    // Continue from last checkpoint is offered only once every unknown request is decided (engine E1 #8).
    expect(within(recovery).getByRole('button', { name: 'Decide on unknown charge' })).toBeInTheDocument();
    expect(within(recovery).queryByRole('button', { name: 'Continue from last checkpoint' })).not.toBeInTheDocument();
    const review = screen.getByRole('link', { name: 'Review recovery options' });
    expect(review.getAttribute('href')).toMatch(/\/runs\/run_\w+\?step=stp_\w+$/);
    expect(screen.getByText('1 interrupted run needs a decision')).toBeInTheDocument();
  });

  it('unknown-outcome pause also renders the recovery state', async () => {
    renderApp(OVERVIEW, { scenario: 'unknown-outcome' });
    expect(await screen.findByText(/paused: unknown request outcome/)).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Recovery' })).toBeInTheDocument();
  });

  it('provider-disconnected: names the provider, shows the redacted key and a reconnect link', async () => {
    renderApp(OVERVIEW, { scenario: 'provider-disconnected' });
    const banner = await screen.findByText('Authentication failed for OpenAI');
    const alert = banner.closest('.banner');
    expect(alert).not.toBeNull();
    expect(within(alert as HTMLElement).getByText('sk-…Q7d2')).toBeInTheDocument();
    const reconnect = within(alert as HTMLElement).getByRole('link', { name: 'Reconnect OpenAI' });
    expect(reconnect.getAttribute('href')).toBe('/settings/providers');
    expect(await screen.findByText('1 of 2 providers connected')).toBeInTheDocument();
  });

  it('auth-failed run pause also triggers the provider banner', async () => {
    renderApp(OVERVIEW, { scenario: 'auth-failed' });
    expect(await screen.findByText('Authentication failed for OpenAI')).toBeInTheDocument();
  });

  it('records the relay:nav:overview measure once the primary data rendered', async () => {
    renderApp(OVERVIEW, { scenario: 'completed' });
    await screen.findByRole('table', { name: /most recent runs/i });
    await waitFor(() => {
      expect(performance.getEntriesByName('relay:nav:overview', 'measure')).toHaveLength(1);
    });
  });

  it('shows the fake provider badge in fake mode', async () => {
    renderApp(OVERVIEW, { scenario: 'completed' });
    expect(await screen.findByText('Fake provider: no real model calls')).toBeInTheDocument();
  });

  describe('B7: counts and attention come from status-filtered queries (more than one page of runs)', () => {
    it('finds the awaiting run behind 30 newer running runs and counts all active runs', async () => {
      const bridge = createFakeBridge('completed');
      const now = Date.now();
      const running = Array.from({ length: 30 }, (_, i) =>
        buildRun(now, { n: 200 + i, goal: `Running ${String(i)}`, status: 'running', agoMs: 60_000 + i, durationMs: 0, steps: {}, cost: {} }).run,
      );
      const awaiting = buildRun(now, {
        n: 300,
        goal: 'Old approval',
        status: 'awaiting_approval',
        agoMs: 5 * DAY,
        durationMs: 0,
        steps: { plan: 'succeeded', approve: 'awaiting_approval' },
        cost: {},
      }).run;
      bridge.world.runs = [...running, ...bridge.world.runs, awaiting];
      renderApp(OVERVIEW, { bridge });
      const summary = await screen.findByRole('region', { name: 'Project summary' });
      await waitFor(() => {
        expect(within(summary).getByText('31')).toBeInTheDocument();
      });
      expect(within(summary).getByText('Waiting for your approval')).toBeInTheDocument();
      const lists = bridge.callsTo('relay/v1/runs.list').map((c) => c.input as { status?: string[]; limit?: number });
      expect(lists).toContainEqual(expect.objectContaining({ status: ['awaiting_approval'], limit: 1 }));
    });

    it('shows "100+" when more active runs exist than one page', async () => {
      const bridge = createFakeBridge('completed');
      const now = Date.now();
      const running = Array.from({ length: 120 }, (_, i) =>
        buildRun(now, { n: 400 + i, goal: `Running ${String(i)}`, status: 'running', agoMs: 60_000 + i, durationMs: 0, steps: {}, cost: {} }).run,
      );
      bridge.world.runs = [...running, ...bridge.world.runs];
      renderApp(OVERVIEW, { bridge });
      const summary = await screen.findByRole('region', { name: 'Project summary' });
      expect(await within(summary).findByText('100+')).toBeInTheDocument();
    });
  });

  describe('B6: the clock is live', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('the usage month label follows the current month', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(new Date(2026, 8, 30, 23, 59, 30));
      renderApp(OVERVIEW, { scenario: 'completed' });
      const summary = await screen.findByRole('region', { name: 'Project summary' });
      expect(await within(summary).findByText('September')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(within(summary).getByText('October')).toBeInTheDocument();
    });
  });
});
