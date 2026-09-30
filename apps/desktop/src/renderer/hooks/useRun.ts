import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `runs.get` (run inspector projection with `availableActions`). */
export function useRun(runId: string | undefined) {
  return useQuery({
    queryKey: qk.run(runId ?? ''),
    queryFn: () => call('relay/v1/runs.get', { runId: runId ?? '' }),
    enabled: runId !== undefined && runId !== '',
  });
}
