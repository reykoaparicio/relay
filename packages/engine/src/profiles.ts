// 06 F14: the single profile validator (`checkProfile`) and `profiles.list` warnings (`profilesWithWarnings`).
import { err, errors, ok } from '@relay/contracts';
import type { CAPABILITY_WARNING_CODES, CapabilityWarning, CatalogModel, ModelCapabilities, ModelProfile, Result } from '@relay/contracts';
import type { ProfileRow, Repos } from '@relay/storage';
import type { EngineCtx } from './ports.js';

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
  return r.profiles.list().map((p) => ({ profile: toModelProfile(p), warnings: warningsFor(r, p) }));
}

/** Resolves a workflow `profile` reference (a profile name, compared case-insensitively). */
export function findProfileByName(r: Repos, name: string): ProfileRow | undefined {
  const exact = r.profiles.getByName(name);
  if (exact !== undefined) return exact;
  const lower = name.toLowerCase();
  return r.profiles.list().find((p) => p.name.toLowerCase() === lower);
}

/** The user message of a capability warning code. */
export function profileWarningMessage(code: CapabilityWarningCode): string {
  return MESSAGES[code];
}

/** Warnings of one stored profile (`checkProfile` against its catalog entry + credential presence). */
export function warningsFor(r: Repos, p: ProfileRow): CapabilityWarning[] {
  const warnings: CapabilityWarning[] = [];
  const checked = checkProfile(p, r.catalog.get(p.providerId, p.modelId));
  if (!checked.ok) warnings.push(warning(p, checked.error.details?.['reason'] as CapabilityWarningCode));
  if (r.credentials.get(p.providerId) === undefined) warnings.push(warning(p, 'missing_credential'));
  return warnings;
}

/** Parsed `profiles.upsert` input. */
export interface UpsertProfileInput {
  readonly profile: Omit<ModelProfile, 'id' | 'revision' | 'updatedAt'> & { readonly id?: ModelProfile['id'] | undefined };
  readonly expectedRevision?: number | undefined;
}

/**
 * `profiles.upsert` (FR-03): validated against the catalog and the adapter's live capabilities (resolved before the
 * tx); MODEL_UNSUPPORTED when `checkProfile` fails. The capability snapshot + catalog version are stored with it.
 */
export async function upsertProfile(ctx: EngineCtx, input: UpsertProfileInput): Promise<Result<{ profile: ModelProfile; warnings: CapabilityWarning[] }>> {
  const p = input.profile;
  const entry = ctx.db.repos.catalog.get(p.providerId, p.modelId);
  let capabilities: ModelCapabilities | undefined;
  try {
    capabilities = await ctx.providers.get(p.providerId).capabilities(p.modelId);
  } catch {
    capabilities = undefined; // no adapter: the catalog snapshot decides
  }
  const checked = checkProfile(p, entry, capabilities);
  if (!checked.ok) return checked;
  if (entry === undefined) return err(errors.modelUnsupported({ providerId: p.providerId, modelId: p.modelId })); // narrowed above
  return ctx.db.tx('immediate', (r) => {
    const saved = r.profiles.upsert({ id: p.id ?? ctx.ids.next('profile'), name: p.name, providerId: p.providerId, modelId: p.modelId, params: p.params,
      capabilitiesSnapshot: capabilities ?? entry.capabilities, catalogVersion: entry.catalogVersion }, input.expectedRevision);
    return saved.ok ? ok({ profile: toModelProfile(saved.value), warnings: warningsFor(r, saved.value) }) : saved;
  });
}

/** Workflow versions (drafts + latest validated) whose spec references the profile name (case-insensitive). */
function referencingWorkflows(r: Repos, name: string): string[] {
  const lower = name.toLowerCase();
  return r.workflows.listWorkflows().flatMap((w) => {
    const versions = [r.workflows.getVersion(w.id, 'draft'), r.workflows.latestValidated(w.id)];
    return versions.some((v) => v?.spec.steps.some((s) => s.kind === 'model' && s.profile.toLowerCase() === lower) === true) ? [w.id] : [];
  });
}

/** `profiles.delete`: CONFLICT while a draft or the latest validated workflow version references the profile. */
export function deleteProfile(ctx: EngineCtx, profileId: ModelProfile['id']): Result<{ deleted: true }> {
  return ctx.db.tx('immediate', (r) => {
    const row = r.profiles.get(profileId);
    if (row === undefined) return err(errors.notFound('profile'));
    const users = referencingWorkflows(r, row.name);
    if (users.length > 0) return err(errors.conflict({ reason: 'profile_in_use', workflowIds: users }));
    return r.profiles.delete(profileId) ? ok({ deleted: true as const }) : err(errors.notFound('profile'));
  });
}
