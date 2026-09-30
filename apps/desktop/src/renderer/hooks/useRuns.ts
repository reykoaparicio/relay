import { useInfiniteQuery } from '@tanstack/react-query';
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
