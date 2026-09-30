// 06 F14: the single profile validator (`checkProfile`) and `profiles.list` warnings (`profilesWithWarnings`).
import { err, errors, ok } from '@relay/contracts';
import type { CAPABILITY_WARNING_CODES, CapabilityWarning, CatalogModel, ModelCapabilities, ModelProfile, Result } from '@relay/contracts';
import type { ProfileRow, Repos } from '@relay/storage';

/** A capability warning code (02 `CAPABILITY_WARNING_CODES`). */
export type CapabilityWarningCode = (typeof CAPABILITY_WARNING_CODES)[number];

type CheckedProfile = Pick<ModelProfile, 'providerId' | 'modelId' | 'params'>;

const MESSAGES: Readonly<Record<CapabilityWarningCode, string>> = {
  model_unknown: 'This model is not in the price catalog, so its cost cannot be tracked.',
  effort_unsupported: 'This model does not support the selected effort level.',
  structured_output_unsupported: 'This model cannot return structured output.',
  output_budget_low: 'The output allowance is larger than this model supports.',
  input_budget_low: 'The input allowance is too small for this model.',
  missing_credential: 'No API key is connected for this provider.',
  provider_not_allowed: 'This provider is not allowed for the project.',
};

/**
 * F14 `checkProfile`: MODEL_UNSUPPORTED when the model is not in the catalog, the effort is not supported, structured
 * output is unavailable, or `maxOutputTokens` exceeds the capability. `details.reason` is the warning code.
 */
export function checkProfile(profile: CheckedProfile, entry: CatalogModel | undefined, capabilities?: ModelCapabilities): Result<void> {
  const { providerId, modelId } = profile;
  const fail = (reason: CapabilityWarningCode): Result<void> =>
    err(errors.modelUnsupported({ providerId, modelId, reason }, { userMessage: MESSAGES[reason] }));
  if (entry === undefined) return fail('model_unknown');
  const caps = capabilities ?? entry.capabilities;
  if (profile.params.effort !== undefined && !caps.effortLevels.includes(profile.params.effort)) return fail('effort_unsupported');
  if (!caps.structuredOutput) return fail('structured_output_unsupported');
  if (caps.maxOutputTokens !== undefined && profile.params.maxOutputTokens > caps.maxOutputTokens) return fail('output_budget_low');
  return ok(undefined);
}

/** ProfileRow → the contracts ModelProfile DTO. */
export function toModelProfile(p: ProfileRow): ModelProfile {
  return { id: p.id, name: p.name, providerId: p.providerId, modelId: p.modelId, params: p.params, revision: p.revision, updatedAt: p.updatedAt };
}

function warning(p: ProfileRow, code: CapabilityWarningCode): CapabilityWarning {
  return { stepKey: null, profileId: p.id, code, message: MESSAGES[code] };
}

/** `profiles.list`: every profile with its capability warnings (empty = passes). The renderer never re-checks. */
export function profilesWithWarnings(r: Repos): { profile: ModelProfile; warnings: CapabilityWarning[] }[] {
  return r.profiles.list().map((p) => {
    const warnings: CapabilityWarning[] = [];
    const checked = checkProfile(p, r.catalog.get(p.providerId, p.modelId));
    if (!checked.ok) warnings.push(warning(p, checked.error.details?.['reason'] as CapabilityWarningCode));
    if (r.credentials.get(p.providerId) === undefined) warnings.push(warning(p, 'missing_credential'));
    return { profile: toModelProfile(p), warnings };
  });
}

/** Resolves a workflow `profile` reference (a profile name, compared case-insensitively). */
export function findProfileByName(r: Repos, name: string): ProfileRow | undefined {
  const exact = r.profiles.getByName(name);
  if (exact !== undefined) return exact;
  const lower = name.toLowerCase();
  return r.profiles.list().find((p) => p.name.toLowerCase() === lower);
}
