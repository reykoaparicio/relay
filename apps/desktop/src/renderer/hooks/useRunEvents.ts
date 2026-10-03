import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { pauseReasonSchema, runStatusSchema } from '@relay/contracts';
import type { RunEvent, RunEventType, RunStatus } from '@relay/contracts';
import { useLiveRegion } from '../components/ui';
import { statusPresentation } from '../lib/format';
import { getBridge } from '../api/bridge';
import { call } from '../api/client';
import { qk } from '../api/keys';

/**
 * §5.7: announce completion (every terminal status, `cancelled` included: a stop the user asked for ends the run
 * later, once the in-flight request finishes), pauses, and approval requests only; never tokens or progress.
 */
const ANNOUNCED_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'awaiting_approval',
  'paused',
  'completed',
  'incomplete',
  'cancelled',
  'failed',
  'interrupted',
]);

/** Event types that change `runs.get` / ledger data. Stream progress only updates the live token count. */
const NON_INVALIDATING: ReadonlySet<RunEventType> = new Set<RunEventType>(['attempt.stream_progress']);

/**
 * Event types that move money: they also refresh the project's month cost ("Usage tracked by Relay"). A settle is
 * reported as `attempt.settled` (the engine emits no `ledger.settled`); an unknown outcome moves the reservation to
 * unknown liability.
 */
const LEDGER_EVENTS: ReadonlySet<RunEventType> = new Set<RunEventType>([
  'ledger.reserved',
  'attempt.settled',
  'attempt.unknown',
  'ledger.blocked',
  'ledger.overrun',
]);

/** Invalidation debounce (10 J2). */
const RUN_INVALIDATE_DEBOUNCE_MS = 250;

/** At most this many events are kept (the newest); older ones are counted in `droppedCount`. */
export const MAX_STORED_EVENTS = 1000;

/** Backfill retry delay: exponential from the base, capped (bounded backoff). */
const BACKFILL_RETRY_BASE_MS = 500;
const BACKFILL_RETRY_MAX_MS = 10_000;

/** Delay of the `attempt`-th consecutive retry (0-based). */
function backfillRetryDelay(attempt: number): number {
  return Math.min(BACKFILL_RETRY_MAX_MS, BACKFILL_RETRY_BASE_MS * 2 ** Math.min(attempt, 16));
}

/** Timer functions (injectable so tests control retries and the debounce without faking globals). */
export interface RunEventsTimers {
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const GLOBAL_TIMERS: RunEventsTimers = {
  // Resolved at call time so `vi.useFakeTimers()` applies.
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface UseRunEventsOptions {
  readonly timers?: RunEventsTimers;
}

/**
 * Latest `attempt.stream_progress` per attempt (keyed by `attemptId`, else `step:<stepKey>`), outside React state:
 * a progress push notifies only its subscribers (the streaming attempt card via `useStreamProgress`), never the page
 * that owns the stream (PERF-02).
 */
export interface StreamProgressStore {
  readonly runId: string;
  /** Immutable snapshot; a new map after every progress event. */
  readonly snapshot: () => ReadonlyMap<string, RunEvent>;
  readonly subscribe: (listener: () => void) => () => void;
}

interface WritableProgressStore extends StreamProgressStore {
  readonly set: (key: string, e: RunEvent) => void;
}

function createProgressStore(runId: string): WritableProgressStore {
  let map: ReadonlyMap<string, RunEvent> = new Map();
  const listeners = new Set<() => void>();
  return {
    runId,
    snapshot: () => map,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (key, e) => {
      const next = new Map(map);
      next.set(key, e);
      map = next;
      for (const l of listeners) l();
    },
  };
}

export interface RunEventsState {
  /**
   * Seq-ordered events, gapless from the first kept one to `lastSeq`: the newest {@link MAX_STORED_EVENTS},
   * never `attempt.stream_progress` (see `progress`).
   */
  readonly events: readonly RunEvent[];
  /**
   * Seq of the newest applied event as of the last published change. Progress-only pushes advance the stream
   * internally without publishing (no page re-render), so this can trail them until the next real event.
   */
  readonly lastSeq: number;
  /** The initial `afterSeq: 0` load succeeded. Stays false (and retries with backoff) while it fails. */
  readonly loaded: boolean;
  /** Stream progress of this run (stable per run id): read it with `useStreamProgress`. */
  readonly progress: StreamProgressStore;
  /** Older events not kept because of the {@link MAX_STORED_EVENTS} cap (0 when nothing was dropped). */
  readonly droppedCount: number;
}

/** Visible sentence for a status change, or null when the change is not announced. */
export function statusAnnouncement(event: RunEvent): string | null {
  if (event.type !== 'run.status_changed') return null;
  const to = runStatusSchema.safeParse(event.payload['to'] ?? event.payload['status']);
  if (!to.success || !ANNOUNCED_RUN_STATUSES.has(to.data)) return null;
  const reason = pauseReasonSchema.safeParse(event.payload['pauseReason']);
  return `Run status: ${statusPresentation('run', to.data, reason.success ? reason.data : null).label}.`;
}

function progressKey(e: RunEvent): string {
  const attemptId = e.payload['attemptId'];
  if (typeof attemptId === 'string') return attemptId;
  const stepKey = e.payload['stepKey'];
  return typeof stepKey === 'string' ? `step:${stepKey}` : 'run';
}

/** Published state: `buf` is an append-only backing array shared across publishes; `len` is its visible length. */
interface Published {
  readonly runId: string | undefined;
  readonly buf: readonly RunEvent[];
  readonly len: number;
  readonly lastSeq: number;
  readonly loaded: boolean;
  readonly droppedCount: number;
}

interface Pending {
  readonly event: RunEvent;
  /** Arrived via push (so it happened after we subscribed: live, even during the initial load). */
  pushed: boolean;
}

const INITIAL: Published = { runId: undefined, buf: [], len: 0, lastSeq: 0, loaded: false, droppedCount: 0 };

/**
 * Gapless run event stream (02 §B5, 10 J2):
 * 1. subscribes to push, then loads `runs.events({ afterSeq: 0 })` (pushes that arrive meanwhile are buffered). A failed
 *    initial load keeps `loaded: false` and retries with bounded backoff;
 * 2. applies `seq === last + 1` in order, ignores duplicates (`seq <= last`), and backfills on a gap. While a gap stays
 *    open after a backfill (or a backfill fails), it re-triggers with bounded backoff;
 * 3. an event is live when it arrived via push, or when its seq is above the initial snapshot's high-water mark.
 *    Only live events invalidate `run` / `ledger` / `step` queries (debounced 250 ms) and are announced;
 *    history from the initial snapshot never is;
 * 4. announces only `run.status_changed` to awaiting_approval, paused, completed, incomplete, cancelled, failed,
 *    interrupted;
 * 5. keeps the newest {@link MAX_STORED_EVENTS} events in an append-only buffer (no per-event array copies) and only the
 *    latest `attempt.stream_progress` per attempt, in a {@link StreamProgressStore}: a drain that applied only progress
 *    does not publish, so the page re-renders only for events that change what it shows.
 */
export function useRunEvents(runId: string | undefined, options: UseRunEventsOptions = {}): RunEventsState {
  const queryClient = useQueryClient();
  const { announce } = useLiveRegion();
  const timersRef = useRef<RunEventsTimers>(options.timers ?? GLOBAL_TIMERS);
  const [state, setState] = useState<Published>(INITIAL);
  const progressStore = useMemo(() => createProgressStore(runId ?? ''), [runId]);

  useEffect(() => {
    if (runId === undefined || runId === '') return undefined;
    const timers = timersRef.current;
    let cancelled = false;
    /** Read through a function: `cancelled` flips in the cleanup while a request is awaited. */
    const isCancelled = () => cancelled;
    let last = 0;
    /** True once the initial snapshot is loaded. */
    let snapshotDone = false;
    /** Highest seq the initial snapshot returned; later seqs are live. Infinity until the snapshot is loaded. */
    let snapshotHigh = Number.POSITIVE_INFINITY;
    let snapshotSeen = 0;
    let syncing = false;
    let failures = 0;
    let invalidateTimer: unknown;
    let ledgerMoved = false;
    let retryTimer: unknown;
    let buf: RunEvent[] = [];
    let dropped = 0;
    const pending = new Map<number, Pending>();

    const publish = () => {
      if (cancelled) return;
      setState({ runId, buf, len: buf.length, lastSeq: last, loaded: snapshotDone, droppedCount: dropped });
    };

    const scheduleInvalidate = (ledger: boolean) => {
      if (ledger) ledgerMoved = true;
      if (invalidateTimer !== undefined) timers.clearTimeout(invalidateTimer);
      invalidateTimer = timers.setTimeout(() => {
        invalidateTimer = undefined;
        void queryClient.invalidateQueries({ queryKey: qk.run(runId) });
        void queryClient.invalidateQueries({ queryKey: qk.ledger(runId) });
        void queryClient.invalidateQueries({ queryKey: ['step', runId] });
        if (ledgerMoved) {
          ledgerMoved = false;
          const projectId = queryClient.getQueryData<{ projectId?: string }>(qk.run(runId))?.projectId;
          void queryClient.invalidateQueries({ queryKey: projectId === undefined ? ['project-cost'] : qk.projectCost(projectId) });
        }
      }, RUN_INVALIDATE_DEBOUNCE_MS);
    };

    /** Stores `e`; false for stream progress (kept in the progress store, nothing to publish). */
    const store = (e: RunEvent): boolean => {
      if (e.type === 'attempt.stream_progress') {
        progressStore.set(progressKey(e), e);
        return false;
      }
      buf.push(e);
      if (buf.length > 2 * MAX_STORED_EVENTS) {
        // Amortised O(1): compact into a fresh array (published snapshots keep the old one intact).
        dropped += buf.length - MAX_STORED_EVENTS;
        buf = buf.slice(-MAX_STORED_EVENTS);
      }
      return true;
    };

    const react = (e: RunEvent) => {
      const message = statusAnnouncement(e);
      if (message !== null) announce(message);
      if (!NON_INVALIDATING.has(e.type)) scheduleInvalidate(LEDGER_EVENTS.has(e.type));
    };

    const drain = (): boolean => {
      let advanced = false;
      let stored = false;
      for (let next = pending.get(last + 1); next !== undefined; next = pending.get(last + 1)) {
        pending.delete(next.event.seq);
        last = next.event.seq;
        if (store(next.event)) stored = true;
        // History from the initial snapshot is not news; pushes and post-snapshot events are.
        if (next.pushed || next.event.seq > snapshotHigh) react(next.event);
        advanced = true;
      }
      for (const seq of pending.keys()) if (seq <= last) pending.delete(seq);
      // PERF-02: progress alone never re-renders the page; its subscribers were notified by the store.
      if (stored) publish();
      return advanced;
    };

    const gapOpen = () => !snapshotDone || pending.size > 0;

    const scheduleRetry = (immediate: boolean) => {
      if (cancelled || retryTimer !== undefined) return;
      const delay = immediate ? 0 : backfillRetryDelay(failures++);
      retryTimer = timers.setTimeout(() => {
        retryTimer = undefined;
        void backfill();
      }, delay);
    };

    const accept = (e: RunEvent, pushed: boolean) => {
      if (e.seq <= last) return; // duplicate
      const existing = pending.get(e.seq);
      if (existing !== undefined) {
        if (pushed) existing.pushed = true;
        return;
      }
      pending.set(e.seq, { event: e, pushed });
    };

    async function backfill(): Promise<void> {
      if (syncing || cancelled) return;
      syncing = true;
      let ok = true;
      let progressed = false;
      try {
        for (;;) {
          const before = last;
          const page = await call('relay/v1/runs.events', { runId: runId ?? '', afterSeq: last });
          if (isCancelled()) return;
          for (const e of page.items) {
            if (!snapshotDone) snapshotSeen = Math.max(snapshotSeen, e.seq);
            accept(e, false);
          }
          drain();
          if (last > before) progressed = true;
          // Stop at the end, or when a page did not advance (a true gap: retried below with backoff).
          if (page.nextCursor === null || page.items.length === 0 || last === before) break;
        }
        if (!snapshotDone) {
          snapshotDone = true;
          snapshotHigh = Math.max(last, snapshotSeen);
          publish();
        }
      } catch {
        ok = false;
      } finally {
        syncing = false;
      }
      if (isCancelled()) return;
      if (ok && !gapOpen()) {
        failures = 0;
        return;
      }
      // Failed, or the gap is still open (e.g. pushes arrived mid-request, or the store lagged): try again.
      if (ok && progressed) failures = 0;
      scheduleRetry(ok && progressed);
    }

    const unsubscribe = getBridge().subscribe((pe) => {
      if (pe.type !== 'run.event' || pe.event.runId !== runId) return;
      accept(pe.event, true);
      drain();
      // A gap starts a backfill now, unless one is running or a (backoff) retry is already scheduled.
      if (gapOpen() && !syncing && retryTimer === undefined) void backfill();
    });
    void backfill();
    return () => {
      cancelled = true;
      unsubscribe();
      if (invalidateTimer !== undefined) timers.clearTimeout(invalidateTimer);
      if (retryTimer !== undefined) timers.clearTimeout(retryTimer);
    };
  }, [runId, queryClient, announce, progressStore]);

  const current = state.runId === runId && runId !== undefined && runId !== '' ? state : INITIAL;
  const { buf, len } = current;
  // One bounded copy per render (never per event): the newest MAX_STORED_EVENTS of the append-only buffer.
  const events = useMemo(() => buf.slice(Math.max(0, len - MAX_STORED_EVENTS), len), [buf, len]);
  const droppedCount = current.droppedCount + Math.max(0, len - MAX_STORED_EVENTS);
  return { events, lastSeq: current.lastSeq, loaded: current.loaded, progress: progressStore, droppedCount };
}
