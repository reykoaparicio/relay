import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `ledger.projectSummary` for the current month ("tracked by Relay", §9.1). */
export function useProjectCost(projectId: string | undefined) {
  return useQuery({
    queryKey: qk.projectCost(projectId ?? ''),
    queryFn: () => call('relay/v1/ledger.projectSummary', { projectId: projectId ?? '' }),
    enabled: projectId !== undefined && projectId !== '',
  });
}
