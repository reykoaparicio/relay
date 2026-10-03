import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeBridge, FAKE_PROJECT_ID } from '../api/fake-bridge';
import { buildRun, DAY } from '../api/fake-scenarios/world';
import { renderApp } from '../features/testing/render-app';

const RUNS = `/p/${FAKE_PROJECT_ID}/runs`;

describe('RunsPage', () => {
  it('list: renders the history table with the run link first and every mock column', async () => {
    const { bridge } = renderApp(RUNS, { scenario: 'awaiting-approval' });
    const table = await screen.findByRole('table', { name: /Runs in Example API, newest first/ });
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Run', 'Goal', 'Workflow version', 'Status', 'Steps', 'Tracked cost', 'Started', 'Duration']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(bridge.world.runs.length);
    const first = bridge.world.runs[0];
    const link = within(rows[0] as HTMLElement).getAllByRole('link')[0];
    expect(link?.getAttribute('href')).toBe(`#/p/${FAKE_PROJECT_ID}/runs/${first?.id ?? ''}`);
    expect(within(rows[0] as HTMLElement).getByText('Awaiting your approval')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText('v3')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText('3/6')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: /older runs/ })).not.toBeInTheDocument();
  });

  it('filtered: the status filter uses tabs and the URL (?status=)', async () => {
    const { bridge, router } = renderApp(`${RUNS}?status=attention`, { scenario: 'budget-paused' });
    const table = await screen.findByRole('table');
    expect(screen.getByRole('tab', { name: 'Needs attention' })).toHaveAttribute('aria-selected', 'true');
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(1);
    expect(within(table).getByText('Paused: run budget')).toBeInTheDocument();
    const listCall = bridge.callsTo('relay/v1/runs.list').find((c) => (c.input as { status?: string[] }).status?.includes('paused'));
    expect(listCall).toBeDefined();

    await userEvent.click(screen.getByRole('tab', { name: 'Finished' }));
    await waitFor(() => {
      expect(router.state.location.search).toBe('?status=finished');
    });
    await userEvent.click(screen.getByRole('tab', { name: 'All' }));
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
  });

  it('empty: no runs yet offers to start a workflow', async () => {
    renderApp(RUNS, { scenario: 'empty' });
    expect(await screen.findByRole('heading', { name: 'No runs yet' })).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Start a workflow' });
    for (const l of links) expect(l.getAttribute('href')).toBe(`/p/${FAKE_PROJECT_ID}/runs/new`);
  });

  it('filtered to nothing: explains the filter and offers to show all', async () => {
    renderApp(`${RUNS}?status=active`, { scenario: 'completed' });
    expect(await screen.findByRole('heading', { name: 'No runs match this filter' })).toBeInTheDocument();
  });

  it('"Load older runs" fetches the next page with the cursor', async () => {
    const bridge = createFakeBridge('completed');
    const now = Date.now();
    const extra = Array.from({ length: 30 }, (_, i) =>
      buildRun(now, { n: 100 + i, goal: `Older run ${String(i)}`, status: 'completed', agoMs: (10 + i) * DAY, durationMs: 60_000, steps: {}, cost: { reported: 10_000 } }).run,
    );
    bridge.world.runs = [...bridge.world.runs, ...extra];
    renderApp(RUNS, { bridge });
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(25);
    await userEvent.click(screen.getByRole('button', { name: 'Load older runs' }));
    await waitFor(() => {
      expect(within(screen.getByRole('table')).getAllByRole('row').slice(1)).toHaveLength(bridge.world.runs.length);
    });
    const cursors = bridge.callsTo('relay/v1/runs.list').map((c) => (c.input as { cursor?: string }).cursor);
    expect(cursors).toContain('25');
  });

  it('shows cost certainty as text and links cost to the ledger', async () => {
    renderApp(RUNS, { scenario: 'interrupted' });
    const table = await screen.findByRole('table');
    expect(within(table).getAllByText('reported').length).toBeGreaterThan(0);
    // Decision 1: a total that includes an estimate reads "~$…" with an "estimated" tag; never "unknown".
    expect(within(table).getAllByText('estimated').length).toBeGreaterThan(0);
    expect(within(table).getAllByText(/^~\$/).length).toBeGreaterThan(0);
    expect(screen.getByRole('main')).not.toHaveTextContent(/unknown/i);
    for (const link of within(table).getAllByRole('link', { name: /open the ledger/ })) {
      expect(link.getAttribute('href')).toMatch(/\?tab=ledger$/);
    }
  });

  it('records relay:nav:runs and relay:history-loaded when the first page renders', async () => {
    renderApp(RUNS, { scenario: 'completed' });
    await screen.findByRole('table');
    await waitFor(() => {
      expect(performance.getEntriesByName('relay:nav:runs', 'measure')).toHaveLength(1);
      expect(performance.getEntriesByName('relay:history-loaded', 'mark')).toHaveLength(1);
      expect(performance.getEntriesByName('relay:history-loaded', 'measure')).toHaveLength(1);
    });
  });

  describe('B6: durations are live', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a running run duration ticks (not frozen at mount)', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      const { bridge } = renderApp(RUNS, { scenario: 'active-run' });
      const table = await screen.findByRole('table');
      const running = bridge.world.runs.find((r) => r.status === 'running');
      expect(running).toBeDefined();
      const index = bridge.world.runs.indexOf(running as (typeof bridge.world.runs)[number]);
      const row = within(table).getAllByRole('row').slice(1)[index] as HTMLElement;
      const durationCell = () => within(row).getAllByRole('cell').at(-1)?.textContent;
      const before = durationCell();
      act(() => {
        vi.advanceTimersByTime(65_000);
      });
      expect(durationCell()).not.toBe(before);
    });
  });
});
