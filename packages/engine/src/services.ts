// 06 F1: the runner handler table — one handler per runner-routed IPC op + INTERNAL_RUNNER_OPS. The mapped type makes
// the table exhaustive: a missing channel is a compile error. Channels whose feature lands in a later wave return a
// typed INTERNAL error with `details.reason = 'not_implemented'` (never a silent success).
import {
  ARTIFACT_INLINE_MAX_BYTES,
  INPUT_CAPS,
  PROVIDER_IDS,
  appError,
  err,
  errors,
  ok,
  providerPolicySchema,
} from '@relay/contracts';
import type {
  ArtifactContent,
  ArtifactId,
  ArtifactMeta,
  EpochMs,
  Project,
  CredentialRef,
  INTERNAL_RUNNER_OPS,
  OPERATIONS,
  PreviewResult,
  ProjectDetail,
  ProviderId,
  ProviderStatus,
  Result,
  RunId,
  RunnerChannel,
  RunnerOutputOf,
  StepDetail,
  StepKey,
} from '@relay/contracts';
import type { ArtifactRow, CredentialRefRow, Repos } from '@relay/storage';
import type { ProjectRoot } from '@relay/tools';
import { decideApproval } from './approvals.js';
import { monthWindow, monthWindowOf } from './clock.js';
import { fromUtf8, requestHash } from './hash.js';
import type { EngineCtx } from './ports.js';
import { deleteProfile, profilesWithWarnings, upsertProfile } from './profiles.js';
import { SETTINGS_KEY, readSettings } from './settings.js';

export { readSettings } from './settings.js';
import type { PostCommitEffect } from './run-machine.js';
import { applyRunEvent, runEffects } from './run-machine.js';
import { preflightRun, startRun } from './run-start.js';
import { skipOpenSteps } from './step-machine.js';
import { decideUnknown, increaseAllowance, reevaluateProjectBudget, resumeRun, retryStep } from './run-actions.js';
import { testProviderConnection } from './setup-calls.js';
import { publishWorkflow, saveDraft, toWorkflowView, validateWorkflow } from './workflows.js';
import {
  allLedgerEntries,
  attemptStepKeys,
  costOfEntries,
  toAttemptView,
  toLedgerEntryView,
  toManifest,
  toRunDetail,
  toRunSummary,
  toStepOutput,
  toStepView,
} from './views.js';

type Ops = typeof OPERATIONS & typeof INTERNAL_RUNNER_OPS;
type DefOf<C> = Extract<Ops[keyof Ops], { channel: C }>;
/** Parsed (schema output) input of a runner channel. */
export type ParsedInputOf<C extends RunnerChannel> = DefOf<C>['input']['_zod']['output'];
/** One runner handler. */
export type Handler<C extends RunnerChannel> = (input: ParsedInputOf<C>) => Promise<Result<RunnerOutputOf<C>>>;
/** The exhaustive handler table (F1). */
export type HandlerTable = { readonly [C in RunnerChannel]: Handler<C> };

/** Providers listed in Settings → Providers (the fake provider is test-only and never listed). */
const LISTED_PROVIDERS: readonly ProviderId[] = PROVIDER_IDS.filter((p) => p !== 'fake');
const DISPLAY_NAMES: Readonly<Record<ProviderId, string>> = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini', fake: 'Fake provider' };

/** The typed "not in this wave" error, naming the channel. */
export function notImplemented(ctx: Pick<EngineCtx, 'ids'>, channel: RunnerChannel) {
  return appError('INTERNAL', {
    userMessage: 'This feature is not available in this build yet.',
    correlationId: ctx.ids.next('correlation'),
    details: { reason: 'not_implemented', channel },
  });
}

function toCredentialRef(row: CredentialRefRow): CredentialRef {
  return { id: row.id, providerId: row.providerId, storageMode: row.storageMode, vaultFile: row.vaultFile, redactedLabel: row.redactedLabel,
    createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function providerStatus(r: Repos, providerId: ProviderId): ProviderStatus {
  const ref = r.credentials.get(providerId);
  const test = ref?.lastTest ?? null;
  const code = test?.code;
  return {
    providerId,
    displayName: DISPLAY_NAMES[providerId],
    connected: ref !== undefined,
    storage: ref?.storageMode ?? 'none',
    redactedLabel: ref?.redactedLabel ?? null,
    lastTest: test === null ? null : { at: test.at, ok: test.ok, ...(code === null || code === undefined ? {} : { code: code as NonNullable<ProviderStatus['lastTest']>['code'] & string }) },
  };
}

async function openProjectRoot(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/projects.previewRoot'>): Promise<Result<{ root: ProjectRoot; exclusions: string[] }>> {
  if ('rootRealpath' in input) {
    const root = await ctx.projectFs.openRoot(input.rootRealpath);
    return root.ok ? ok({ root: root.value, exclusions: [...input.extraExclusions] }) : root;
  }
  const project = ctx.db.repos.projects.find(input.projectId);
  if (project === undefined) return err(errors.notFound('project'));
  const withRoot = ctx.db.repos.projects.getWithRoot(project.id);
  const root = await ctx.projectFs.openRoot(withRoot.rootRealpath);
  return root.ok ? ok({ root: root.value, exclusions: [...project.exclusions, ...input.extraExclusions] }) : root;
}

async function previewRoot(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/projects.previewRoot'>): Promise<Result<PreviewResult>> {
  const opened = await openProjectRoot(ctx, input);
  if (!opened.ok) return opened;
  const scan = await ctx.projectFs.scan(opened.value.root, { exclusions: opened.value.exclusions });
  if (!scan.ok) return scan;
  const s = scan.value;
  return ok({
    included: s.included.map((f) => ({ relPath: f.relPath, sizeBytes: f.size, sha256: f.sha256 ?? null })),
    excluded: s.excluded.map((e) => ({ relPath: e.relPath as PreviewResult['excluded'][number]['relPath'], reason: e.reason })),
    totals: { files: s.totals.includedFiles, bytes: s.totals.includedBytes, capBytes: INPUT_CAPS.maxTotalBytes, capFiles: INPUT_CAPS.maxFiles },
  });
}

async function createFromRoot(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/projects.createFromRoot'>) {
  const op = 'projects.createFromRoot';
  const hash = requestHash({ ...input });
  const replay = (r: Repos) => {
    const stored = r.idempotency.get(op, input.idempotencyKey);
    if (stored === undefined) return null;
    if (stored.requestHash !== hash) return err(errors.conflict({ reason: 'idempotency_key_reused', op }));
    return ok(r.projects.get(stored.result.ids['projectId'] as ReturnType<Repos['projects']['get']>['id']));
  };
  const early = replay(ctx.db.repos);
  if (early !== null) return early;
  const root = await ctx.projectFs.openRoot(input.rootRealpath);
  if (!root.ok) return root;
  return ctx.db.tx('immediate', (r) => {
    const again = replay(r);
    if (again !== null) return again;
    const taken = r.projects.list().some((p) => r.projects.getWithRoot(p.id).rootRealpath === root.value.realpath);
    if (taken) return err(errors.conflict({ reason: 'root_already_used' }));
    const project = r.projects.insert({
      id: ctx.ids.next('project'), name: input.name, rootRealpath: root.value.realpath, rootDisplayPath: input.rootDisplayPath,
      exclusions: input.exclusions, providerPolicy: providerPolicySchema.parse({ allowedProviderIds: input.allowedProviderIds }),
      monthlyAllowanceMicrousd: input.monthlyAllowanceMicrousd, isDemo: input.isDemo, createdAt: ctx.clock.now(),
    });
    r.idempotency.put(op, input.idempotencyKey, hash, { ids: { projectId: project.id } });
    return ok(project);
  });
}

function projectDetail(ctx: EngineCtx, projectId: ParsedInputOf<'relay/v1/projects.get'>['projectId']): Result<ProjectDetail> {
  const r = ctx.db.repos;
  const project = r.projects.find(projectId);
  if (project === undefined) return err(errors.notFound('project'));
  return ok({ ...project, stats: r.projects.stats(projectId, monthWindow(ctx.clock.now()).start) });
}

function workflowView(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/workflows.get'>) {
  const r = ctx.db.repos;
  const version = input.version === undefined ? r.workflows.latestValidated(input.workflowId) : r.workflows.getVersion(input.workflowId, input.version);
  return version === undefined ? err(errors.notFound('workflow_version')) : ok(toWorkflowView(version));
}

async function readJsonArtifact(ctx: EngineCtx, id: ArtifactId | null): Promise<{ schemaId: string | null; value: unknown } | null> {
  if (id === null) return null;
  const row = ctx.db.repos.artifacts.get(id);
  if (row === undefined || row.purgedAt !== null) return null;
  const bytes = await ctx.artifacts.read(row.relPath, row.sizeBytes);
  if (!bytes.ok) return null;
  try {
    return { schemaId: row.schemaId, value: JSON.parse(fromUtf8(bytes.value)) as unknown };
  } catch {
    return null;
  }
}

async function stepDetail(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/runs.getStep'>): Promise<Result<StepDetail>> {
  const r = ctx.db.repos;
  const step = r.steps.find(input.stepId);
  if (step?.runId !== input.runId) return err(errors.notFound('step'));
  const run = r.runs.get(input.runId);
  const detail = toRunDetail(r, r.runs.getInspectorProjection(run.id));
  const view = detail.steps.find((s) => s.id === step.id) ?? toStepView(step, null);
  const attempts = r.attempts.listForStep(step.id);
  const output = await readJsonArtifact(ctx, step.outputArtifactId);
  const latest = attempts.at(-1);
  const manifestRow = latest === undefined ? undefined : r.artifacts.listForRun(run.id, ['context_manifest']).filter((a) => a.attemptId === latest.id).at(-1);
  const manifest = manifestRow === undefined ? null : await readJsonArtifact(ctx, manifestRow.id);
  const attemptIds = new Set<string>(attempts.map((a) => a.id));
  const events = r.events.list(run.id, 0, Number.MAX_SAFE_INTEGER).filter((e) => {
    const p = e.payload;
    return p['stepRunId'] === step.id || (typeof p['attemptId'] === 'string' && attemptIds.has(p['attemptId']));
  });
  return ok({
    step: view,
    output: output === null ? null : toStepOutput(output.schemaId, output.value),
    manifest: manifest === null ? null : toManifest(manifest.value),
    attempts: attempts.map((a) => toAttemptView(r, a, step.stepKey)),
    events,
  });
}

async function cancelRun(ctx: EngineCtx, runId: RunId) {
  const fx: PostCommitEffect[] = [];
  const res = ctx.db.tx('immediate', (r) => {
    const run = r.runs.get(runId);
    const now = ctx.clock.now();
    switch (run.status) {
      case 'queued':
      case 'awaiting_approval':
        skipOpenSteps(r, fx, runId);
        applyRunEvent(r, run, { type: 'CANCEL_REQUESTED' }, now, fx);
        return ok('cancelled' as const);
      case 'paused':
      case 'interrupted':
        skipOpenSteps(r, fx, runId);
        applyRunEvent(r, run, { type: 'STOP_REQUESTED' }, now, fx);
        return ok('cancelled' as const);
      case 'running':
        applyRunEvent(r, run, { type: 'CANCEL_REQUESTED' }, now, fx);
        return ok('cancelling' as const);
      case 'cancelling':
        return ok('cancelling' as const);
      case 'cancelled':
      case 'completed':
      case 'incomplete':
      case 'failed':
        return err(errors.conflict({ reason: 'run_terminal', status: run.status }));
    }
  });
  if (!res.ok) return res;
  if (res.value === 'cancelling') ctx.cancellation.abortRun(runId, { kind: 'cancel' });
  await runEffects(ctx, fx);
  ctx.wake.signal();
  const r = ctx.db.repos;
  const unresolvedCharges = r.attempts.listForRun(runId)
    .filter((a) => a.state === 'unknown' || a.state === 'abandoned')
    .map((a) => ({ attemptId: a.id, liabilityMicrousd: r.ledger.attemptBalances(a.id).unknown }))
    .filter((c) => c.liabilityMicrousd > 0);
  return ok({ status: res.value, unresolvedCharges });
}

function pauseRun(ctx: EngineCtx, runId: RunId) {
  const res = ctx.db.tx('immediate', (r) => {
    const run = r.runs.get(runId);
    if (run.status !== 'running') return err(errors.conflict({ reason: 'run_not_running', status: run.status }));
    r.runs.setPauseRequested(runId, true);
    return ok({ status: run.status, inFlight: ctx.cancellation.hasInFlight(runId) ? ('waiting' as const) : ('none' as const) });
  });
  // B9: wake the loop (after commit) so a backoff / idle sleep ends now and the next iteration applies USER_PAUSE.
  if (res.ok) ctx.wake.signal();
  return res;
}

function runSummaryCost(ctx: EngineCtx, runId: RunId) {
  const r = ctx.db.repos;
  r.runs.get(runId); // NOT_FOUND
  const entries = allLedgerEntries(r, runId);
  const stepOf = attemptStepKeys(r, runId);
  const byStep = new Map<StepKey, typeof entries>();
  for (const e of entries) {
    const key = e.attemptId === null ? undefined : stepOf.get(e.attemptId);
    if (key !== undefined) byStep.set(key, [...(byStep.get(key) ?? []), e]);
  }
  return ok({ ...costOfEntries(entries), byStep: [...byStep].map(([stepKey, es]) => ({ stepKey, cost: costOfEntries(es) })) });
}

function diagnostics(ctx: EngineCtx) {
  const r = ctx.db.repos;
  return ok({
    runner: { state: 'ready' as const, pid: process.pid, lastHeartbeatAt: ctx.clock.now(), restarts: 0 },
    db: { schemaVersion: ctx.db.schemaVersion(), migrationsPending: 0, sizeBytes: ctx.diagnostics?.dbSizeBytes() ?? 0 },
    unresolvedAttempts: r.attempts.listUnresolved().filter((a) => a.state === 'unknown').length,
    secureStorage: { available: false, backend: 'runner' }, // main owns secure storage and overrides this half
    catalog: { version: r.catalog.latestVersion(), models: r.catalog.list().length },
    prompts: { loaded: new Set(ctx.templates.seedVersions().flatMap((s) => Object.keys(s.promptsJson))).size },
  });
}

/** `projects.update` (optimistic on `updated_at`); an allowance edit re-evaluates `paused(budget_project)` runs. */
async function updateProject(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/projects.update'>): Promise<Result<Project>> {
  const { patch } = input;
  const updated = ctx.db.tx('immediate', (r) => {
    const cur = r.projects.find(input.projectId);
    if (cur === undefined) return err(errors.notFound('project'));
    const policyChanged = patch.allowedProviderIds !== undefined || patch.providerOptions !== undefined;
    const providerPolicy = policyChanged
      ? providerPolicySchema.parse({ allowedProviderIds: patch.allowedProviderIds ?? cur.providerPolicy.allowedProviderIds,
        providerOptions: patch.providerOptions ?? cur.providerPolicy.providerOptions })
      : undefined;
    return r.projects.update(input.projectId, {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.exclusions === undefined ? {} : { exclusions: patch.exclusions }),
      ...(providerPolicy === undefined ? {} : { providerPolicy }),
      ...(patch.monthlyAllowanceMicrousd === undefined ? {} : { monthlyAllowanceMicrousd: patch.monthlyAllowanceMicrousd }),
    }, input.expectedUpdatedAt);
  });
  if (!updated.ok) return updated;
  if (patch.monthlyAllowanceMicrousd !== undefined) await reevaluateProjectBudget(ctx, input.projectId);
  return ok(ctx.db.repos.projects.get(input.projectId));
}

/** `projects.archive`: CONFLICT while the project has an active (non-terminal) run. */
function archiveProject(ctx: EngineCtx, projectId: ParsedInputOf<'relay/v1/projects.archive'>['projectId']): Result<Project> {
  return ctx.db.tx('immediate', (r) => {
    const project = r.projects.find(projectId);
    if (project === undefined) return err(errors.notFound('project'));
    const active = r.runs.listActive().filter((run) => run.projectId === projectId).map((run) => run.id);
    if (active.length > 0) return err(errors.conflict({ reason: 'active_run', runIds: active }));
    if (!r.projects.archive(projectId)) return err(errors.conflict({ reason: 'already_archived' }));
    return ok(r.projects.get(projectId));
  });
}

/** Artifact row → ArtifactMeta DTO (no absolute paths). */
function toArtifactMetaView(a: ArtifactRow): ArtifactMeta {
  return { id: a.id, kind: a.kind, schemaId: a.schemaId, runId: a.runId, stepRunId: a.stepRunId, attemptId: a.attemptId, sha256: a.sha256,
    sizeBytes: a.sizeBytes, mediaType: a.mediaType, createdAt: a.createdAt, purged: a.purgedAt !== null };
}

/**
 * `artifacts.get`: JSON artifacts inline as `json` when they fit `maxBytes`, everything else as UTF-8 `text`
 * (truncated at `maxBytes`). A purged file → NOT_FOUND with `details.purged = true` (the row and hash are kept).
 */
async function getArtifact(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/artifacts.get'>): Promise<Result<{ meta: ArtifactMeta; content: ArtifactContent }>> {
  const row = ctx.db.repos.artifacts.get(input.artifactId);
  if (row === undefined) return err(errors.notFound('artifact'));
  if (row.purgedAt !== null) return err(errors.notFound('artifact', { purged: true }, { details: { purgedAt: row.purgedAt } }));
  const maxBytes = input.maxBytes ?? ARTIFACT_INLINE_MAX_BYTES;
  const bytes = await ctx.artifacts.read(row.relPath, Math.max(row.sizeBytes, 1));
  if (!bytes.ok) return bytes;
  const meta = toArtifactMetaView(row);
  const truncated = bytes.value.byteLength > maxBytes;
  const text = fromUtf8(truncated ? bytes.value.subarray(0, maxBytes) : bytes.value);
  if (!truncated && row.mediaType.startsWith('application/json')) {
    try {
      return ok({ meta, content: { kind: 'json', value: JSON.parse(text) as unknown } });
    } catch {
      // not JSON after all: shown as text
    }
  }
  return ok({ meta, content: { kind: 'text', text, truncated } });
}

/** `app.createBackup` (idempotent; storage `createBackup` through the injected port, §18.4). */
async function createBackupOp(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/app.createBackup'>): Promise<Result<RunnerOutputOf<'relay/v1/app.createBackup'>>> {
  const OP = 'app.createBackup';
  const hash = requestHash({ ...input });
  const stored = ctx.db.repos.idempotency.get(OP, input.idempotencyKey);
  if (stored !== undefined) {
    if (stored.requestHash !== hash) return err(errors.conflict({ reason: 'idempotency_key_reused', op: OP }));
    const ids = stored.result.ids;
    return ok({ backupDisplayPath: ids['backupDisplayPath'] ?? '', createdAt: Number(ids['createdAt']) as EpochMs, sizeBytes: Number(ids['sizeBytes']) });
  }
  if (ctx.backup === undefined) return err(notImplemented(ctx, 'relay/v1/app.createBackup'));
  const made = await ctx.backup.create();
  if (!made.ok) return made;
  const b = made.value;
  ctx.db.tx('immediate', (r) => {
    r.idempotency.put(OP, input.idempotencyKey, hash, { ids: { backupDisplayPath: b.backupDisplayPath, createdAt: String(b.createdAt), sizeBytes: String(b.sizeBytes) } });
  });
  return ok({ backupDisplayPath: b.backupDisplayPath, createdAt: b.createdAt, sizeBytes: b.sizeBytes });
}

/** Builds the exhaustive handler table over the engine context. */
export function createHandlers(ctx: EngineCtx): HandlerTable {
  const r = ctx.db.repos;
  const todo = <C extends RunnerChannel>(channel: C): Handler<C> => () => Promise.resolve(err(notImplemented(ctx, channel)));
  const sync = <T>(f: () => Result<T>): Promise<Result<T>> => Promise.resolve(f());
  return {
    // app
    'relay/v1/app.getDiagnostics': () => sync(() => diagnostics(ctx)),
    'relay/v1/app.createBackup': (input) => createBackupOp(ctx, input),
    'relay/v1/app.getSettings': () => sync(() => ok(readSettings(r))),
    'relay/v1/app.updateSettings': (patch) =>
      sync(() => ctx.db.tx('immediate', (tx) => {
        if (patch.activeProjectId !== undefined && patch.activeProjectId !== null && tx.projects.find(patch.activeProjectId) === undefined) {
          return err(errors.validationFailed([{ path: 'activeProjectId', message: 'Unknown project.', code: 'unknown_project' }]));
        }
        const next = { ...readSettings(tx), ...patch };
        tx.settings.set(SETTINGS_KEY, next);
        return ok(readSettings(tx));
      })),
    // projects
    'relay/v1/projects.list': (input) => sync(() => ok([...r.projects.list({ includeArchived: input.includeArchived ?? false })])),
    'relay/v1/projects.get': (input) => sync(() => projectDetail(ctx, input.projectId)),
    'relay/v1/projects.update': (input) => updateProject(ctx, input),
    'relay/v1/projects.archive': (input) => sync(() => archiveProject(ctx, input.projectId)),
    'relay/v1/projects.createFromRoot': (input) => createFromRoot(ctx, input),
    'relay/v1/projects.previewRoot': (input) => previewRoot(ctx, input),
    'relay/v1/projects.exportTo': todo('relay/v1/projects.exportTo'),
    // providers
    'relay/v1/providers.list': () => sync(() => ok(LISTED_PROVIDERS.map((p) => providerStatus(r, p)))),
    'relay/v1/providers.test': (input) => testProviderConnection(ctx, input),
    'relay/v1/providers.catalog': (input) => sync(() => ok([...r.catalog.list(input.providerId)])),
    'relay/v1/providers.recordCredentialRef': (input) =>
      sync(() => ctx.db.tx('immediate', (tx) => {
        const row = tx.credentials.upsert({ id: ctx.ids.next('credentialRef'), providerId: input.providerId, storageMode: input.storageMode,
          vaultFile: input.vaultFile, redactedLabel: input.redactedLabel });
        return ok(toCredentialRef(row));
      })),
    'relay/v1/providers.deleteCredentialRef': (input) => sync(() => ok({ deleted: ctx.db.tx('immediate', (tx) => tx.credentials.delete(input.providerId)) })),
    'relay/v1/providers.listCredentialRefs': () => sync(() => ok(r.credentials.list().map(toCredentialRef))),
    // profiles
    'relay/v1/profiles.list': () => sync(() => ok(profilesWithWarnings(r))),
    'relay/v1/profiles.upsert': (input) => upsertProfile(ctx, input),
    'relay/v1/profiles.delete': (input) => sync(() => deleteProfile(ctx, input.profileId)),
    // workflows
    'relay/v1/workflows.list': () =>
      sync(() => ok(r.workflows.listWorkflows().map((w) => ({
        id: w.id, name: w.name,
        latestValidatedVersion: r.workflows.latestValidated(w.id)?.version ?? null,
        draftVersion: r.workflows.getVersion(w.id, 'draft')?.version ?? null,
      })))),
    'relay/v1/workflows.get': (input) => sync(() => workflowView(ctx, input)),
    'relay/v1/workflows.saveDraft': (input) => sync(() => saveDraft(ctx, input)),
    'relay/v1/workflows.validate': (input) => validateWorkflow(ctx, input),
    'relay/v1/workflows.publish': (input) => publishWorkflow(ctx, input),
    // runs
    'relay/v1/runs.preflight': (input) => preflightRun(ctx, input),
    'relay/v1/runs.start': (input) => startRun(ctx, input),
    'relay/v1/runs.list': (input) =>
      sync(() => {
        const page = r.runs.list({ projectId: input.projectId, statuses: input.status, sort: input.sort, cursor: input.cursor, limit: input.limit });
        if (!page.ok) return page;
        return ok({ items: page.value.items.map((run) => toRunSummary(r.runs.getInspectorProjection(run.id))), nextCursor: page.value.nextCursor });
      }),
    'relay/v1/runs.get': (input) => sync(() => ok(toRunDetail(r, r.runs.getInspectorProjection(input.runId)))),
    'relay/v1/runs.getStep': (input) => stepDetail(ctx, input),
    'relay/v1/runs.pause': (input) => sync(() => pauseRun(ctx, input.runId)),
    'relay/v1/runs.resume': (input) => resumeRun(ctx, input),
    'relay/v1/runs.cancel': (input) => cancelRun(ctx, input.runId),
    'relay/v1/runs.increaseAllowance': (input) => increaseAllowance(ctx, input),
    'relay/v1/runs.decideUnknown': (input) => decideUnknown(ctx, input),
    'relay/v1/runs.retryStep': (input) => retryStep(ctx, input),
    'relay/v1/runs.events': (input) =>
      sync(() => {
        const rows = r.events.list(input.runId, input.afterSeq, input.limit + 1);
        const items = rows.slice(0, input.limit);
        const last = items.at(-1);
        return ok({ items: [...items], nextCursor: rows.length > input.limit && last !== undefined ? String(last.seq) : null });
      }),
    // approvals (F10)
    'relay/v1/approvals.decide': (input) => decideApproval(ctx, input),
    // memory (G5, Wave 3)
    'relay/v1/memory.list': todo('relay/v1/memory.list'),
    'relay/v1/memory.get': todo('relay/v1/memory.get'),
    'relay/v1/memory.create': todo('relay/v1/memory.create'),
    'relay/v1/memory.update': todo('relay/v1/memory.update'),
    'relay/v1/memory.approve': todo('relay/v1/memory.approve'),
    'relay/v1/memory.reject': todo('relay/v1/memory.reject'),
    'relay/v1/memory.archive': todo('relay/v1/memory.archive'),
    'relay/v1/memory.delete': todo('relay/v1/memory.delete'),
    'relay/v1/memory.resolveConflict': todo('relay/v1/memory.resolveConflict'),
    'relay/v1/memory.purgeProjectHistory': todo('relay/v1/memory.purgeProjectHistory'),
    // artifacts
    'relay/v1/artifacts.get': (input) => getArtifact(ctx, input),
    'relay/v1/artifacts.importDiffText': todo('relay/v1/artifacts.importDiffText'),
    'relay/v1/artifacts.exportTo': todo('relay/v1/artifacts.exportTo'),
    // ledger
    'relay/v1/ledger.runSummary': (input) => sync(() => runSummaryCost(ctx, input.runId)),
    'relay/v1/ledger.projectSummary': (input) =>
      sync(() => {
        const project = r.projects.find(input.projectId);
        if (project === undefined) return err(errors.notFound('project'));
        const { start, end } = input.month === undefined ? monthWindow(ctx.clock.now()) : monthWindowOf(input.month);
        const b = r.ledger.projectMonthBalances(project.id, start, end);
        return ok({ trackedMicrousd: b.C, reservedMicrousd: b.R, unknownMicrousd: b.U, allowance: project.monthlyAllowanceMicrousd, label: 'tracked by Relay' as const });
      }),
    'relay/v1/ledger.entries': (input) =>
      sync(() => {
        const page = r.ledger.list(input.runId, { limit: input.limit, cursor: input.cursor, sort: 'created_asc' });
        if (!page.ok) return page;
        const stepOf = attemptStepKeys(r, input.runId);
        return ok({
          items: page.value.items.map((e) => toLedgerEntryView(e, e.attemptId === null ? null : (stepOf.get(e.attemptId) ?? null))),
          nextCursor: page.value.nextCursor,
        });
      }),
    'relay/v1/ledger.exportTo': todo('relay/v1/ledger.exportTo'),
  };
}
