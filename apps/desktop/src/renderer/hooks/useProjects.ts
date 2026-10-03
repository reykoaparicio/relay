import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** `projects.list` (non-archived projects, for the project switcher). */
export function useProjects() {
  return useQuery({ queryKey: qk.projects(), queryFn: () => call('relay/v1/projects.list', {}) });
}

/** `projects.list({ includeArchived: true })` → the archived projects only (Settings → Projects "Archived"). */
export function useArchivedProjects() {
  return useQuery({
    queryKey: [...qk.projects(), 'archived'] as const,
    queryFn: () => call('relay/v1/projects.list', { includeArchived: true }),
    select: (list) => list.filter((p) => p.archivedAt !== null),
  });
}
