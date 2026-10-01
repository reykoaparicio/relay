// 06 F15: `runs.start` / `runs.preflight` — the FR-03 snapshot service. Async resolution happens BEFORE the
// transaction (R4-29); the transaction inserts the run, the step rows (synthetic intake/finalize included), the
// `allowance_set` ledger entry, the idempotency key, and `run.created`.
import { DEFAULT_LIMITS, RESERVED_STEP_KEYS, err, errors, ok, runLimitsSchema, toValidationIssues } from '@relay/contracts';
import type {
  AppError,
  EpochMs,
  Microusd,
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
import type { UsageEstimate } from '@relay/providers';
import type { MemoryItem, ProjectRow, Repos, StepInsert, WorkflowVersionRow } from '@relay/storage';
import { admit, allowanceSetEntries } from './budget.js';
import { buildModelRequest } from './checkpoints.js';
import type { Outstanding } from './budget.js';
import { monthWindow } from './clock.js';
import { diffBlock, renderStepPrompt, renderStepRules, retrievableOf } from './context.js';
import { requestHash } from './hash.js';
import { selectRunMemory } from './memory.js';
import type { EngineCtx, ModelStepSnapshot, RunSnapshot, StepSnapshot } from './ports.js';
import { checkProfile, findProfileByName, toModelProfile } from './profiles.js';
import type { PostCommitEffect } from './run-machine.js';
import { appendRunEvent, runEffects } from './run-machine.js';
import { outputKindOf } from './snapshot.js';
import { diffReferencedPaths } from './steps/intake.js';

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

export async function resolveProfile(ctx: EngineCtx, project: ProjectRow, stepKey: StepKey, ref: ModelProfile | undefined): Promise<Result<ProfileSnapshot>> {
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
    // Absent ≠ empty (BH-2): null = every approved record (§4.5 default), [] = pinned rules only.
    memoryIncludeIds: input.memoryRecordIds === undefined ? null : [...input.memoryRecordIds],
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
  const result = ctx.db.txResult('immediate', (r): Result<{ runId: RunId; status: RunStatus }> => {
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

/**
 * B7: N of the first model step built exactly like dispatch (F4): the same prompt rendering (role instructions,
 * output contract, goal, constraints, the step's memory rules from the records intake would snapshot, diff, file
 * blocks in `run_input_files` order), `buildModelRequest` (output schema, maxOutputTokens, refusalFallback), and
 * `adapter.estimate` (request overhead, billed hops, allowance prices). Without a key the adapter's local estimate is used.
 */
async function estimateFirstReservation(
  ctx: EngineCtx,
  p: PreparedRun,
  input: StartInput,
  first: ModelStepSnapshot,
  stepKey: StepKey,
  files: readonly { relPath: string; sha256: string; content: string }[],
  memory: readonly MemoryItem[],
): Promise<Result<UsageEstimate>> {
  const roleText = p.version.prompts[first.instructionVersion];
  if (roleText === undefined) return err(errors.modelUnsupported({ reason: 'instructions_missing' }));
  const diff = await diffBlock(ctx, { run: { input: input.input }, stepSpec: first });
  if (!diff.ok) return diff;
  const ordered = [...files].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0)); // = inputFiles ORDER BY rel_path
  const rules = renderStepRules(memory.map(retrievableOf), first, input.goal, ordered.map((f) => f.relPath));
  const prompt = renderStepPrompt({ roleText, schemaId: first.outputSchema, goal: input.goal, rules, diffBlock: diff.value, files: ordered, repairBlock: '' });
  const request = buildModelRequest(ctx.templates, first, prompt, { attemptId: 'preflight', runId: 'preflight', stepKey, purpose: 'initial' },
    p.project.providerPolicy.providerOptions);
  let adapter;
  try {
    adapter = ctx.providers.get(first.profile.providerId);
  } catch {
    return err(errors.modelUnsupported({ providerId: first.profile.providerId, reason: 'no_adapter' }));
  }
  return ok(await adapter.estimate(request, first.profile.prices, { priceCatalogVersion: first.profile.priceCatalogVersion }));
}

/**
 * `runs.preflight`: the same resolution as start (dryRun), the memory records intake would snapshot (the same
 * {@link selectRunMemory} call, so the preview is the selection), plus the estimate of the first reservation (B7),
 * which renders those records' rules for the first model step.
 */
export async function preflightRun(ctx: EngineCtx, input: StartInput): Promise<Result<RunPreflight>> {
  const prepared = await prepareRun(ctx, input);
  if (!prepared.ok) return prepared;
  const p = prepared.value;
  const memory = selectRunMemory(ctx.db.repos, p.project.id, ctx.clock.now(), p.snapshot.memoryIncludeIds);
  if (!memory.ok) return memory;
  let files: { relPath: string; sha256: string; content: string; size: number }[] = [];
  // A diff-input run's context carries the current files its diff references (read like intake will read them).
  const relPaths = input.input.kind === 'files' ? ok(input.input.relPaths) : await diffReferencedPaths(ctx, p.project.id, input.input.diffArtifactId);
  if (!relPaths.ok) return relPaths;
  if (relPaths.value.length > 0) {
    const project = ctx.db.repos.projects.getWithRoot(p.project.id);
    const root = await ctx.projectFs.openRoot(project.rootRealpath);
    if (!root.ok) return root;
    const read = await ctx.projectFs.readSelected(root.value, relPaths.value, { exclusions: project.exclusions });
    if (!read.ok) return read;
    files = read.value.files.map((f) => ({ relPath: f.relPath, sha256: f.sha256, content: f.content, size: f.size }));
  }
  const models = Object.entries(p.snapshot.steps).flatMap(([k, s]) => (s.kind === 'model' ? [{ key: k as StepKey, snap: s }] : []));
  const first = models[0];
  let N = 0 as Microusd;
  let estimatedInputTokens = 0;
  let basis: UsageEstimate['basis'] = 'local_estimate';
  if (first !== undefined) {
    const estimate = await estimateFirstReservation(ctx, p, input, first.snap, first.key, files, memory.value);
    if (!estimate.ok) return estimate;
    N = estimate.value.upperAllowanceMicrousd;
    estimatedInputTokens = estimate.value.inputTokens;
    basis = estimate.value.basis;
  }
  const { start, end } = monthWindow(ctx.clock.now());
  const L = p.project.monthlyAllowanceMicrousd;
  const budget = admit({
    run: { L: p.limits.budgetMicrousd, ...ZERO },
    project: L === null ? null : { L, ...ctx.db.repos.ledger.projectMonthBalances(p.project.id, start, end) },
    N,
  }).breakdown;
  const providers: ProviderId[] = [...new Set(models.map((m) => m.snap.profile.providerId))];
  return ok({
    inputSummary: {
      files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), estimatedInputTokens,
      memoryRecords: memory.value.map((m) => ({ id: m.record.id, revision: m.current.revision, type: m.record.type, title: m.current.title, pinned: m.record.pinned })),
      providersReceivingContext: providers,
    },
    firstReservation: { N, basis },
    budget,
    issues: [],
  });
}
