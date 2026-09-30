import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import { qk } from '../api/keys';

/**
 * `artifacts.get` for one artifact (step outputs, the run report, redacted raw responses). Artifacts are immutable,
 * so the result never goes stale. Disabled without an id or while `enabled` is false (e.g. a collapsed viewer).
 */
export function useArtifact(artifactId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.artifact(artifactId ?? ''),
    queryFn: () => call('relay/v1/artifacts.get', { artifactId: artifactId ?? '' }),
    enabled: enabled && artifactId !== undefined && artifactId !== null && artifactId !== '',
    staleTime: Number.POSITIVE_INFINITY,
  });
}
