// E1: run-level inspector data that `RunDetail` carries next to the F2 actions — every attempt of the run, the newest
// context manifest, the choose-profile options with their local reservation estimate (no network: catalog prices and
// the step's last estimated input tokens), the step display names / instruction versions, and the action facts that
// need more than the run row (a missing credential ref behind `paused(auth_required)`).
import { upperBound } from '@relay/contracts';
import type { ManifestRef, ProfileOption, ProviderId, StepKey, StepMeta } from '@relay/contracts';
import type { AttemptRow, Repos, RunRow, StepRow } from '@relay/storage';
import type { ModelStepSnapshot } from './ports.js';
import { modelOutputCap, profileProblem } from './profiles.js';
import { SnapshotError, effectiveModelSteps, snapshotOf } from './snapshot.js';

/** The effective model steps, or an empty map for a malformed snapshot (views never throw on one). */
function modelSteps(r: Repos, run: Pick<RunRow, 'id' | 'snapshot'>): ReadonlyMap<StepKey, ModelStepSnapshot> {
  try {
    return effectiveModelSteps(r, run);
  } catch (e) {
    if (e instanceof SnapshotError) return new Map();
    throw e;
  }
}

/** Latest rows of model steps that still have work (not succeeded / skipped), in ordinal order. */
function openModelRows(latest: readonly StepRow[], models: ReadonlyMap<StepKey, ModelStepSnapshot>): StepRow[] {
  return latest.filter((s) => models.has(s.stepKey) && s.state !== 'succeeded' && s.state !== 'skipped');
}

/**
 * The providers of the run's open model steps that have no credential ref (the ref repo, never the key). `resume`
 * from `paused(auth_required)` fails while this is non-empty.
 */
export function providersMissingCredential(r: Repos, run: Pick<RunRow, 'id' | 'snapshot'>, latest: readonly StepRow[]): ProviderId[] {
  const models = modelSteps(r, run);
  const providers = new Set(openModelRows(latest, models).flatMap((s) => models.get(s.stepKey)?.profile.providerId ?? []));
  return [...providers].filter((p) => r.credentials.get(p) === undefined);
}

/** True when the run is `paused(auth_required)` and a provider of an open step has no credential ref. */
export function missingCredentialFact(r: Repos, run: RunRow, latest: readonly StepRow[]): boolean {
  if (run.status !== 'paused' || run.pauseReason !== 'auth_required') return false;
  return providersMissingCredential(r, run, latest).length > 0;
}

/** The step `choose_profile` applies to: the failed model step (via retryStep), else the first ready/pending one. */
export function chooseProfileStep(latest: readonly StepRow[], models: ReadonlyMap<StepKey, ModelStepSnapshot>): StepRow | undefined {
  const open = openModelRows(latest, models);
  return open.find((s) => s.state === 'failed') ?? open.find((s) => s.state === 'ready' || s.state === 'pending');
}

/** `inputTokens` of a stored attempt estimate (`UsageEstimate`), or null. */
function estimatedInputTokensOf(a: AttemptRow | undefined): number | null {
  const v = (a?.estimate as { inputTokens?: unknown } | null | undefined)?.inputTokens;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** The step's last estimated input tokens: the blocking detail (reserve-time estimate), else its newest attempt's; null when never estimated. */
function lastInputTokens(r: Repos, run: RunRow, step: StepRow, attempts: readonly AttemptRow[]): number | null {
  const detail = run.statusDetail?.details;
  const fromDetail = detail?.['stepKey'] === step.stepKey ? detail['estimatedInputTokens'] : undefined;
  if (typeof fromDetail === 'number' && Number.isSafeInteger(fromDetail) && fromDetail >= 0) return fromDetail;
  const rows = new Set(r.steps.listForRun(run.id).filter((s) => s.stepKey === step.stepKey).map((s) => s.id));
  return estimatedInputTokensOf(attempts.filter((a) => rows.has(a.stepRunId)).at(-1));
}

/**
 * Choose-profile options for the blocked step (empty unless `choose_profile` is offered): every profile whose provider
 * the project allows, with a credential ref, whose model is in the catalog and supported, priced locally as
 * `upperBound(last estimated input tokens, the step's output allowance, catalog prices)`. Never calls a provider.
 */
export function profileOptionsOf(r: Repos, run: RunRow, latest: readonly StepRow[], attempts: readonly AttemptRow[], offered: boolean): ProfileOption[] {
  if (!offered) return [];
  const models = modelSteps(r, run);
  const step = chooseProfileStep(latest, models);
  const snap = step === undefined ? undefined : models.get(step.stepKey);
  if (step === undefined || snap === undefined) return [];
  const allowed = r.projects.get(run.projectId).providerPolicy.allowedProviderIds;
  const estimated = lastInputTokens(r, run, step, attempts);
  const inputTokens = estimated ?? 0;
  const basis = estimated === null ? ('minimum' as const) : ('step_estimate' as const);
  // L-1: the limit a switch would start from — the run's original limit for the step (a switch revisits it per model).
  const original = originalOutputLimit(run, step.stepKey) ?? snap.maxOutputTokens;
  return r.profiles.list().flatMap((p): ProfileOption[] => {
    if (!allowed.includes(p.providerId) || r.credentials.get(p.providerId) === undefined) return [];
    const entry = r.catalog.get(p.providerId, p.modelId);
    // L-3: a profile asking for more output than its model returns is clamped (never hidden): profileProblem ignores it.
    if (entry === undefined || profileProblem(p, entry) !== null) return [];
    // L-1: a model whose cap is below the step's limit is listed with the lowered limit (a note), never hidden.
    const limit = Math.min(original, modelOutputCap(r, { providerId: p.providerId, modelId: p.modelId, capabilities: entry.capabilities }));
    return [{ stepKey: step.stepKey, profileId: p.id, profileName: p.name, providerId: p.providerId, modelId: p.modelId,
      reservationMicrousd: upperBound(inputTokens, limit, entry.prices), estimatedInputTokens: inputTokens, basis,
      current: p.name === snap.profile.name, ...(limit < original ? { outputLimitLoweredTo: limit } : {}) }];
  });
}

/** The output limit the run started with for a model step (its snapshot), or null (malformed snapshot / not a model step). */
function originalOutputLimit(run: Pick<RunRow, 'snapshot'>, stepKey: StepKey): number | null {
  try {
    const s = snapshotOf(run).steps[stepKey];
    return s?.kind === 'model' ? s.maxOutputTokens : null;
  } catch (e) {
    if (e instanceof SnapshotError) return null;
    throw e;
  }
}

/** Display name (workflow spec) and instruction version (run snapshot) per step key, in step order. */
export function stepMetaOf(r: Repos, run: RunRow, latest: readonly StepRow[]): StepMeta[] {
  const spec = r.workflows.getVersionById(run.workflowVersionId)?.spec;
  const names = new Map((spec?.steps ?? []).map((s) => [s.id as string, s.name ?? null]));
  let steps: ReturnType<typeof snapshotOf>['steps'] = {};
  try {
    steps = snapshotOf(run).steps;
  } catch (e) {
    if (!(e instanceof SnapshotError)) throw e;
  }
  return latest.map((s) => {
    const snap = steps[s.stepKey];
    return { stepKey: s.stepKey, name: names.get(s.stepKey) ?? null, instructionVersion: snap?.kind === 'model' ? snap.instructionVersion : null };
  });
}

/** The newest context manifest artifact of any attempt of the run (null when none was written or it was purged). */
export function latestManifestOf(r: Repos, run: RunRow, steps: readonly StepRow[]): ManifestRef | null {
  const row = r.artifacts.listForRun(run.id, ['context_manifest']).filter((a) => a.attemptId !== null && a.stepRunId !== null && a.purgedAt === null).at(-1);
  if (row?.attemptId == null || row.stepRunId == null) return null;
  const step = steps.find((s) => s.id === row.stepRunId);
  return step === undefined ? null : { stepRunId: step.id, stepKey: step.stepKey, attemptId: row.attemptId, artifactId: row.id };
}
