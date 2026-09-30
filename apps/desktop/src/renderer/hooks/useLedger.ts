import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `ledger.runSummary` + `ledger.entries` for one run (the inspector's Ledger tab; run-scoped). */
export function useLedger(runId: string | undefined) {
  const enabled = runId !== undefined && runId !== '';
  const summary = useQuery({
    queryKey: [...qk.ledger(runId ?? ''), 'summary'] as const,
    queryFn: () => call('relay/v1/ledger.runSummary', { runId: runId ?? '' }),
    enabled,
  });
  const entries = useInfiniteQuery({
    queryKey: [...qk.ledger(runId ?? ''), 'entries'] as const,
    queryFn: ({ pageParam }) =>
      call('relay/v1/ledger.entries', { runId: runId ?? '', limit: 100, ...(pageParam === undefined ? {} : { cursor: pageParam }) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
  return { summary, entries };
}
