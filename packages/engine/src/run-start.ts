// 06 F15: `runs.start` / `runs.preflight` — the FR-03 snapshot service. Async resolution happens BEFORE the
// transaction (R4-29); the transaction inserts the run, the step rows (synthetic intake/finalize included), the
// `allowance_set` ledger entry, the idempotency key, and `run.created`.
import { DEFAULT_LIMITS, RESERVED_STEP_KEYS, err, errors, ok, runLimitsSchema, toValidationIssues } from '@relay/contracts';
import type {
  AppError,
  EpochMs,
  ModelProfile,
  ProfileId,
  ProfileSnapshot,
  ProviderId,
  Result,
  RunId,
  RunLimits,
  RunPreflight,
  RunStartInput,
  RunStatus,
  StepKey,
  WorkflowSpec,
} from '@relay/contracts';
import type { ProjectRow, Repos, StepInsert, WorkflowVersionRow } from '@relay/storage';
import { admit, allowanceSetEntries, upperBound } from './budget.js';
import type { Outstanding } from './budget.js';
import { monthWindow } from './clock.js';
import { requestHash } from './hash.js';
import type { EngineCtx, ModelStepSnapshot, RunSnapshot, StepSnapshot } from './ports.js';
import { checkProfile, findProfileByName, toModelProfile } from './profiles.js';
import type { PostCommitEffect } from './run-machine.js';
import { appendRunEvent, runEffects } from './run-machine.js';
import { outputKindOf } from './snapshot.js';

/** Parsed `runs.start` input (the IPC schema output). */
export type StartInput = Omit<RunStartInput, 'idempotencyKey'> & { readonly idempotencyKey?: string };

/** Everything resolved before the transaction. */
export interface PreparedRun {
  readonly project: ProjectRow;
  readonly version: WorkflowVersionRow;
  readonly snapshot: RunSnapshot;
  readonly limits: RunLimits;
  readonly stepKeys: readonly StepKey[];
}

const OP = 'runs.start';
const INTAKE = RESERVED_STEP_KEYS[0] as StepKey;
const FINALIZE = RESERVED_STEP_KEYS[1] as StepKey;

async function resolveProfile(ctx: EngineCtx, project: ProjectRow, stepKey: StepKey, ref: ModelProfile | undefined): Promise<Result<ProfileSnapshot>> {
  if (ref === undefined) return err(errors.notFound('profile', {}, { details: { stepKey } }));
  if (!project.providerPolicy.allowedProviderIds.includes(ref.providerId)) {
    return err(errors.permissionDenied('provider_not_allowed', { details: { stepKey, providerId: ref.providerId } }));
  }
  const entry = ctx.db.repos.catalog.get(ref.providerId, ref.modelId);
  let capabilities;
  try {
    capabilities = await ctx.providers.get(ref.providerId).capabilities(ref.modelId);
  } catch {
    return err(errors.modelUnsupported({ providerId: ref.providerId, modelId: ref.modelId, reason: 'no_adapter' }));
  }
  const checked = checkProfile(ref, entry, capabilities);
  if (!checked.ok) return checked;
  if (entry === undefined) return err(errors.modelUnsupported({ providerId: ref.providerId, modelId: ref.modelId })); // narrowed above
  return ok({ ...ref, capabilities, prices: entry.prices, priceCatalogVersion: entry.catalogVersion });
}

function profileRef(r: Repos, stepKey: StepKey, specProfile: string, overrides: Readonly<Record<string, ProfileId>>): ModelProfile | undefined {
  const override = overrides[stepKey];
  const row = override === undefined ? findProfileByName(r, specProfile) : r.profiles.get(override);
  return row === undefined ? undefined : toModelProfile(row);
}

function validationError(path: string, message: string, code: string): AppError {
  return errors.validationFailed([{ path, message, code }]);
}

function limitsFor(spec: WorkflowSpec, overrides: StartInput['limitOverrides']): Result<RunLimits> {
  const parsed = runLimitsSchema.safeParse({ ...DEFAULT_LIMITS, ...spec.limits, ...overrides });
  return parsed.success ? ok(parsed.data) : err(errors.validationFailed(toValidationIssues(parsed.error.issues)));
}

async function buildSnapshot(ctx: EngineCtx, project: ProjectRow, version: WorkflowVersionRow, input: StartInput): Promise<Result<RunSnapshot>> {
  const spec = version.spec;
  const overrides = input.profileOverrides ?? {};
  const modelKeys = new Set(spec.steps.filter((s) => s.kind === 'model').map((s) => s.id));
  for (const key of Object.keys(overrides)) {
    if (!modelKeys.has(key as StepKey)) return err(validationError(`profileOverrides.${key}`, 'Not a model step of this workflow.', 'unknown_step'));
  }
  const steps: Record<string, StepSnapshot> = { [INTAKE]: { kind: 'intake', dependsOn: [] } };
  for (const s of spec.steps) {
    const dependsOn = s.dependsOn.length === 0 ? [INTAKE] : [...s.dependsOn];
    if (s.kind === 'approval') {
      steps[s.id] = { kind: 'approval', bindTo: [...s.bindTo], dependsOn };
      continue;
    }
    const profile = await resolveProfile(ctx, project, s.id, profileRef(ctx.db.repos, s.id, s.profile, overrides));
    if (!profile.ok) return profile;
    const snap: ModelStepSnapshot = {
      kind: 'model', role: s.role, profile: profile.value, outputSchema: s.outputSchema, outputKind: outputKindOf(s.outputSchema),
      instructionVersion: s.instructionVersion, maxOutputTokens: s.maxOutputTokens ?? profile.value.params.maxOutputTokens,
      retryPolicy: s.retryPolicy, memoryScope: s.memoryScope, dependsOn,
    };
    steps[s.id] = snap;
  }
  const last = spec.steps.at(-1)?.id ?? INTAKE;
  steps[FINALIZE] = { kind: 'finalize', dependsOn: [last] };
  return ok({
    steps,
    workflowContentHash: version.contentHash,
    catalogVersion: ctx.db.repos.catalog.latestVersion() ?? '',
    memoryIncludeIds: [...(input.memoryRecordIds ?? [])],
  });
}

function checkInput(r: Repos, input: StartInput): AppError | null {
  if (input.input.kind === 'files') return null;
  const diff = r.artifacts.get(input.input.diffArtifactId);
  return diff?.kind === 'input_diff' && diff.projectId === input.projectId ? null : errors.notFound('input_diff');
}

/** Resolves and validates everything `runs.start` needs (shared with preflight; no writes). */
export async function prepareRun(ctx: EngineCtx, input: StartInput): Promise<Result<PreparedRun>> {
  const r = ctx.db.repos;
  const project = r.projects.find(input.projectId);
  if (project === undefined) return err(errors.notFound('project'));
  if (project.archivedAt !== null) return err(errors.conflict({ reason: 'project_archived' }));
  const version = r.workflows.getVersion(input.workflowId, input.workflowVersion);
  if (version === undefined) return err(errors.notFound('workflow_version'));
  if (version.status !== 'validated') return err(validationError('workflowVersion', 'Only validated workflow versions can run.', 'not_validated'));
  const inputError = checkInput(r, input);
  if (inputError !== null) return err(inputError);
  const limits = limitsFor(version.spec, input.limitOverrides);
  if (!limits.ok) return limits;
  const snapshot = await buildSnapshot(ctx, project, version, input);
  if (!snapshot.ok) return snapshot;
  const stepKeys = [INTAKE, ...version.spec.steps.map((s) => s.id), FINALIZE];
  return ok({ project, version, snapshot: snapshot.value, limits: limits.value, stepKeys });
}

function stepRows(ctx: EngineCtx, runId: RunId, p: PreparedRun, now: EpochMs): StepInsert[] {
  return p.stepKeys.map((stepKey, ordinal) => {
    const s = p.snapshot.steps[stepKey];
    return { id: ctx.ids.next('stepRun'), runId, stepKey, ordinal, state: 'pending', profileName: s?.kind === 'model' ? s.profile.name : null, createdAt: now };
  });
}

/** `runs.start`. A replay of the same idempotency key returns the stored `{ runId, status }`. */
export async function startRun(ctx: EngineCtx, input: RunStartInput): Promise<Result<{ runId: RunId; status: RunStatus }>> {
  const hash = requestHash({ ...input });
  const replay = (): Result<{ runId: RunId; status: RunStatus }> | null => {
    const stored = ctx.db.repos.idempotency.get(OP, input.idempotencyKey);
    if (stored === undefined) return null;
    if (stored.requestHash !== hash) return err(errors.conflict({ reason: 'idempotency_key_reused', op: OP }));
    const runId = stored.result.ids['runId'] as RunId;
    return ok({ runId, status: ctx.db.repos.runs.get(runId).status });
  };
  const early = replay();
  if (early !== null) return early;
  const prepared = await prepareRun(ctx, input);
  if (!prepared.ok) return prepared;
  const p = prepared.value;
  const fx: PostCommitEffect[] = [];
  const result = ctx.db.tx('immediate', (r): Result<{ runId: RunId; status: RunStatus }> => {
    const again = replay(); // a concurrent duplicate committed while we resolved
    if (again !== null) return again;
    const now = ctx.clock.now();
    const runId = ctx.ids.next('run');
    r.runs.insert({ id: runId, projectId: p.project.id, workflowVersionId: p.version.id, goal: input.goal, input: input.input,
      snapshot: p.snapshot, limits: p.limits, idempotencyKey: input.idempotencyKey, createdAt: now });
    r.steps.insertMany(stepRows(ctx, runId, p, now));
    r.ledger.append(allowanceSetEntries({ L: p.limits.budgetMicrousd, attemptId: null, runId, projectId: p.project.id, priceCatalogVersion: null, createdAt: now }));
    r.idempotency.put(OP, input.idempotencyKey, hash, { ids: { runId }, status: 'queued' });
    appendRunEvent(r, fx, runId, 'run.created', { workflowVersionId: p.version.id, goal: input.goal, limits: p.limits });
    fx.push({ kind: 'emit', event: { type: 'run.status', runId, status: 'queued', pauseReason: null, seq: r.events.lastSeq(runId) } });
    fx.push({ kind: 'wake' });
    return ok({ runId, status: 'queued' });
  });
  await runEffects(ctx, fx);
  return result;
}

const ZERO: Outstanding = { C: 0 as Outstanding['C'], R: 0 as Outstanding['R'], U: 0 as Outstanding['U'] };

/** `runs.preflight`: the same resolution as start (dryRun), plus a local estimate of the first reservation. */
export async function preflightRun(ctx: EngineCtx, input: StartInput): Promise<Result<RunPreflight>> {
  const prepared = await prepareRun(ctx, input);
  if (!prepared.ok) return prepared;
  const p = prepared.value;
  let files = 0;
  let bytes = 0;
  let chars = 0;
  if (input.input.kind === 'files') {
    const project = ctx.db.repos.projects.getWithRoot(p.project.id);
    const root = await ctx.projectFs.openRoot(project.rootRealpath);
    if (!root.ok) return root;
    const read = await ctx.projectFs.readSelected(root.value, input.input.relPaths, { exclusions: project.exclusions });
    if (!read.ok) return read;
    files = read.value.files.length;
    bytes = read.value.files.reduce((n, f) => n + f.size, 0);
    chars = read.value.files.reduce((n, f) => n + f.content.length, 0);
  }
  const estimatedInputTokens = Math.ceil((chars * 23) / 64);
  const models = Object.values(p.snapshot.steps).filter((s): s is ModelStepSnapshot => s.kind === 'model');
  const first = models[0];
  const N = first === undefined ? (0 as ReturnType<typeof upperBound>) : upperBound(estimatedInputTokens, first.maxOutputTokens, first.profile.prices);
  const { start, end } = monthWindow(ctx.clock.now());
  const L = p.project.monthlyAllowanceMicrousd;
  const budget = admit({
    run: { L: p.limits.budgetMicrousd, ...ZERO },
    project: L === null ? null : { L, ...ctx.db.repos.ledger.projectMonthBalances(p.project.id, start, end) },
    N,
  }).breakdown;
  const providers: ProviderId[] = [...new Set(models.map((m) => m.profile.providerId))];
  return ok({
    inputSummary: { files, bytes, estimatedInputTokens, memoryRecords: [], providersReceivingContext: providers },
    firstReservation: { N, basis: 'local_estimate' },
    budget,
    issues: [],
  });
}
