// Role → profile assignment shared by onboarding (profiles-and-allowance) and the new-run form (10 J6/J7).
import type { ProfileWithWarnings, Role, WorkflowSpec } from '@relay/contracts';

/** Role names as the mocks write them. Exhaustive over contracts ROLES. */
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  reviewer: 'Reviewer',
  planner: 'Planner',
  implementer: 'Implementer',
  verifier: 'Patch reviewer',
};

/** One model step of a workflow version with its default profile resolved from `profiles.list`. */
export interface ModelStepRow {
  readonly stepKey: string;
  readonly role: Role;
  /** The spec's profile name ("economy"). */
  readonly specProfile: string;
  /** Id of the profile the spec name resolves to (engine `findProfileByName`: exact, then case-insensitive). */
  readonly defaultProfileId: string | null;
  /** Step-level output allowance override, else the profile's. */
  readonly maxOutputTokens: number | undefined;
}

/** Resolves a spec profile name like the engine does (exact name, then case-insensitive). */
export function profileIdByName(profiles: readonly ProfileWithWarnings[], name: string): string | null {
  const exact = profiles.find((p) => p.profile.name === name);
  if (exact !== undefined) return exact.profile.id;
  const lower = name.toLowerCase();
  return profiles.find((p) => p.profile.name.toLowerCase() === lower)?.profile.id ?? null;
}

/** Model steps of a spec, in order. */
export function modelSteps(spec: WorkflowSpec, profiles: readonly ProfileWithWarnings[]): ModelStepRow[] {
  return spec.steps.flatMap((s) =>
    s.kind === 'model'
      ? [
          {
            stepKey: s.id,
            role: s.role,
            specProfile: s.profile,
            defaultProfileId: profileIdByName(profiles, s.profile),
            maxOutputTokens: s.maxOutputTokens,
          },
        ]
      : [],
  );
}

/**
 * `RunStartInput.profileOverrides`: only the steps whose selection differs from the default (10 J7). Undefined when
 * nothing changed, so the field is omitted from the request.
 */
export function profileOverridesFor(
  rows: readonly ModelStepRow[],
  selected: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const choice = selected[row.stepKey];
    if (choice !== undefined && choice !== row.defaultProfileId) out[row.stepKey] = choice;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
