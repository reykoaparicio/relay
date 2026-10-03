import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { RunEvent } from '@relay/contracts';
import { fakeId, T0 } from '../../components/ui/test-fixtures';
import { EVENTS_VIRTUALIZE_THRESHOLD, EventsList } from './InspectorPanels';

function events(n: number): RunEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: fakeId('evt', i + 1) as RunEvent['id'],
    runId: fakeId('run', 1) as RunEvent['runId'],
    seq: i + 1,
    type: 'step.state_changed',
    at: (T0 + i * 1000) as RunEvent['at'],
    payload: { stepKey: 'review', to: 'running' },
  }));
}

const restore: (() => void)[] = [];
/** jsdom has no layout: give elements a 480 × 800 box so the virtualizer has a viewport to fill. */
function stubLayout() {
  for (const [prop, value] of [['offsetHeight', 480], ['offsetWidth', 800]] as const) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
    restore.push(() => {
      if (original !== undefined) Object.defineProperty(HTMLElement.prototype, prop, original);
    });
  }
}
afterEach(() => {
  for (const r of restore.splice(0)) r();
});

describe('EventsList', () => {
  it('renders every event as a plain list up to the threshold', () => {
    render(<EventsList events={events(EVENTS_VIRTUALIZE_THRESHOLD)} loaded />);

    const list = screen.getByRole('list', { name: 'Events for this step' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(EVENTS_VIRTUALIZE_THRESHOLD);
    expect(screen.queryByRole('region', { name: /scrollable/ })).not.toBeInTheDocument();
  });

  it('virtualizes a long list: a keyboard-reachable scroll region renders a window of rows, not all of them', () => {
    const total = 5_000;
    stubLayout();

    render(<EventsList events={events(total)} loaded />);

    const region = screen.getByRole('region', { name: 'Events for this step, scrollable' });
    expect(region).toHaveAttribute('tabindex', '0');
    const rows = within(region).getAllByRole('listitem');
    // 480px / 32px rows = 15 visible + 20 overscan: a window of tens of rows out of 5,000.
    expect(rows.length).toBeGreaterThanOrEqual(15);
    expect(rows.length).toBeLessThan(100);
    expect(rows[0]).toHaveTextContent(/^#1 · /); // the window starts at the first event (seq 1)
    const ol = region.querySelector('ol') as HTMLElement;
    expect(ol.style.height).toBe(`${String(total * 32)}px`); // full scroll height is reserved for all rows
  });
});

describe('run.config_revised summary (L-1)', () => {
  const revised = (payload: Record<string, unknown>): RunEvent => ({
    id: fakeId('evt', 1) as RunEvent['id'], runId: fakeId('run', 1) as RunEvent['runId'], seq: 1, type: 'run.config_revised',
    at: T0 as RunEvent['at'], payload,
  });

  it('names the lowered output limit when a profile switch lowered it', () => {
    render(<EventsList events={[revised({ stepKey: 'review', outputLimitLowered: { to: 64_000, from: 100_000, modelId: 'claude-haiku-4-5' } })]} loaded />);
    expect(screen.getByText(/output limit lowered to 64,000 for claude-haiku-4-5/)).toBeInTheDocument();
  });

  it('stays generic otherwise', () => {
    render(<EventsList events={[revised({ stepKey: 'review' })]} loaded />);
    expect(screen.getByText(/Run configuration revised/)).toBeInTheDocument();
    expect(screen.queryByText(/output limit lowered/)).not.toBeInTheDocument();
  });
});
