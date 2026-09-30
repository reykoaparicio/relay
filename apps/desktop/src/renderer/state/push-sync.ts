// Global push handler (10 J2): keeps cached queries in step with main/runner push events.
//   run.status        → updates cached run summaries/details in place, then refreshes list membership and stats
//   memory.changed    → invalidates that project's memory queries
//   providers.changed → invalidates providers
//   runner.state      → reported to the shell banner
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { OutputOf, PushEvent, RunnerState } from '@relay/contracts';
import type { RelayBridge } from '../api/bridge';
import { qk } from '../api/keys';

type RunsPage = OutputOf<'relay/v1/runs.list'>;
type RunDetail = OutputOf<'relay/v1/runs.get'>;
type RunStatusPush = Extract<PushEvent, { type: 'run.status' }>;

function patchPage(p: RunsPage, e: RunStatusPush): RunsPage {
  if (!p.items.some((r) => r.id === e.runId && (r.status !== e.status || r.pauseReason !== e.pauseReason))) return p;
  return { ...p, items: p.items.map((r) => (r.id === e.runId ? { ...r, status: e.status, pauseReason: e.pauseReason } : r)) };
}

/** Patches a cached run list: infinite (`useRuns`) or single page (nav badge count). */
function patchRunsCache(data: unknown, e: RunStatusPush): unknown {
  if (typeof data !== 'object' || data === null) return data;
  if ('pages' in data) {
    const inf = data as InfiniteData<RunsPage>;
    const pages = inf.pages.map((p) => patchPage(p, e));
    return pages.every((p, i) => p === inf.pages[i]) ? data : { ...inf, pages };
  }
  if ('items' in data) return patchPage(data as RunsPage, e);
  return data;
}

/** Applies one push event to the query cache. Exported for tests. */
export function applyPushEvent(queryClient: QueryClient, e: PushEvent, onRunnerState: (s: RunnerState) => void): void {
  switch (e.type) {
    case 'run.status': {
      queryClient.setQueriesData({ queryKey: ['runs'] }, (data: unknown) => patchRunsCache(data, e));
      queryClient.setQueryData<RunDetail>(qk.run(e.runId), (run) =>
        run === undefined ? run : { ...run, status: e.status, pauseReason: e.pauseReason },
      );
      // Status filters and project stats (active run, counts) depend on the status: refresh them in the background.
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: qk.run(e.runId) });
      return;
    }
    case 'memory.changed':
      void queryClient.invalidateQueries({ queryKey: ['memory', e.projectId] });
      void queryClient.invalidateQueries({ queryKey: ['memory-record'] });
      void queryClient.invalidateQueries({ queryKey: qk.project(e.projectId) });
      return;
    case 'providers.changed':
      void queryClient.invalidateQueries({ queryKey: qk.providers() });
      return;
    case 'runner.state':
      onRunnerState(e.state);
      if (e.state === 'ready') void queryClient.invalidateQueries();
      return;
    case 'run.event':
      // Consumed by useRunEvents (gapless per-run stream); nothing global to do.
      return;
  }
}

/** Subscribes the query cache to push events. Returns the unsubscribe function. */
export function startPushSync(
  bridge: RelayBridge,
  queryClient: QueryClient,
  onRunnerState: (s: RunnerState) => void,
): () => void {
  return bridge.subscribe((e) => {
    applyPushEvent(queryClient, e, onRunnerState);
  });
}
