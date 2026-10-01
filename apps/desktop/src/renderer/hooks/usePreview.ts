import { useQuery } from '@tanstack/react-query';
import type { InputOf } from '@relay/contracts';
import { call } from '../api/client';
import { qk } from '../api/keys';

/** What to preview: a fresh directory selection (onboarding) or an existing project (new run, sample). */
export type PreviewTarget = { readonly selectionId: string } | { readonly projectId: string };

type PreviewInput = InputOf<'relay/v1/projects.previewFiles'>;

function previewInput(target: PreviewTarget, extraExclusions: readonly string[]): PreviewInput {
  const extra = extraExclusions.length === 0 ? {} : { extraExclusions: [...extraExclusions] };
  return 'selectionId' in target ? { selectionId: target.selectionId, ...extra } : { projectId: target.projectId, ...extra };
}

/** `projects.previewFiles` (included files, excluded ones with reasons, totals vs caps). Disabled without a target. */
export function usePreview(target: PreviewTarget | null, extraExclusions: readonly string[] = []) {
  const id = target === null ? '' : 'selectionId' in target ? target.selectionId : target.projectId;
  return useQuery({
    queryKey: qk.preview(id, extraExclusions.join('\n')),
    queryFn: () => call('relay/v1/projects.previewFiles', previewInput(target ?? { projectId: id }, extraExclusions)),
    enabled: id !== '',
  });
}
