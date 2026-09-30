import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `runs.getStep` (output, manifest, attempts, and events of one step row). */
export function useStep(runId: string | undefined, stepId: string | undefined) {
  return useQuery({
    queryKey: qk.step(runId ?? '', stepId ?? ''),
    queryFn: () => call('relay/v1/runs.getStep', { runId: runId ?? '', stepId: stepId ?? '' }),
    enabled: runId !== undefined && runId !== '' && stepId !== undefined && stepId !== '',
  });
}
