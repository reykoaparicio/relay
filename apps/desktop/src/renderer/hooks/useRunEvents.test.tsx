import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { errors, runEventSchema } from '@relay/contracts';
import type { RunEvent } from '@relay/contracts';
import type * as ui from '../components/ui';
import { createTestQueryClient } from '../components/ui/test-utils';
import { installBridge } from '../api/bridge';
import { createFakeBridge } from '../api/fake-bridge';
import type { FakeBridge } from '../api/fake-bridge';
import { MAX_STORED_EVENTS, statusAnnouncement, useRunEvents } from './useRunEvents';
import type { RunEventsTimers } from './useRunEvents';

type UiModule = typeof ui;
const announceSpy = vi.hoisted(() => vi.fn());
vi.mock('../components/ui', async (importOriginal) => ({
  ...(await importOriginal<UiModule>()),
  useLiveRegion: () => ({ announce: announceSpy }),
}));

beforeEach(() => {
  announceSpy.mockReset();
});

interface SetupOptions {
  readonly timers?: RunEventsTimers;
  /** Runs before the hook mounts (e.g. inject a failure or hold the initial load). */
  readonly prepare?: (bridge: FakeBridge, runId: string) => void;
}

function setup(opts: SetupOptions = {}) {
  const announce = announceSpy;
  const bridge = createFakeBridge('active-run');
  installBridge(bridge);
  const run = bridge.world.runs[0];
  if (run === undefined) throw new Error('scenario has no run');
  opts.prepare?.(bridge, run.id);
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { readonly children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useRunEvents(run.id, opts.timers === undefined ? {} : { timers: opts.timers }), { wrapper });
  return { bridge, run, hook, announce, queryClient };
}

/** Manually driven timers: nothing fires until `runAll()` (tests control retries and the debounce). */
function manualTimers() {
  let nextId = 0;
  const queue = new Map<number, { readonly fn: () => void; readonly ms: number }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      nextId += 1;
      queue.set(nextId, { fn, ms });
      return nextId;
    },
    clearTimeout: (handle: unknown) => {
      queue.delete(handle as number);
    },
    delays: () => [...queue.values()].map((t) => t.ms),
    runAll: () => {
      const due = [...queue.entries()];
      queue.clear();
      for (const [, t] of due) t.fn();
    },
  };
}

/** Seq of the last stored (history) event of the run. */
function storedLast(bridge: FakeBridge, runId: string): number {
  return bridge.world.events.get(runId)?.at(-1)?.seq ?? 0;
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
    // Stream progress is kept per attempt in `progress`, not in the event list (B8).
    expect(hook.result.current.events.map((e) => e.seq)).toEqual(stored.filter((e) => e.type !== 'attempt.stream_progress').map((e) => e.seq));
    expect(hook.result.current.lastSeq).toBe(stored.at(-1)?.seq);
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

  it('B1: a failed initial load stays loaded:false, retries with backoff, and never announces history', async () => {
    const timers = manualTimers();
    const { bridge, run, hook, announce } = setup({
      timers,
      prepare: (b, runId) => {
        // History contains an announced transition that must never be read out.
        store(b, event(b, runId, storedLast(b, runId) + 1, 'run.status_changed', { from: 'running', to: 'paused', pauseReason: 'user' }));
        b.failNext('relay/v1/runs.events', errors.runnerUnavailable());
      },
    });
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.events')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(timers.delays().length).toBeGreaterThan(0);
    });
    expect(hook.result.current.loaded).toBe(false);
    expect(timers.delays()[0]).toBeGreaterThan(0); // backoff, not a hot loop

    // A push with a gap arrives while the load is failing: it must not trigger a "live" replay of history.
    const history = storedLast(bridge, run.id);
    const pushed = event(bridge, run.id, history + 1, 'ledger.settled', { stepKey: 'review' });
    store(bridge, pushed);
    act(() => {
      bridge.emit({ type: 'run.event', event: pushed });
    });
    expect(hook.result.current.loaded).toBe(false);

    act(() => {
      timers.runAll();
    });
    await waitFor(() => {
      expect(hook.result.current.loaded).toBe(true);
    });
    expect(hook.result.current.lastSeq).toBe(history + 1);
    expect(announce).not.toHaveBeenCalled();
  });

  it('B1: history behind a gap in the initial snapshot is still not announced once the gap closes', async () => {
    const timers = manualTimers();
    let hole = 0;
    const { bridge, run, hook, announce } = setup({
      timers,
      prepare: (b, runId) => {
        hole = storedLast(b, runId) + 1;
        // The snapshot returns seq hole+1 but not `hole` yet (the store lagged).
        store(b, event(b, runId, hole + 1, 'run.status_changed', { from: 'running', to: 'completed', pauseReason: null }));
      },
    });
    await waitFor(() => {
      expect(hook.result.current.loaded).toBe(true);
    });
    expect(hook.result.current.lastSeq).toBe(hole - 1);
    const events = bridge.world.events.get(run.id) ?? [];
    const late = event(bridge, run.id, hole, 'ledger.settled', { stepKey: 'review' });
    bridge.world.events.set(run.id, [...events.slice(0, -1), late, ...events.slice(-1)]);
    act(() => {
      timers.runAll();
    });
    await waitFor(() => {
      expect(hook.result.current.lastSeq).toBe(hole + 1);
    });
    expect(announce).not.toHaveBeenCalled();
  });

  it('B2: a gap that stays open after a backfill is re-backfilled (with backoff) without another push', async () => {
    const timers = manualTimers();
    const { bridge, run, hook } = setup({ timers });
    await waitFor(() => {
      expect(hook.result.current.loaded).toBe(true);
    });
    const last = hook.result.current.lastSeq;
    // last+2 is pushed, but last+1 is not in the store yet (the backfill cannot close the gap).
    const later = event(bridge, run.id, last + 2, 'attempt.settled', { stepKey: 'review' });
    const callsBefore = bridge.callsTo('relay/v1/runs.events').length;
    act(() => {
      bridge.emit({ type: 'run.event', event: later });
    });
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.events').length).toBe(callsBefore + 1);
    });
    await waitFor(() => {
      expect(timers.delays().length).toBeGreaterThan(0);
    });
    expect(hook.result.current.lastSeq).toBe(last);

    store(bridge, event(bridge, run.id, last + 1, 'attempt.created', { stepKey: 'review' }));
    store(bridge, later);
    act(() => {
      timers.runAll();
    });
    await waitFor(() => {
      expect(hook.result.current.lastSeq).toBe(last + 2);
    });
  });

  it('B2: a failed gap backfill retries with bounded backoff', async () => {
    const timers = manualTimers();
    const { bridge, run, hook } = setup({ timers });
    await waitFor(() => {
      expect(hook.result.current.loaded).toBe(true);
    });
    const last = hook.result.current.lastSeq;
    const missed = event(bridge, run.id, last + 1, 'attempt.created', { stepKey: 'review' });
    const later = event(bridge, run.id, last + 2, 'attempt.settled', { stepKey: 'review' });
    store(bridge, missed);
    store(bridge, later);
    bridge.failNext('relay/v1/runs.events', errors.runnerUnavailable());
    act(() => {
      bridge.emit({ type: 'run.event', event: later });
    });
    await waitFor(() => {
      expect(timers.delays().length).toBeGreaterThan(0);
    });
    const delay = timers.delays()[0] ?? 0;
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(10_000);
    expect(hook.result.current.lastSeq).toBe(last);
    act(() => {
      timers.runAll();
    });
    await waitFor(() => {
      expect(hook.result.current.lastSeq).toBe(last + 2);
    });
  });

  it('B3: an event pushed during the initial load is live (announced and invalidating)', async () => {
    const timers = manualTimers();
    let release: () => void = () => undefined;
    const { bridge, run, hook, announce, queryClient } = setup({
      timers,
      prepare: (b) => {
        release = b.hold('relay/v1/runs.events');
      },
    });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/runs.events')).toHaveLength(1);
    });
    const next = event(bridge, run.id, storedLast(bridge, run.id) + 1, 'run.status_changed', {
      from: 'running',
      to: 'awaiting_approval',
      pauseReason: null,
    });
    store(bridge, next);
    act(() => {
      bridge.emit({ type: 'run.event', event: next });
    });
    expect(hook.result.current.loaded).toBe(false);
    release();
    await waitFor(() => {
      expect(hook.result.current.loaded).toBe(true);
    });
    expect(hook.result.current.lastSeq).toBe(next.seq);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Run status: Awaiting your approval.');
    act(() => {
      timers.runAll();
    });
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toContainEqual(['run', run.id]);
  });

  it('B8: keeps only the newest events, never stream progress, and the latest progress per attempt', async () => {
    const timers = manualTimers();
    const { bridge, run, hook } = setup({ timers });
    await waitFor(() => {
      expect(hook.result.current.loaded).toBe(true);
    });
    const start = hook.result.current.lastSeq;
    const total = MAX_STORED_EVENTS + 602; // a multiple of 3
    act(() => {
      for (let i = 1; i <= total; i++) {
        const type = i % 3 === 0 ? 'attempt.stream_progress' : 'ledger.settled';
        const payload = i % 3 === 0 ? { stepKey: 'review', attemptId: `att_${String(i % 2)}`, outputTokensSoFar: i } : { stepKey: 'review' };
        bridge.emit({ type: 'run.event', event: event(bridge, run.id, start + i, type, payload) });
      }
    });
    const state = hook.result.current;
    expect(state.lastSeq).toBe(start + total);
    expect(state.events.length).toBe(MAX_STORED_EVENTS);
    expect(state.events.some((e) => e.type === 'attempt.stream_progress')).toBe(false);
    expect(state.events.at(-1)?.seq).toBe(start + total - 1); // the last one is progress
    expect(state.droppedCount).toBeGreaterThan(0);
    expect([...state.progress.keys()].filter((k) => k.startsWith('att_')).sort()).toEqual(['att_0', 'att_1']);
    expect(state.progress.get('att_0')?.payload['outputTokensSoFar']).toBe(total);
    expect(state.progress.get('att_1')?.payload['outputTokensSoFar']).toBe(total - 3);
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
