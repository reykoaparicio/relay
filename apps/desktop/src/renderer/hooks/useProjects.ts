import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `projects.list` (non-archived projects, for the project switcher). */
export function useProjects() {
  return useQuery({ queryKey: qk.projects(), queryFn: () => call('relay/v1/projects.list', {}) });
}
