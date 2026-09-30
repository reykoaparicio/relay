import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { runEventSchema } from '@relay/contracts';
import type { RunEvent } from '@relay/contracts';
import type * as ui from '../components/ui';
import { createTestQueryClient } from '../components/ui/test-utils';
import { installBridge } from '../api/bridge';
import { createFakeBridge } from '../api/fake-bridge';
import type { FakeBridge } from '../api/fake-bridge';
import { statusAnnouncement, useRunEvents } from './useRunEvents';

type UiModule = typeof ui;
const announceSpy = vi.hoisted(() => vi.fn());
vi.mock('../components/ui', async (importOriginal) => ({
  ...(await importOriginal<UiModule>()),
  useLiveRegion: () => ({ announce: announceSpy }),
}));

beforeEach(() => {
  announceSpy.mockReset();
});

function setup() {
  const announce = announceSpy;
  const bridge = createFakeBridge('active-run');
  installBridge(bridge);
  const run = bridge.world.runs[0];
  if (run === undefined) throw new Error('scenario has no run');
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { readonly children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useRunEvents(run.id), { wrapper });
  return { bridge, run, hook, announce, queryClient };
}

function event(bridge: FakeBridge, runId: string, seq: number, type: RunEvent['type'], payload: Record<string, unknown> = {}): RunEvent {
  return runEventSchema.parse({ id: `evt_${String(9000 + seq).padStart(26, '0')}`, runId, seq, type, at: Date.now(), payload });
}

/** Appends an event to the fake's store (so a backfill can find it) without pushing it. */
function store(bridge: FakeBridge, e: RunEvent) {
  bridge.world.events.set(e.runId, [...(bridge.world.events.get(e.runId) ?? []), e]);
}

describe('useRunEvents (gapless contract, 02 §B5)', () => {
  it('loads from afterSeq 0 on mount', async () => {
    const { bridge, run, hook } = setup();
    const stored = bridge.world.events.get(run.id) ?? [];
    await waitFor(() => {
      expect(hook.result.current.loaded).toBe(true);
    });
    expect(bridge.callsTo('relay/v1/runs.events')[0]?.input).toMatchObject({ runId: run.id, afterSeq: 0 });
    expect(hook.result.current.events.map((e) => e.seq)).toEqual(stored.map((e) => e.seq));
  });

  it('appends seq === last + 1, ignores duplicates, and backfills a gap', async () => {
    const { bridge, run, hook } = setup();
    await waitFor(() => {
      expect(hook.result.current.loaded).toBe(true);
    });
    const last = hook.result.current.lastSeq;

    const next = event(bridge, run.id, last + 1, 'step.state_changed', { stepKey: 'review' });
    store(bridge, next);
    act(() => {
      bridge.emit({ type: 'run.event', event: next });
    });
    expect(hook.result.current.lastSeq).toBe(last + 1);

    // Duplicate push: ignored.
    act(() => {
      bridge.emit({ type: 'run.event', event: next });
    });
    expect(hook.result.current.events.filter((e) => e.seq === last + 1)).toHaveLength(1);

    // Gap: seq last+3 arrives while last+2 was missed → backfill runs.events({ afterSeq: last+1 }).
    const missed = event(bridge, run.id, last + 2, 'attempt.created', { stepKey: 'review' });
    const later = event(bridge, run.id, last + 3, 'attempt.settled', { stepKey: 'review' });
    store(bridge, missed);
    store(bridge, later);
    const callsBefore = bridge.callsTo('relay/v1/runs.events').length;
    act(() => {
      bridge.emit({ type: 'run.event', event: later });
    });
    await waitFor(() => {
      expect(hook.result.current.lastSeq).toBe(last + 3);
    });
    const backfills = bridge.callsTo('relay/v1/runs.events').slice(callsBefore);
    expect(backfills[0]?.input).toMatchObject({ runId: run.id, afterSeq: last + 1 });
    const seqs = hook.result.current.events.map((e) => e.seq);
    expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));
    expect(seqs.at(-3)).toBe(last + 1);
  });

  it('announces only status transitions (never stream progress)', async () => {
    const { bridge, run, hook, announce } = setup();
    await waitFor(() => {
      expect(hook.result.current.loaded).toBe(true);
    });
    const last = hook.result.current.lastSeq;
    // History loaded on mount is not announced.
    expect(announce).not.toHaveBeenCalled();

    act(() => {
      bridge.emit({
        type: 'run.event',
        event: event(bridge, run.id, last + 1, 'attempt.stream_progress', { stepKey: 'review', outputTokensSoFar: 900, elapsedMs: 4_000 }),
      });
    });
    act(() => {
      bridge.emit({ type: 'run.event', event: event(bridge, run.id, last + 2, 'run.status_changed', { from: 'running', to: 'running' }) });
    });
    expect(announce).not.toHaveBeenCalled();

    act(() => {
      bridge.emit({
        type: 'run.event',
        event: event(bridge, run.id, last + 3, 'run.status_changed', { from: 'running', to: 'awaiting_approval', pauseReason: null }),
      });
    });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Run status: Awaiting your approval.');
  });

  it('invalidates run and ledger queries, debounced 250 ms, for live events only', async () => {
    const { bridge, run, hook, queryClient } = setup();
    await waitFor(() => {
      expect(hook.result.current.loaded).toBe(true);
    });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.useFakeTimers();
    try {
      const last = hook.result.current.lastSeq;
      act(() => {
        bridge.emit({ type: 'run.event', event: event(bridge, run.id, last + 1, 'ledger.settled', { stepKey: 'review' }) });
        bridge.emit({ type: 'run.event', event: event(bridge, run.id, last + 2, 'attempt.settled', { stepKey: 'review' }) });
      });
      expect(spy).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(250);
      });
      const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(['run', run.id]);
      expect(keys).toContainEqual(['ledger', run.id]);
      expect(spy).toHaveBeenCalledTimes(3); // run, ledger, step — once for both events
    } finally {
      vi.useRealTimers();
    }
  });

  it('statusAnnouncement covers the announced statuses and nothing else', () => {
    const e = (to: string, pauseReason: string | null = null) =>
      runEventSchema.parse({ id: 'evt_00000000000000000000000001', runId: 'run_00000000000000000000000001', seq: 1, type: 'run.status_changed', at: 1, payload: { to, pauseReason } });
    expect(statusAnnouncement(e('paused', 'budget_run'))).toBe('Run status: Paused: run budget.');
    expect(statusAnnouncement(e('completed'))).toBe('Run status: Completed.');
    expect(statusAnnouncement(e('running'))).toBeNull();
    expect(statusAnnouncement(e('cancelling'))).toBeNull();
  });
});
