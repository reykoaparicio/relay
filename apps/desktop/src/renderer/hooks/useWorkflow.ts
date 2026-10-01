import { useQueries, useQuery } from '@tanstack/react-query';
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

/** A workflow version (draft or validated) whose steps name a profile. */
export interface ProfileUse {
  readonly workflowId: string;
  readonly name: string;
  readonly version: number | 'draft';
}

/**
 * Workflows whose draft or latest validated version names the profile `profileName` (case-insensitive, like the
 * engine's `profile_in_use` check), from `workflows.list` + `workflows.get`. A pre-warning only: the engine decides.
 * `null` while loading or when `profileName` is null (disabled).
 */
export function useProfileUsage(profileName: string | null): readonly ProfileUse[] | null {
  const workflows = useWorkflows();
  const versions = (workflows.data ?? []).flatMap((w) => [
    ...(w.draftVersion === null ? [] : [{ w, version: 'draft' as const }]),
    ...(w.latestValidatedVersion === null ? [] : [{ w, version: w.latestValidatedVersion }]),
  ]);
  const enabled = profileName !== null;
  const results = useQueries({
    queries: versions.map(({ w, version }) => ({
      queryKey: qk.workflow(w.id, version),
      queryFn: () => call('relay/v1/workflows.get', { workflowId: w.id, version }),
      enabled,
    })),
  });
  if (!enabled || workflows.data === undefined || results.some((r) => r.data === undefined)) return null;
  const lower = profileName.toLowerCase();
  return versions.flatMap(({ w, version }, i) =>
    results[i]?.data?.spec.steps.some((s) => s.kind === 'model' && s.profile.toLowerCase() === lower) === true
      ? [{ workflowId: w.id, name: w.name, version }]
      : [],
  );
}
