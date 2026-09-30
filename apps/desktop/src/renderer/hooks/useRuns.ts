import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { RunStatus } from '@relay/contracts';
import { call } from '../api/client';
import { qk, RUNS_PAGE_SIZE } from '../api/keys';

export interface UseRunsOptions {
  /** Status filter; `undefined` = all statuses. */
  readonly status?: readonly RunStatus[];
  /** Stable name of the filter for the query key (e.g. 'attention'); defaults to the joined statuses. */
  readonly filterKey?: string;
  readonly limit?: number;
}

/** `runs.list` as an infinite query over `nextCursor` (newest first). */
export function useRuns(projectId: string | undefined, options: UseRunsOptions = {}) {
  const limit = options.limit ?? RUNS_PAGE_SIZE;
  const status = options.status;
  const filterKey = options.filterKey ?? (status === undefined ? 'all' : [...status].sort().join(','));
  return useInfiniteQuery({
    queryKey: qk.runs(projectId ?? '', filterKey, limit),
    queryFn: ({ pageParam }) =>
      call('relay/v1/runs.list', {
        projectId: projectId ?? '',
        limit,
        ...(status === undefined ? {} : { status: [...status] }),
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: projectId !== undefined && projectId !== '',
  });
}

/** Largest `runs.list` page (contracts PAGE_LIMITS.maxLimit): counts above it are shown as "100+". */
export const RUNS_MAX_PAGE = 100;

/**
 * The first page of runs with the given statuses (newest first), as a plain query. Used for status-filtered counts
 * and "is there any" checks (`limit: 1`) so nothing is derived from an unrelated, truncated list.
 */
export function useRunsHead(projectId: string | undefined, status: readonly RunStatus[], limit: number, name: string) {
  return useQuery({
    queryKey: qk.runs(projectId ?? '', `head:${name}`, limit),
    queryFn: () => call('relay/v1/runs.list', { projectId: projectId ?? '', status: [...status], limit }),
    enabled: projectId !== undefined && projectId !== '',
  });
}
