import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `workflows.list`. */
export function useWorkflows() {
  return useQuery({ queryKey: qk.workflows(), queryFn: () => call('relay/v1/workflows.list', {}) });
}

/** `workflows.get` for a validated version or the draft. Disabled until both are known. */
export function useWorkflow(workflowId: string | undefined, version: number | 'draft' | null | undefined) {
  return useQuery({
    queryKey: qk.workflow(workflowId ?? '', version ?? 'draft'),
    queryFn: () => call('relay/v1/workflows.get', { workflowId: workflowId ?? '', version: version ?? 'draft' }),
    enabled: workflowId !== undefined && workflowId !== '' && version !== null && version !== undefined,
  });
}
