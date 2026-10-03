import { useQuery } from '@tanstack/react-query';
import { PAGE_LIMITS } from '@relay/contracts';
import type { RunEvent, RunStatus } from '@relay/contracts';
import { call } from '../api/client';
import { qk } from '../api/keys';
import { statusChangedAtOf } from '../features/run-inspector/inspector-model';

/** Pages to read at most (500 events each) before giving up on finding the status change. */
const MAX_PAGES = 20;

/**
 * When a run last changed to `status` (its last `run.status_changed` event to it), for views that do not stream the
 * run's events (Overview, the shell). `enabled`: the run is in that status now. `undefined` while loading or disabled;
 * null when the events do not show it.
 */
export function useStatusChangedAt(runId: string | undefined, status: RunStatus, enabled: boolean): number | null | undefined {
  const on = runId !== undefined && runId !== '' && enabled;
  const q = useQuery({
    queryKey: [...qk.events(runId ?? ''), 'status-changed-at', status] as const,
    queryFn: async () => {
      const events: RunEvent[] = [];
      let afterSeq = 0;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const res = await call('relay/v1/runs.events', { runId: runId ?? '', afterSeq, limit: PAGE_LIMITS.eventsMaxLimit });
        events.push(...res.items);
        const last = res.items.at(-1);
        if (res.nextCursor === null || last === undefined) break;
        afterSeq = last.seq;
      }
      return statusChangedAtOf(events, status);
    },
    enabled: on,
  });
  return on ? (q.isError ? null : q.data) : undefined;
}
