import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { pauseReasonSchema, runStatusSchema } from '@relay/contracts';
import type { RunEvent, RunEventType, RunStatus } from '@relay/contracts';
import { useLiveRegion } from '../components/ui';
import { statusPresentation } from '../lib/format';
import { getBridge } from '../api/bridge';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** §5.7: announce completion, pauses, and approval requests only; never tokens or progress. */
export const ANNOUNCED_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'awaiting_approval',
  'paused',
  'completed',
  'incomplete',
  'failed',
  'interrupted',
]);

/** Event types that change `runs.get` / ledger data. Stream progress only updates the live token count. */
const NON_INVALIDATING: ReadonlySet<RunEventType> = new Set<RunEventType>(['attempt.stream_progress']);

/** Invalidation debounce (10 J2). */
export const RUN_INVALIDATE_DEBOUNCE_MS = 250;

export interface RunEventsState {
  /** Gapless, seq-ordered events (seq 1…lastSeq). */
  readonly events: readonly RunEvent[];
  readonly lastSeq: number;
  /** The initial `afterSeq: 0` load finished. */
  readonly loaded: boolean;
}

/** Visible sentence for a status change, or null when the change is not announced. */
export function statusAnnouncement(event: RunEvent): string | null {
  if (event.type !== 'run.status_changed') return null;
  const to = runStatusSchema.safeParse(event.payload['to'] ?? event.payload['status']);
  if (!to.success || !ANNOUNCED_RUN_STATUSES.has(to.data)) return null;
  const reason = pauseReasonSchema.safeParse(event.payload['pauseReason']);
  return `Run status: ${statusPresentation('run', to.data, reason.success ? reason.data : null).label}.`;
}

/**
 * Gapless run event stream (02 §B5, 10 J2):
 * 1. subscribes to push, then loads `runs.events({ afterSeq: 0 })` (pushes that arrive meanwhile are buffered);
 * 2. applies `seq === last + 1` in order, ignores duplicates (`seq <= last`), and backfills on a gap;
 * 3. invalidates `run` / `ledger` / `step` queries, debounced 250 ms, for live (post-load) events;
 * 4. announces only `run.status_changed` to awaiting_approval, paused, completed, incomplete, failed, interrupted.
 */
export function useRunEvents(runId: string | undefined): RunEventsState {
  const queryClient = useQueryClient();
  const { announce } = useLiveRegion();
  const [state, setState] = useState<RunEventsState & { readonly runId: string | undefined }>({
    runId: undefined,
    events: [],
    lastSeq: 0,
    loaded: false,
  });

  useEffect(() => {
    if (runId === undefined || runId === '') return undefined;
    let cancelled = false;
    let last = 0;
    let live = false;
    let syncing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const applied: RunEvent[] = [];
    const pending = new Map<number, RunEvent>();

    const scheduleInvalidate = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void queryClient.invalidateQueries({ queryKey: qk.run(runId) });
        void queryClient.invalidateQueries({ queryKey: qk.ledger(runId) });
        void queryClient.invalidateQueries({ queryKey: ['step', runId] });
      }, RUN_INVALIDATE_DEBOUNCE_MS);
    };

    const react = (e: RunEvent) => {
      if (!live) return; // history is not news
      const message = statusAnnouncement(e);
      if (message !== null) announce(message);
      if (!NON_INVALIDATING.has(e.type)) scheduleInvalidate();
    };

    const drain = () => {
      let changed = false;
      for (let next = pending.get(last + 1); next !== undefined; next = pending.get(last + 1)) {
        pending.delete(next.seq);
        last = next.seq;
        applied.push(next);
        react(next);
        changed = true;
      }
      for (const seq of pending.keys()) if (seq <= last) pending.delete(seq);
      if (changed && !cancelled) setState({ runId, events: [...applied], lastSeq: last, loaded: live });
    };

    const accept = (e: RunEvent) => {
      if (e.seq <= last || pending.has(e.seq)) return; // duplicate
      pending.set(e.seq, e);
      drain();
      if (pending.size > 0 && !syncing) void backfill();
    };

    async function backfill(): Promise<void> {
      syncing = true;
      try {
        for (;;) {
          const page = await call('relay/v1/runs.events', { runId: runId ?? '', afterSeq: last });
          if (cancelled) return;
          for (const e of page.items) if (e.seq > last && !pending.has(e.seq)) pending.set(e.seq, e);
          drain();
          if (page.nextCursor === null || page.items.length === 0) break;
        }
      } catch {
        // Keep the buffered pushes; the next push re-triggers a backfill.
      } finally {
        syncing = false;
      }
      if (cancelled) return;
      if (!live) {
        live = true;
        setState({ runId, events: [...applied], lastSeq: last, loaded: true });
      }
    }

    const unsubscribe = getBridge().subscribe((pe) => {
      if (pe.type === 'run.event' && pe.event.runId === runId) accept(pe.event);
    });
    void backfill();
    return () => {
      cancelled = true;
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [runId, queryClient, announce]);

  // State from a previous run id is never shown for the current one.
  return state.runId === runId ? state : EMPTY;
}

const EMPTY: RunEventsState = { events: [], lastSeq: 0, loaded: false };
