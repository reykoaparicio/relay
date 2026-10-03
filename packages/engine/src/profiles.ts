// 06 F14: the single profile validator (`checkProfile`) and `profiles.list` warnings (`profilesWithWarnings`).
import { MAX_OUTPUT_TOKENS_CEILING, err, errors, ok } from '@relay/contracts';
import type { CAPABILITY_WARNING_CODES, CapabilityWarning, CatalogModel, ModelCapabilities, ModelProfile, ProfileSnapshot, Result, WorkflowId } from '@relay/contracts';
import type { ProfileRow, Repos } from '@relay/storage';
import type { EngineCtx } from './ports.js';
import { isModelRejected, liveCapabilities } from './provider-lookup.js';

/** A capability warning code (02 `CAPABILITY_WARNING_CODES`). */
type CapabilityWarningCode = (typeof CAPABILITY_WARNING_CODES)[number];

type CheckedProfile = Pick<ModelProfile, 'providerId' | 'modelId' | 'params'>;

const MESSAGES: Readonly<Record<CapabilityWarningCode, string>> = {
  model_unknown: 'This model is not in the price catalog, so its cost cannot be tracked.',
  effort_unsupported: 'This model does not support the selected effort level.',
  structured_output_unsupported: 'This model cannot return structured output.',
  output_budget_low: 'This model returns fewer output tokens than this profile asks for; Relay uses the model\'s maximum instead.',
  input_budget_low: 'The input allowance is too small for this model.',
  missing_credential: 'No API key is connected for this provider.',
  provider_not_allowed: 'This provider is not allowed for the project.',
};

/**
 * Decision 3: the most output tokens the profile's model returns — the catalog's `maxOutputTokens` and the adapter's
 * live capability (the stricter when both are known), else the global ceiling.
 */
export function modelOutputCap(r: Repos, profile: Pick<ProfileSnapshot, 'providerId' | 'modelId' | 'capabilities'>): number {
  const catalog = r.catalog.get(profile.providerId, profile.modelId)?.capabilities.maxOutputTokens;
  const caps = [catalog, profile.capabilities.maxOutputTokens, MAX_OUTPUT_TOKENS_CEILING].filter((n): n is number => n !== undefined);
  return Math.min(...caps);
}

/**
 * F14 `checkProfile`: MODEL_UNSUPPORTED when the model is not in the catalog, the effort is not supported, or
 * structured output is unavailable. `details.reason` is the warning code. L-3: a profile asking for more output than
 * its model returns is NOT a problem — it is clamped to the model's cap everywhere (run start, choose-profile options,
 * workflow validation), with at most the informational `output_budget_low` warning ({@link outputAboveCap}).
 */
export function checkProfile(profile: CheckedProfile, entry: CatalogModel | undefined, capabilities?: ModelCapabilities): Result<void> {
  const reason = profileProblem(profile, entry, capabilities);
  if (reason === null) return ok(undefined);
  return err(errors.modelUnsupported({ providerId: profile.providerId, modelId: profile.modelId, reason }, { userMessage: MESSAGES[reason] }));
}

/**
 * The {@link checkProfile} rule as a typed code: the first problem (`model_unknown`, `effort_unsupported`,
 * `structured_output_unsupported`) or null when the profile passes. `capabilities` defaults to the catalog entry's.
 */
export function profileProblem(profile: CheckedProfile, entry: CatalogModel | undefined, capabilities?: ModelCapabilities): CapabilityWarningCode | null {
  if (entry === undefined) return 'model_unknown';
  const caps = capabilities ?? entry.capabilities;
  if (profile.params.effort !== undefined && !caps.effortLevels.includes(profile.params.effort)) return 'effort_unsupported';
  if (!caps.structuredOutput) return 'structured_output_unsupported';
  return null;
}

/** L-3: the model cap when the profile's own output setting is above it (the profile is clamped to it), else null. */
export function outputAboveCap(profile: CheckedProfile, entry: CatalogModel | undefined, capabilities?: ModelCapabilities): number | null {
  const cap = (capabilities ?? entry?.capabilities)?.maxOutputTokens;
  return cap !== undefined && profile.params.maxOutputTokens > cap ? cap : null;
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
function warningsFor(r: Repos, p: ProfileRow): CapabilityWarning[] {
  const warnings: CapabilityWarning[] = [];
  const entry = r.catalog.get(p.providerId, p.modelId);
  const problem = profileProblem(p, entry);
  if (problem !== null) warnings.push(warning(p, problem));
  // L-3: informational only — the profile is clamped to the model's cap wherever it is used.
  else if (outputAboveCap(p, entry) !== null) warnings.push(warning(p, 'output_budget_low'));
  if (r.credentials.get(p.providerId) === undefined) warnings.push(warning(p, 'missing_credential'));
  return warnings;
}

/** Parsed `profiles.upsert` input. */
interface UpsertProfileInput {
  readonly profile: Omit<ModelProfile, 'id' | 'revision' | 'updatedAt'> & { readonly id?: ModelProfile['id'] | undefined };
  readonly expectedRevision?: number | undefined;
}

/**
 * `profiles.upsert` (FR-03): validated against the catalog and the adapter's live capabilities (resolved before the
 * tx); MODEL_UNSUPPORTED when `checkProfile` fails. The capability snapshot + catalog version are stored with it.
 * Renaming a profile that any workflow version references → CONFLICT `{ reason: 'profile_in_use', workflows }`.
 */
export async function upsertProfile(ctx: EngineCtx, input: UpsertProfileInput): Promise<Result<{ profile: ModelProfile; warnings: CapabilityWarning[] }>> {
  const p = input.profile;
  const live = await liveCapabilities(ctx, p.providerId, p.modelId); // fail closed (provider-lookup.ts)
  if (!live.ok && !isModelRejected(live)) return live; // no adapter
  // A model the adapter does not serve is checked with no catalog entry: checkProfile's model_unknown.
  const entry = live.ok ? ctx.db.repos.catalog.get(p.providerId, p.modelId) : undefined;
  const checked = checkProfile(p, entry, live.ok ? live.value : undefined);
  if (!checked.ok) return checked;
  if (entry === undefined || !live.ok) return err(errors.modelUnsupported({ providerId: p.providerId, modelId: p.modelId })); // narrowed above
  const capabilities = live.value;
  return ctx.db.txResult('immediate', (r) => {
    // B8: workflow steps reference profiles by NAME, so a rename would silently break every referencing version.
    const current = p.id === undefined ? undefined : r.profiles.get(p.id);
    if (current !== undefined && current.name.toLowerCase() !== p.name.toLowerCase()) {
      const workflows = workflowsReferencingProfile(r, current.name);
      if (workflows.length > 0) return err(errors.conflict({ reason: 'profile_in_use', workflows }));
    }
    const saved = r.profiles.upsert({ id: p.id ?? ctx.ids.next('profile'), name: p.name, providerId: p.providerId, modelId: p.modelId, params: p.params,
      capabilitiesSnapshot: capabilities, catalogVersion: entry.catalogVersion }, input.expectedRevision);
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

/**
 * Every workflow version (draft or validated, any version number — any validated version can still be run) whose
 * spec references the profile name (case-insensitive, like {@link findProfileByName}).
 */
function workflowsReferencingProfile(r: Repos, name: string): { id: WorkflowId; name: string; version: number }[] {
  const lower = name.toLowerCase();
  return r.workflows.listWorkflows().flatMap((w) => r.workflows.listVersions(w.id)
    .filter((v) => v.spec.steps.some((s) => s.kind === 'model' && s.profile.toLowerCase() === lower))
    .map((v) => ({ id: w.id, name: w.name, version: v.version })));
}

/** `profiles.delete`: CONFLICT while a draft or the latest validated workflow version references the profile. */
export function deleteProfile(ctx: EngineCtx, profileId: ModelProfile['id']): Result<{ deleted: true }> {
  return ctx.db.txResult('immediate', (r) => {
    const row = r.profiles.get(profileId);
    if (row === undefined) return err(errors.notFound('profile'));
    const users = referencingWorkflows(r, row.name);
    if (users.length > 0) return err(errors.conflict({ reason: 'profile_in_use', workflowIds: users }));
    return r.profiles.delete(profileId) ? ok({ deleted: true as const }) : err(errors.notFound('profile'));
  });
}
