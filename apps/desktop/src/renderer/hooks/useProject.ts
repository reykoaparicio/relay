import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `projects.get` (project + dashboard stats). Disabled without an id. */
export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: qk.project(projectId ?? ''),
    queryFn: () => call('relay/v1/projects.get', { projectId: projectId ?? '' }),
    enabled: projectId !== undefined && projectId !== '',
  });
}
