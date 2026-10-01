// Global push handler (10 J2): keeps cached queries in step with main/runner push events.
//   run.status        → updates cached run summaries/details in place, then (debounced) refreshes that project's run
//                       lists and stats; the run detail is marked stale but never refetched from here
//   memory.changed    → invalidates that project's memory lists and its records
//   providers.changed → invalidates providers
//   runner.state      → reported to the shell banner
import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import { assertNever } from '@relay/contracts';
import type { OutputOf, PushEvent, RunnerState } from '@relay/contracts';
import type { RelayBridge } from '../api/bridge';
import { qk } from '../api/keys';

type RunsPage = OutputOf<'relay/v1/runs.list'>;
type RunDetail = OutputOf<'relay/v1/runs.get'>;
type RunStatusPush = Extract<PushEvent, { type: 'run.status' }>;

/** Trailing debounce of list/stat refreshes: a burst of status pushes refetches each list once (10 J2). */
export const PUSH_INVALIDATE_DEBOUNCE_MS = 250;

function isRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null;
}

/** A single `runs.list` page (the nav badge count). */
function isRunsPage(data: unknown): data is RunsPage {
  return isRecord(data) && Array.isArray(data['items']);
}

/** An infinite `runs.list` cache (`useRuns`). */
function isInfiniteRuns(data: unknown): data is InfiniteData<RunsPage> {
  return isRecord(data) && Array.isArray(data['pages']) && data['pages'].every(isRunsPage);
}

function patchPage(p: RunsPage, e: RunStatusPush): RunsPage {
  if (!p.items.some((r) => r.id === e.runId && (r.status !== e.status || r.pauseReason !== e.pauseReason))) return p;
  return { ...p, items: p.items.map((r) => (r.id === e.runId ? { ...r, status: e.status, pauseReason: e.pauseReason } : r)) };
}

/** Patches a cached run list: infinite (`useRuns`) or single page (nav badge count). */
function patchRunsCache(data: unknown, e: RunStatusPush): unknown {
  if (isInfiniteRuns(data)) {
    const pages = data.pages.map((p) => patchPage(p, e));
    return pages.every((p, i) => p === data.pages[i]) ? data : { ...data, pages };
  }
  if (isRunsPage(data)) return patchPage(data, e);
  return data;
}

function listsRun(data: unknown, runId: string): boolean {
  if (isInfiniteRuns(data)) return data.pages.some((p) => p.items.some((r) => r.id === runId));
  return isRunsPage(data) && data.items.some((r) => r.id === runId);
}

/**
 * The project of a run, from the cache only (the push carries no project id): the cached run detail, else the
 * `['runs', projectId, …]` list that contains it. Undefined when nothing cached knows the run.
 */
function cachedProjectOf(queryClient: QueryClient, runId: string): string | undefined {
  const detail = queryClient.getQueryData<RunDetail>(qk.run(runId));
  if (detail !== undefined) return detail.projectId;
  for (const [key, data] of queryClient.getQueriesData({ queryKey: ['runs'] })) {
    const projectId = key[1];
    if (typeof projectId === 'string' && listsRun(data, runId)) return projectId;
  }
  return undefined;
}

/** Collects query-key prefixes and invalidates them once, `delayMs` after the last request (trailing debounce). */
function createDebouncedInvalidator(queryClient: QueryClient, delayMs: number) {
  const keys = new Map<string, QueryKey>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const due = [...keys.values()];
    keys.clear();
    for (const queryKey of due) void queryClient.invalidateQueries({ queryKey });
  };
  return {
    add(queryKey: QueryKey) {
      // Stale at once (a page mounted meanwhile refetches instead of showing pre-push data); the refetch of the
      // queries on screen waits for the burst to end.
      void queryClient.invalidateQueries({ queryKey, refetchType: 'none' });
      keys.set(JSON.stringify(queryKey), queryKey);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      keys.clear();
    },
  };
}

type Invalidator = ReturnType<typeof createDebouncedInvalidator>;

function applyRunStatus(queryClient: QueryClient, e: RunStatusPush, later: Invalidator): void {
  queryClient.setQueriesData({ queryKey: ['runs'] }, (data: unknown) => patchRunsCache(data, e));
  queryClient.setQueryData<RunDetail>(qk.run(e.runId), (run) =>
    run === undefined ? run : { ...run, status: e.status, pauseReason: e.pauseReason },
  );
  // The detail is patched for what the push carries; its other fields (steps, pendingApproval, availableActions) are
  // only marked stale, never refetched here: an open inspector refreshes through useRunEvents, and a later visit
  // refetches on mount instead of showing the pre-push detail.
  void queryClient.invalidateQueries({ queryKey: qk.run(e.runId), exact: true, refetchType: 'none' });
  // Status filters and project stats (active run, counts) depend on the status: refresh them in the background,
  // only for the run's project when the cache knows it.
  const projectId = cachedProjectOf(queryClient, e.runId);
  if (projectId === undefined) {
    later.add(['runs']);
    later.add(['project']);
    return;
  }
  later.add(['runs', projectId]);
  later.add(qk.project(projectId));
}

/** The project a cached memory record belongs to (`memory.get` data), if it is loaded. */
function recordProjectOf(data: unknown): string | undefined {
  return isRecord(data) && typeof data['projectId'] === 'string' ? data['projectId'] : undefined;
}

/** A project's memory lists and records (PERF-05: other projects' cached records are left alone). */
function invalidateMemory(queryClient: QueryClient, projectId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['memory', projectId] });
  void queryClient.invalidateQueries({
    queryKey: ['memory-record'],
    // A record without data yet (loading, or failed) is refetched too: its project is unknown.
    predicate: (q) => {
      const owner = recordProjectOf(q.state.data);
      return owner === undefined || owner === projectId;
    },
  });
  void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
}

/** Applies one push event to the query cache. */
function applyPushEvent(queryClient: QueryClient, e: PushEvent, onRunnerState: (s: RunnerState) => void, later: Invalidator): void {
  switch (e.type) {
    case 'run.status':
      applyRunStatus(queryClient, e, later);
      return;
    case 'memory.changed':
      invalidateMemory(queryClient, e.projectId);
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
    default:
      assertNever(e);
  }
}

/** Subscribes the query cache to push events. Returns the unsubscribe function (it also drops pending refreshes). */
export function startPushSync(
  bridge: RelayBridge,
  queryClient: QueryClient,
  onRunnerState: (s: RunnerState) => void,
): () => void {
  const later = createDebouncedInvalidator(queryClient, PUSH_INVALIDATE_DEBOUNCE_MS);
  const unsubscribe = bridge.subscribe((e) => {
    applyPushEvent(queryClient, e, onRunnerState, later);
  });
  return () => {
    unsubscribe();
    later.cancel();
  };
}
