// 06 F1: the runner handler table — one handler per runner-routed IPC op + INTERNAL_RUNNER_OPS. The mapped type makes
// the table exhaustive: a missing channel is a compile error. Channels whose feature lands in a later wave return a
// typed INTERNAL error with `details.reason = 'not_implemented'` (never a silent success). Project and run handlers
// live in project-handlers.ts / run-handlers.ts; the export/import, memory, and run-action handlers in their modules.
import { ARTIFACT_INLINE_MAX_BYTES, PROVIDER_IDS, appError, err, errors, ok } from '@relay/contracts';
import type {
  ArtifactContent,
  ArtifactMeta,
  CredentialRef,
  EpochMs,
  ProviderId,
  ProviderStatus,
  Result,
  RunnerChannel,
  RunnerOutputOf,
} from '@relay/contracts';
import type { ArtifactRow, CredentialRefRow, Repos } from '@relay/storage';
import { decideApproval } from './approvals.js';
import { monthWindow, monthWindowOf } from './clock.js';
import { exportLedger, exportProject, exportRunArtifacts, importDiffText } from './export-handlers.js';
import type { HandlerTable, ParsedInputOf } from './handler-types.js';
import { fromUtf8, requestHash } from './hash.js';
import type { IdempotentRequest } from './idempotency.js';
import { recordResult, storedResult } from './idempotency.js';
import * as memoryOps from './memory-handlers.js';
import type { EngineCtx } from './ports.js';
import { deleteProfile, profilesWithWarnings, upsertProfile } from './profiles.js';
import { archiveProject, createFromRoot, previewRoot, projectDetail, updateProject } from './project-handlers.js';
import { decideUnknown, increaseAllowance, resumeRun, retryStep } from './run-actions.js';
import { attemptStepKeys, cancelRun, pauseRun, runSummaryCost, stepDetail } from './run-handlers.js';
import { preflightRun, startRun } from './run-start.js';
import { SETTINGS_KEY, readSettings } from './settings.js';
import { testProviderConnection } from './setup-calls.js';
import { toLedgerEntryView, toRunDetail, toRunSummary } from './views.js';
import { publishWorkflow, saveDraft, toWorkflowView, validateWorkflow } from './workflows.js';

export type { Handler, HandlerTable, ParsedInputOf } from './handler-types.js';

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

function workflowView(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/workflows.get'>) {
  const r = ctx.db.repos;
  const version = input.version === undefined ? r.workflows.latestValidated(input.workflowId) : r.workflows.getVersion(input.workflowId, input.version);
  return version === undefined ? err(errors.notFound('workflow_version')) : ok(toWorkflowView(version));
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
  const req: IdempotentRequest = { op: 'app.createBackup', key: input.idempotencyKey, hash: requestHash({ ...input }) };
  const stored = storedResult(ctx.db.repos, req);
  if (stored !== null) {
    if (!stored.ok) return stored;
    const ids = stored.value.ids;
    return ok({ backupDisplayPath: ids['backupDisplayPath'] ?? '', createdAt: Number(ids['createdAt']) as EpochMs, sizeBytes: Number(ids['sizeBytes']) });
  }
  if (ctx.backup === undefined) return err(notImplemented(ctx, 'relay/v1/app.createBackup'));
  const made = await ctx.backup.create();
  if (!made.ok) return made;
  const b = made.value;
  ctx.db.tx('immediate', (r) => {
    recordResult(r, req, { ids: { backupDisplayPath: b.backupDisplayPath, createdAt: String(b.createdAt), sizeBytes: String(b.sizeBytes) } });
  });
  return ok({ backupDisplayPath: b.backupDisplayPath, createdAt: b.createdAt, sizeBytes: b.sizeBytes });
}

/** Builds the exhaustive handler table over the engine context. */
export function createHandlers(ctx: EngineCtx): HandlerTable {
  const r = ctx.db.repos;
  const sync = <T>(f: () => Result<T>): Promise<Result<T>> => Promise.resolve(f());
  return {
    // app
    'relay/v1/app.getDiagnostics': () => sync(() => diagnostics(ctx)),
    'relay/v1/app.createBackup': (input) => createBackupOp(ctx, input),
    'relay/v1/app.getSettings': () => sync(() => ok(readSettings(r))),
    'relay/v1/app.updateSettings': (patch) =>
      sync(() => ctx.db.txResult('immediate', (tx) => {
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
    'relay/v1/projects.exportTo': (input) => exportProject(ctx, input),
    // providers
    'relay/v1/providers.list': () => sync(() => ok(LISTED_PROVIDERS.map((p) => providerStatus(r, p)))),
    'relay/v1/providers.test': (input) => testProviderConnection(ctx, input),
    'relay/v1/providers.catalog': (input) => sync(() => ok([...r.catalog.list(input.providerId)])),
    'relay/v1/providers.recordCredentialRef': (input) =>
      sync(() => ctx.db.txResult('immediate', (tx) => {
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
    'relay/v1/workflows.list': () => sync(() => ok([...r.workflows.listSummaries()])), // one statement (19)
    'relay/v1/workflows.get': (input) => sync(() => workflowView(ctx, input)),
    'relay/v1/workflows.saveDraft': (input) => sync(() => saveDraft(ctx, input)),
    'relay/v1/workflows.validate': (input) => validateWorkflow(ctx, input),
    'relay/v1/workflows.publish': (input) => publishWorkflow(ctx, input),
    // runs
    'relay/v1/runs.preflight': (input) => preflightRun(ctx, input),
    'relay/v1/runs.start': (input) => startRun(ctx, input),
    'relay/v1/runs.list': (input) =>
      sync(() => {
        // 4 statements per page (batched aggregates), never a projection per run (2).
        const page = r.runs.listSummaries({ projectId: input.projectId, statuses: input.status, sort: input.sort, cursor: input.cursor, limit: input.limit });
        if (!page.ok) return page;
        return ok({ items: page.value.items.map(toRunSummary), nextCursor: page.value.nextCursor });
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
    // memory (07 G5)
    'relay/v1/memory.list': (input) => memoryOps.list(ctx, input),
    'relay/v1/memory.get': (input) => memoryOps.get(ctx, input),
    'relay/v1/memory.create': (input) => memoryOps.create(ctx, input),
    'relay/v1/memory.update': (input) => memoryOps.update(ctx, input),
    'relay/v1/memory.approve': (input) => memoryOps.approve(ctx, input),
    'relay/v1/memory.reject': (input) => memoryOps.reject(ctx, input),
    'relay/v1/memory.archive': (input) => memoryOps.archive(ctx, input),
    'relay/v1/memory.delete': (input) => memoryOps.remove(ctx, input),
    'relay/v1/memory.resolveConflict': (input) => memoryOps.resolveConflict(ctx, input),
    'relay/v1/memory.purgeProjectHistory': (input) => memoryOps.purgeProjectHistory(ctx, input),
    // artifacts
    'relay/v1/artifacts.get': (input) => getArtifact(ctx, input),
    'relay/v1/artifacts.importDiffText': (input) => importDiffText(ctx, input),
    'relay/v1/artifacts.exportTo': (input) => exportRunArtifacts(ctx, input),
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
    'relay/v1/ledger.exportTo': (input) => exportLedger(ctx, input),
  };
}
