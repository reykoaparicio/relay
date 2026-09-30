// 06 F1: the runner handler table — one handler per runner-routed IPC op + INTERNAL_RUNNER_OPS. The mapped type makes
// the table exhaustive: a missing channel is a compile error. Channels whose feature lands in a later wave return a
// typed INTERNAL error with `details.reason = 'not_implemented'` (never a silent success).
import {
  INPUT_CAPS,
  PROVIDER_IDS,
  RAW_RESPONSE_RETENTION_DAYS,
  SETUP_ALLOWANCE_MICROUSD,
  appError,
  appSettingsSchema,
  err,
  errors,
  ok,
  providerPolicySchema,
} from '@relay/contracts';
import type {
  AppSettings,
  ArtifactId,
  CredentialRef,
  INTERNAL_RUNNER_OPS,
  OPERATIONS,
  PreviewResult,
  ProjectDetail,
  ProviderId,
  ProviderStatus,
  Result,
  Role,
  RunId,
  RunnerChannel,
  RunnerOutputOf,
  StepDetail,
  StepKey,
} from '@relay/contracts';
import type { CredentialRefRow, Repos } from '@relay/storage';
import type { ProjectRoot } from '@relay/tools';
import { decideApproval } from './approvals.js';
import { monthWindow, monthWindowOf } from './clock.js';
import { fromUtf8, requestHash } from './hash.js';
import type { EngineCtx } from './ports.js';
import { profilesWithWarnings } from './profiles.js';
import type { PostCommitEffect } from './run-machine.js';
import { applyRunEvent, runEffects } from './run-machine.js';
import { preflightRun, startRun } from './run-start.js';
import { skipOpenSteps } from './step-machine.js';
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

const SETTINGS_KEY = 'app_settings';
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

/** Current settings merged over the defaults (never fails: a malformed stored value falls back to defaults). */
export function readSettings(r: Repos): AppSettings {
  const defaults: AppSettings = {
    theme: 'system', activeProjectId: null, onboardingCompletedAt: null,
    rawResponseRetentionDays: RAW_RESPONSE_RETENTION_DAYS, setupAllowanceMicrousd: SETUP_ALLOWANCE_MICROUSD as AppSettings['setupAllowanceMicrousd'],
  };
  const stored = r.settings.get(SETTINGS_KEY);
  const parsed = appSettingsSchema.safeParse({ ...defaults, ...(typeof stored === 'object' && stored !== null ? stored : {}) });
  return parsed.success ? parsed.data : defaults;
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
  if (version === undefined) return err(errors.notFound('workflow_version'));
  const prompts: Record<string, { instructionVersion: string; role: Role; text: string }> = {};
  for (const s of version.spec.steps) {
    const text = s.kind === 'model' ? version.prompts[s.instructionVersion] : undefined;
    if (s.kind === 'model' && text !== undefined) prompts[s.instructionVersion] = { instructionVersion: s.instructionVersion, role: s.role, text };
  }
  return ok({
    workflowId: version.workflowId,
    version: version.status === 'draft' ? ('draft' as const) : version.version,
    status: version.status,
    draftRevision: version.status === 'draft' ? version.draftRevision : null,
    spec: version.spec,
    contentHash: version.contentHash,
    prompts,
    editable: { prompts: true, profiles: true, limits: true, maxOutputTokens: true, retryPolicy: true, memoryScope: true, structure: false as const },
  });
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

/** Builds the exhaustive handler table over the engine context. */
export function createHandlers(ctx: EngineCtx): HandlerTable {
  const r = ctx.db.repos;
  const todo = <C extends RunnerChannel>(channel: C): Handler<C> => () => Promise.resolve(err(notImplemented(ctx, channel)));
  const sync = <T>(f: () => Result<T>): Promise<Result<T>> => Promise.resolve(f());
  return {
    // app
    'relay/v1/app.getDiagnostics': () => sync(() => diagnostics(ctx)),
    'relay/v1/app.createBackup': todo('relay/v1/app.createBackup'),
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
    'relay/v1/projects.update': todo('relay/v1/projects.update'),
    'relay/v1/projects.archive': todo('relay/v1/projects.archive'),
    'relay/v1/projects.createFromRoot': (input) => createFromRoot(ctx, input),
    'relay/v1/projects.previewRoot': (input) => previewRoot(ctx, input),
    'relay/v1/projects.exportTo': todo('relay/v1/projects.exportTo'),
    // providers
    'relay/v1/providers.list': () => sync(() => ok(LISTED_PROVIDERS.map((p) => providerStatus(r, p)))),
    'relay/v1/providers.test': todo('relay/v1/providers.test'),
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
    'relay/v1/profiles.upsert': todo('relay/v1/profiles.upsert'),
    'relay/v1/profiles.delete': todo('relay/v1/profiles.delete'),
    // workflows
    'relay/v1/workflows.list': () =>
      sync(() => ok(r.workflows.listWorkflows().map((w) => ({
        id: w.id, name: w.name,
        latestValidatedVersion: r.workflows.latestValidated(w.id)?.version ?? null,
        draftVersion: r.workflows.getVersion(w.id, 'draft')?.version ?? null,
      })))),
    'relay/v1/workflows.get': (input) => sync(() => workflowView(ctx, input)),
    'relay/v1/workflows.saveDraft': todo('relay/v1/workflows.saveDraft'),
    'relay/v1/workflows.validate': todo('relay/v1/workflows.validate'),
    'relay/v1/workflows.publish': todo('relay/v1/workflows.publish'),
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
    'relay/v1/runs.resume': todo('relay/v1/runs.resume'),
    'relay/v1/runs.cancel': (input) => cancelRun(ctx, input.runId),
    'relay/v1/runs.increaseAllowance': todo('relay/v1/runs.increaseAllowance'),
    'relay/v1/runs.decideUnknown': todo('relay/v1/runs.decideUnknown'),
    'relay/v1/runs.retryStep': todo('relay/v1/runs.retryStep'),
    'relay/v1/runs.events': (input) =>
      sync(() => {
        const rows = r.events.list(input.runId, input.afterSeq, input.limit + 1);
        const items = rows.slice(0, input.limit);
        const last = items.at(-1);
        return ok({ items: [...items], nextCursor: rows.length > input.limit && last !== undefined ? String(last.seq) : null });
      }),
    // approvals (Wave-1 minimal F10)
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
    'relay/v1/artifacts.get': todo('relay/v1/artifacts.get'),
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
