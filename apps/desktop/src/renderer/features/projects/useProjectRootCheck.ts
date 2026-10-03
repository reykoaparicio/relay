import { useQuery } from '@tanstack/react-query';
import { call } from '../../api/client';
import { isProjectRootMissing } from '../../api/errors';
import { qk } from '../../api/keys';

/** A folder check is cheap but not free (a file scan): reuse a recent preview for a minute. */
const ROOT_CHECK_STALE_MS = 60_000;

/**
 * E2 #7: whether the project's folder is gone. Reads the project's file preview (the same query New run uses, so it
 * doubles as a prefetch); PROJECT_ROOT_MISSING means the folder was moved, renamed, or deleted.
 */
export function useProjectRootMissing(projectId: string | undefined): boolean {
  const preview = useQuery({
    queryKey: qk.preview(projectId ?? '', ''),
    queryFn: () => call('relay/v1/projects.previewFiles', { projectId: projectId ?? '' }),
    enabled: projectId !== undefined && projectId !== '',
    staleTime: ROOT_CHECK_STALE_MS,
  });
  return isProjectRootMissing(preview.error);
}
