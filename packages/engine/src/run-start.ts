// 06 F15: `runs.start` / `runs.preflight` — the FR-03 snapshot service. Async resolution happens BEFORE the
// transaction (R4-29); the transaction inserts the run, the step rows (synthetic intake/finalize included), the
// `allowance_set` ledger entry, the idempotency key, and `run.created`.
import { DEFAULT_LIMITS, RESERVED_STEP_KEYS, err, errors, microusd, ok, runLimitsSchema, toValidationIssues } from '@relay/contracts';
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
  ValidationIssue,
  WorkflowSpec,
} from '@relay/contracts';
import type { UsageEstimate } from '@relay/providers';
import type { MemoryItem, ProjectRow, Repos, StepInsert, WorkflowVersionRow } from '@relay/storage';
import { admitAgainstLedger, allowanceSetEntries } from './budget.js';
import { buildModelRequest } from './checkpoints.js';
import type { Outstanding } from './budget.js';
import { diffBlock, renderStepPrompt, renderStepRules, retrievableOf } from './context.js';
import { requestHash } from './hash.js';
import type { IdempotentRequest } from './idempotency.js';
import { recordResult, replayStoredId } from './idempotency.js';
import { selectRunMemory } from './memory.js';
import type { EngineCtx, ModelStepSnapshot, RunSnapshot, StepSnapshot } from './ports.js';
import type { ReadinessIssue } from './policy.js';
import { budgetReadiness, checkStepReadiness, toPreflightIssue } from './policy.js';
import { checkProfile, findProfileByName, toModelProfile } from './profiles.js';
import { adapterOf, isModelRejected, liveCapabilities } from './provider-lookup.js';
import type { PostCommitEffect } from './run-machine.js';
import { appendRunEvent, runEffects } from './run-machine.js';
import { outputKindOf, stepEntries } from './snapshot.js';
import { acknowledgedSuspectedSecrets, diffReferencedPaths } from './steps/intake.js';

/** Parsed `runs.start` input (the IPC schema output). */
export type StartInput = Omit<RunStartInput, 'idempotencyKey'> & { readonly idempotencyKey?: string };

/** Everything resolved before the transaction. */
interface PreparedRun {
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
  const live = await liveCapabilities(ctx, ref.providerId, ref.modelId);
  if (!live.ok && !isModelRejected(live)) return live; // no adapter
  // A model the adapter does not serve is checked with no catalog entry: checkProfile's model_unknown.
  const entry = live.ok ? ctx.db.repos.catalog.get(ref.providerId, ref.modelId) : undefined;
  const checked = checkProfile(ref, entry, live.ok ? live.value : undefined);
  if (!checked.ok) return checked;
  if (entry === undefined || !live.ok) return err(errors.modelUnsupported({ providerId: ref.providerId, modelId: ref.modelId })); // narrowed above
  const capabilities = live.value;
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

/**
 * The run snapshot. `lenient` (preflight only): a model step whose profile cannot be resolved is left out instead of
 * failing, so preflight can report it as an issue ({@link profileIssues}) next to everything else.
 */
async function buildSnapshot(ctx: EngineCtx, project: ProjectRow, version: WorkflowVersionRow, input: StartInput, lenient = false): Promise<Result<RunSnapshot>> {
  const spec = version.spec;
  const overrides = input.profileOverrides ?? {};
  const modelKeys = new Set(spec.steps.filter((s) => s.kind === 'model').map((s) => s.id));
  for (const key of Object.keys(overrides)) {
    if (!modelKeys.has(key as StepKey)) return err(validationError(`profileOverrides.${key}`, 'Not a model step of this workflow.', 'unknown_step'));
  }
  const steps: Partial<Record<StepKey, StepSnapshot>> = { [INTAKE]: { kind: 'intake', dependsOn: [] } };
  for (const s of spec.steps) {
    const dependsOn = s.dependsOn.length === 0 ? [INTAKE] : [...s.dependsOn];
    if (s.kind === 'approval') {
      steps[s.id] = { kind: 'approval', bindTo: [...s.bindTo], dependsOn };
      continue;
    }
    const profile = await resolveProfile(ctx, project, s.id, profileRef(ctx.db.repos, s.id, s.profile, overrides));
    if (!profile.ok && lenient) continue;
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
async function prepareRun(ctx: EngineCtx, input: StartInput, o: { readonly lenient?: boolean } = {}): Promise<Result<PreparedRun>> {
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
  const snapshot = await buildSnapshot(ctx, project, version, input, o.lenient ?? false);
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

/** The request hash `runs.start` recorded on the run's `run.created` event (null for runs created before E1). */
function createdRequestHash(r: Repos, runId: RunId): string | null {
  const created = r.events.list(runId, 0, 1).find((e) => e.type === 'run.created');
  const hash = (created?.payload as { requestHash?: unknown } | undefined)?.requestHash;
  return typeof hash === 'string' ? hash : null;
}

/**
 * E1 #5: `runs.start` retried with a key whose idempotency record expired (24 h) collides with the run that key
 * created. Same request (the hash recorded on `run.created`) → a replay of that run (the record is stored again);
 * another request → CONFLICT `idempotency_key_reused`. Never INTERNAL.
 */
function expiredKeyReplay(r: Repos, req: IdempotentRequest): Result<{ runId: RunId; status: RunStatus }> | null {
  const existing = r.runs.findByIdempotencyKey(req.key); // UNIQUE for ever; the idempotency record expires after 24 h
  if (existing === undefined) return null;
  if (createdRequestHash(r, existing.id) !== req.hash) return err(errors.conflict({ reason: 'idempotency_key_reused', op: req.op }));
  recordResult(r, req, { ids: { runId: existing.id }, status: existing.status });
  return ok({ runId: existing.id, status: existing.status });
}

/** `runs.start`. A replay of the same idempotency key returns the stored `{ runId, status }`. */
export async function startRun(ctx: EngineCtx, input: RunStartInput): Promise<Result<{ runId: RunId; status: RunStatus }>> {
  const req: IdempotentRequest = { op: OP, key: input.idempotencyKey, hash: requestHash({ ...input }) };
  const replay = (): Result<{ runId: RunId; status: RunStatus }> | null => {
    const stored = replayStoredId(ctx, ctx.db.repos, req, 'runId', 'run');
    if (stored === null || !stored.ok) return stored;
    return ok({ runId: stored.value.id, status: ctx.db.repos.runs.get(stored.value.id).status });
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
    try {
      r.runs.insert({ id: runId, projectId: p.project.id, workflowVersionId: p.version.id, goal: input.goal, input: input.input,
        snapshot: p.snapshot, limits: p.limits, idempotencyKey: input.idempotencyKey, createdAt: now });
    } catch (e) {
      // The statement failed alone (the tx is still open): a key whose 24 h record expired collides here (E1 #5).
      const expired = expiredKeyReplay(r, req);
      if (expired !== null) return expired;
      throw e;
    }
    // E1 #2: the chosen memory records are checked exactly like preflight/intake select them (approved, retrievable,
    // this project): a run never starts with a record intake cannot snapshot (an error rolls the insert back).
    const memory = selectRunMemory(r, p.project.id, now, p.snapshot.memoryIncludeIds);
    if (!memory.ok) return memory;
    r.steps.insertMany(stepRows(ctx, runId, p, now));
    r.ledger.append(allowanceSetEntries({ L: p.limits.budgetMicrousd, attemptId: null, runId, projectId: p.project.id, priceCatalogVersion: null, createdAt: now }));
    recordResult(r, req, { ids: { runId }, status: 'queued' });
    appendRunEvent(r, fx, runId, 'run.created', { workflowVersionId: p.version.id, goal: input.goal, limits: p.limits, requestHash: req.hash });
    fx.push({ kind: 'emit', event: { type: 'run.status', runId, status: 'queued', pauseReason: null, seq: r.events.lastSeq(runId) } });
    fx.push({ kind: 'wake' });
    return ok({ runId, status: 'queued' });
  });
  await runEffects(ctx, fx);
  return result;
}

const ZERO: Outstanding = { C: microusd(0), R: microusd(0), U: microusd(0) };

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
  const diff = await diffBlock(ctx, { run: { input: input.input, projectId: p.project.id }, stepSpec: first });
  if (!diff.ok) return diff;
  const ordered = [...files].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0)); // = inputFiles ORDER BY rel_path
  const rules = renderStepRules(memory.map(retrievableOf), first, input.goal, ordered.map((f) => f.relPath));
  const prompt = renderStepPrompt({ roleText, schemaId: first.outputSchema, goal: input.goal, rules, diffBlock: diff.value, files: ordered, repairBlock: '' });
  const request = buildModelRequest(ctx.templates, first, prompt, { attemptId: 'preflight', runId: 'preflight', stepKey, purpose: 'initial' },
    p.project.providerPolicy.providerOptions);
  const adapter = adapterOf(ctx, first.profile.providerId);
  if (!adapter.ok) return adapter;
  return ok(await adapter.value.estimate(request, first.profile.prices, { priceCatalogVersion: first.profile.priceCatalogVersion }));
}

/**
 * `runs.preflight`: the same resolution as start (dryRun), the memory records intake would snapshot (the same
 * {@link selectRunMemory} call, so the preview is the selection), plus the estimate of the first reservation (B7),
 * which renders those records' rules for the first model step.
 */
export async function preflightRun(ctx: EngineCtx, input: StartInput): Promise<Result<RunPreflight>> {
  const prepared = await prepareRun(ctx, input, { lenient: true });
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
  const issues = await profileIssues(ctx, p, input);
  const secretIssues = suspectedSecretIssues(ctx, input, files);
  const models = stepEntries(p.snapshot).flatMap(([key, snap]) => (snap.kind === 'model' ? [{ key, snap }] : []));
  // The first reservation is the first model step of the SPEC; when its profile could not be resolved there is no N.
  const firstKey = p.version.spec.steps.find((s) => s.kind === 'model')?.id;
  const first = models.find((m) => m.key === firstKey);
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
  const admission = admitAgainstLedger(ctx.db.repos.ledger, { run: { L: p.limits.budgetMicrousd, ...ZERO }, project: p.project, N, now: ctx.clock.now() });
  const budget = admission.breakdown;
  const budgetIssue = budgetReadiness(admission);
  if (budgetIssue !== null) issues.push(budgetIssue);
  const providers: ProviderId[] = [...new Set(models.map((m) => m.snap.profile.providerId))];
  return ok({
    inputSummary: {
      files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), estimatedInputTokens,
      memoryRecords: memory.value.map((m) => ({ id: m.record.id, revision: m.current.revision, type: m.record.type, title: m.current.title, pinned: m.record.pinned })),
      providersReceivingContext: providers,
    },
    firstReservation: { N, basis },
    budget,
    issues: [...issues.map(toPreflightIssue), ...secretIssues],
  });
}

/**
 * Files intake would refuse with PERMISSION_DENIED `suspected_secret`: the SAME predicate (tools
 * `unacknowledgedSuspectedSecret`, injected as `projectFs.suspectedSecret`) over the same `readSelected` content and the same acknowledgement list
 * ({@link acknowledgedSuspectedSecrets}) intake uses, so preflight and intake always agree. A diff-input run cannot
 * acknowledge (fail closed). Never echoes the content.
 */
function suspectedSecretIssues(ctx: EngineCtx, input: StartInput, files: readonly { relPath: string; content: string }[]): ValidationIssue[] {
  const acknowledged = acknowledgedSuspectedSecrets(input.input);
  const selected: readonly string[] = input.input.kind === 'files' ? input.input.relPaths : [];
  return files.flatMap((f) => {
    if (ctx.projectFs.suspectedSecret(f, acknowledged) === null) return [];
    const index = selected.indexOf(f.relPath);
    return [{ path: index >= 0 ? `input.relPaths.${String(index)}` : 'input', code: 'suspected_secret',
      message: `"${f.relPath}" looks like it contains a secret. Remove it or confirm sending it.` }];
  });
}

/**
 * F14 preflight issues per model step (the same {@link checkStepReadiness} as the loop's `runChecks`): unknown
 * profile, provider not permitted by the project policy, missing credential ref (the credential-ref repo, never the
 * key), model missing from the catalog or unsupported (live adapter capabilities when available).
 */
async function profileIssues(ctx: EngineCtx, p: PreparedRun, input: StartInput): Promise<ReadinessIssue[]> {
  const r = ctx.db.repos;
  const issues: ReadinessIssue[] = [];
  for (const s of p.version.spec.steps) {
    if (s.kind !== 'model') continue;
    const ref = profileRef(r, s.id, s.profile, input.profileOverrides ?? {});
    if (ref === undefined) {
      issues.push({ stepKey: s.id, reason: 'setup_blocked', code: 'unknown_profile',
        error: errors.notFound('profile', {}, { details: { stepKey: s.id }, userMessage: `No profile named "${s.profile.slice(0, 40)}".` }) });
      continue;
    }
    const live = await liveCapabilities(ctx, ref.providerId, ref.modelId);
    const rejected = isModelRejected(live); // the adapter does not serve the model: checkProfile's model_unknown, once
    issues.push(...checkStepReadiness(p.project.providerPolicy.allowedProviderIds, { stepKey: s.id, profile: ref, capabilities: live.ok ? live.value : undefined,
      catalogEntry: rejected ? undefined : r.catalog.get(ref.providerId, ref.modelId), hasCredential: r.credentials.get(ref.providerId) !== undefined }));
    // Fail closed (provider-lookup.ts): capabilities that cannot be read are an issue, never a catalog guess.
    if (!live.ok && !rejected) issues.push({ stepKey: s.id, reason: 'setup_blocked', code: 'no_adapter', error: live.error });
  }
  return issues;
}
