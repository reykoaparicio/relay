// Fake bridge (10 J3): implements EVERY channel in `OPERATIONS` against an in-memory world, validates inputs with the
// contracts schemas, and asserts every output parses with the output schema. Dev (`pnpm dev:renderer?fake=<name>`)
// and tests only: main.tsx imports it dynamically behind `import.meta.env.DEV || MODE === 'test'`, so production
// bundles never contain it.
import {
  appError,
  appSettingsSchema,
  errors,
  isTerminalRunStatus,
  getOperation,
  memoryRecordDetailSchema,
  memoryRecordViewSchema,
  projectSchema,
  providerStatusSchema,
  runDetailSchema,
  runEventSchema,
  toValidationIssues,
  workflowSummarySchema,
  workflowVersionViewSchema,
} from '@relay/contracts';
import type {
  OPERATIONS,
  AppError,
  Channel,
  IdOf,
  IdPrefixKey,
  InputOf,
  IpcResult,
  MemoryRecordDetail,
  OperationKey,
  PauseReason,
  PushEvent,
  RunDetail,
  RunEvent,
  RunStatus,
  ValidationIssue,
  WorkflowDraftPatch,
  WorkflowVersionView,
} from '@relay/contracts';
import type { RelayBridge } from './bridge';
import { allowedRunActions } from './fake-scenarios/allowed-actions';
import { buildScenario, DEFAULT_FAKE_SCENARIO, isFakeScenarioName } from './fake-scenarios/scenarios';
import type { FakeScenarioName } from './fake-scenarios/scenarios';
import { buildRun, costSummary, PROJECT_ID, sha, sid, WORKFLOW_ID } from './fake-scenarios/world';
import type { FakeWorld } from './fake-scenarios/world';

export { FAKE_SCENARIOS, DEFAULT_FAKE_SCENARIO, isFakeScenarioName } from './fake-scenarios/scenarios';
export type { FakeScenarioName } from './fake-scenarios/scenarios';
export type { FakeWorld } from './fake-scenarios/world';

type Op<K extends OperationKey> = (typeof OPERATIONS)[K];
/** Parsed (post-default, branded) input of an operation. */
type ParsedIn<K extends OperationKey> = Op<K>['input']['_zod']['output'];
/** Raw output a handler returns; the bridge parses it with the output schema. */
type RawOut<K extends OperationKey> = Op<K>['output']['_zod']['input'];

interface HandlerContext {
  readonly now: () => number;
  readonly newId: <P extends IdPrefixKey>(p: P) => IdOf<P>;
  readonly emit: (e: PushEvent) => void;
}

type Handler<K extends OperationKey> = (w: FakeWorld, input: ParsedIn<K>, ctx: HandlerContext) => RawOut<K>;

/** Thrown by a handler to answer `{ ok: false, error }`. */
class FakeFailure extends Error {
  readonly error: AppError;
  constructor(error: AppError) {
    super(error.userMessage);
    this.error = error;
  }
}

function fail(error: AppError): never {
  throw new FakeFailure(error);
}

const CHANNEL_PREFIX = 'relay/v1/';

// ---------------------------------------------------------------------------------------------------------------
// World helpers

function findRun(w: FakeWorld, runId: string): RunDetail {
  return w.runs.find((r) => r.id === runId) ?? fail(errors.notFound('run'));
}

function findMemory(w: FakeWorld, recordId: string): MemoryRecordDetail {
  return w.memory.find((m) => m.id === recordId && m.status !== 'deleted') ?? fail(errors.notFound('memory'));
}

function replaceRun(w: FakeWorld, next: RunDetail): RunDetail {
  const parsed = runDetailSchema.parse(next);
  w.runs = w.runs.map((r) => (r.id === parsed.id ? parsed : r));
  return parsed;
}

function hasPatchArtifact(w: FakeWorld, runId: string): boolean {
  for (const a of w.artifacts.values()) if (a.meta.runId === runId && a.meta.kind === 'patch') return true;
  return false;
}

function appendEvent(w: FakeWorld, ctx: HandlerContext, runId: string, type: RunEvent['type'], payload: Record<string, unknown>): void {
  const list = w.events.get(runId) ?? [];
  const seq = (list[list.length - 1]?.seq ?? 0) + 1;
  const event = runEventSchema.parse({ id: ctx.newId('event'), runId, seq, type, at: ctx.now(), payload });
  w.events.set(runId, [...list, event]);
  ctx.emit({ type: 'run.event', event });
}

/** The only status writer of the fake: recomputes `availableActions` (06 F2 table) and pushes the change. */
function setRunStatus(
  w: FakeWorld,
  ctx: HandlerContext,
  run: RunDetail,
  status: RunStatus,
  pauseReason: PauseReason | null = null,
  patch: Partial<RunDetail> = {},
): RunDetail {
  const merged = { ...run, ...patch };
  const terminal = ['completed', 'incomplete', 'cancelled', 'failed'].includes(status);
  const next = replaceRun(w, {
    ...merged,
    status,
    pauseReason: status === 'paused' ? pauseReason : null,
    statusDetail: status === 'paused' ? merged.statusDetail : null,
    pendingApproval: status === 'awaiting_approval' ? merged.pendingApproval : null,
    endedAt: terminal ? (merged.endedAt ?? (ctx.now() as RunDetail['createdAt'])) : null,
    // A run paused from `queued` has never started; it starts when it first runs.
    startedAt: status === 'running' && merged.startedAt === null ? (ctx.now() as RunDetail['createdAt']) : merged.startedAt,
    availableActions: allowedRunActions(status, pauseReason, {
      unknownAttempts: merged.unresolvedAttempts.length,
      hasFailedStep: merged.steps.some((s) => s.state === 'failed'),
      hasPatchArtifact: hasPatchArtifact(w, run.id),
    }),
  });
  appendEvent(w, ctx, run.id, 'run.status_changed', { from: run.status, to: status, pauseReason: next.pauseReason });
  const lastSeq = w.events.get(run.id)?.at(-1)?.seq ?? 0;
  ctx.emit({ type: 'run.status', runId: next.id, status: next.status, pauseReason: next.pauseReason, seq: lastSeq });
  return next;
}

function projectDetail(w: FakeWorld, projectId: string) {
  const project = w.projects.find((p) => p.id === projectId) ?? fail(errors.notFound('project'));
  const runs = w.runs.filter((r) => r.projectId === projectId);
  const active = runs.find((r) => ['queued', 'running', 'awaiting_approval', 'paused', 'interrupted', 'cancelling'].includes(r.status));
  const memory = w.memory.filter((m) => m.projectId === projectId);
  return {
    ...project,
    stats: {
      runs: runs.length,
      activeRunId: active?.id ?? null,
      approvedMemory: memory.filter((m) => m.status === 'approved').length,
      suggestions: memory.filter((m) => m.status === 'suggested').length,
      trackedMonthMicrousd: runs.reduce(
        (sum, r) => sum + r.cost.settledReported + r.cost.settledCalculated + r.cost.settledEstimated,
        0,
      ),
    },
  };
}

/** List projection of a detail (zod strips the detail-only keys). */
/** Normalized title (engine `normalizeTitle`: case and whitespace insensitive). */
function normTitle(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, ' ');
}

function scopesOverlap(a: MemoryRecordDetail['scope'], b: MemoryRecordDetail['scope']): boolean {
  if (a.roles === 'all' || b.roles === 'all') return true;
  const other = b.roles;
  return a.roles.some((r) => other.includes(r));
}

/** Engine `titleConflicts`: approved records of the project with the same title in an overlapping scope. */
function titleConflicts(w: FakeWorld, projectId: string, title: string, scope: MemoryRecordDetail['scope'], exclude?: string): string[] {
  return w.memory
    .filter((m) => m.projectId === projectId && m.status === 'approved' && m.id !== exclude && normTitle(m.title) === normTitle(title) && scopesOverlap(m.scope, scope))
    .map((m) => m.id);
}

/** Engine `memoryConflict`: CONFLICT { reason: 'memory_conflict', conflictsWith }. */
function failMemoryConflict(conflictsWith: readonly string[]): void {
  if (conflictsWith.length > 0) fail(errors.conflict({ reason: 'memory_conflict', conflictsWith: [...new Set(conflictsWith)] }));
}

/** Engine `referencingWorkflows`: workflow versions (draft + latest validated) whose steps name the profile. */
function workflowsUsingProfile(w: FakeWorld, name: string): Array<{ id: string; name: string; version: number | 'draft' }> {
  const lower = name.toLowerCase();
  return w.workflows.flatMap((summary) =>
    w.workflowVersions
      .filter((v) => v.workflowId === summary.id && (v.version === 'draft' || v.version === summary.latestValidatedVersion))
      .filter((v) => v.spec.steps.some((st) => st.kind === 'model' && st.profile.toLowerCase() === lower))
      .map((v) => ({ id: summary.id, name: summary.name, version: v.version })),
  );
}

function toView(m: MemoryRecordDetail) {
  return memoryRecordViewSchema.parse(m);
}

function updateMemory(w: FakeWorld, ctx: HandlerContext, id: string, patch: Partial<MemoryRecordDetail>, event: MemoryRecordDetail['events'][number]['event']): MemoryRecordDetail {
  const current = findMemory(w, id);
  const contentChanged = patch.content !== undefined || patch.title !== undefined;
  const revision = contentChanged ? current.currentRevision + 1 : current.currentRevision;
  const at = ctx.now();
  const next = memoryRecordDetailSchema.parse({
    ...current,
    ...patch,
    excerpt: (patch.content ?? current.content).slice(0, 140),
    currentRevision: revision,
    updatedAt: at,
    revisions: contentChanged
      ? [
          ...current.revisions,
          { revision, title: patch.title ?? current.title, content: patch.content ?? current.content, author: 'user', createdAt: at, sourceRefs: [] },
        ]
      : current.revisions,
    events: [...current.events, { event, revision, actor: 'user', createdAt: at }],
  });
  w.memory = w.memory.map((m) => (m.id === id ? next : m));
  ctx.emit({ type: 'memory.changed', projectId: next.projectId });
  return next;
}

/** The fake engine's `saveDraft`: the P0-editable fields of `patch` applied to `base` as a new draft revision. */
function applyDraftPatch(base: WorkflowVersionView, patch: WorkflowDraftPatch, draftRevision: number): WorkflowVersionView {
  const prompts = Object.fromEntries(
    Object.entries(base.prompts).map(([iv, p]) => [iv, { ...p, text: patch.prompts?.[iv] ?? p.text }]),
  );
  const steps = base.spec.steps.map((step) => {
    const edit = patch.steps?.[step.id];
    if (step.kind !== 'model' || edit === undefined) return step;
    return {
      ...step,
      ...(edit.profile === undefined ? {} : { profile: edit.profile }),
      ...(edit.maxOutputTokens === undefined ? {} : { maxOutputTokens: edit.maxOutputTokens }),
      ...(edit.retryPolicy === undefined ? {} : { retryPolicy: edit.retryPolicy }),
      ...(edit.memoryScope === undefined ? {} : { memoryScope: edit.memoryScope }),
    };
  });
  return workflowVersionViewSchema.parse({
    ...base,
    version: 'draft',
    status: 'draft',
    draftRevision,
    spec: { ...base.spec, limits: { ...base.spec.limits, ...(patch.limits ?? {}) }, steps },
    prompts,
    contentHash: sha(`d4af${String(draftRevision)}`),
  });
}

/** Minimal exclusion glob (fake only): `**` any path, `*` within a segment; a bare name matches any segment. */
function globMatches(glob: string, relPath: string): boolean {
  const g = glob.replace(/\/+$/, '');
  const source = g
    .split('**')
    .map((part) => part.split('*').map((x) => x.replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*');
  const re = new RegExp(g.includes('/') ? `^${source}(/.*)?$` : `(^|/)${source}(/.*)?$`);
  return re.test(relPath);
}

function page<T>(items: readonly T[], limit: number, cursor: string | undefined) {
  const start = cursor === undefined ? 0 : Number(cursor);
  const slice = items.slice(start, start + limit);
  const end = start + slice.length;
  return { items: slice, nextCursor: end < items.length ? String(end) : null };
}

function redactKey(key: string): string {
  const trimmed = key.trim();
  const dash = trimmed.indexOf('-', 3);
  const prefix = trimmed.startsWith('sk-ant-') ? 'sk-ant-' : dash > 0 && dash < 8 ? trimmed.slice(0, dash + 1) : trimmed.slice(0, 3);
  return `${prefix}…${trimmed.slice(-4)}`;
}

/** Admission breakdown of the first reservation (§9.3). `preflightBlocked` worlds carry prior usage over L. */
function fakeBudget(w: FakeWorld, allowance: number | undefined) {
  const N = w.preflightBlocked ? 1_500_000 : 540_000;
  const C = w.preflightBlocked ? 1_200_000 : 0;
  const R = w.preflightBlocked ? 400_000 : 0;
  const L = allowance ?? 3_000_000;
  const total = C + R + N;
  return { L, C, R, U: 0, N, scope: 'run' as const, total, allowed: total <= L };
}

/** Engine `profileWarningMessage` texts of the readiness codes the fake reports (06 F14). */
const READINESS_MESSAGES = {
  missing_credential: 'No API key is connected for this provider.',
  provider_not_allowed: 'This provider is not allowed for the project.',
} as const;

/**
 * 06 F14 preflight readiness per model step of the spec, on its effective profile (spec name ⊕ `profileOverrides`):
 * unknown profile, provider not permitted by the project, no connected credential. Paths `profileOverrides.<step>`.
 */
function readinessIssues(w: FakeWorld, input: InputOf<'relay/v1/runs.preflight'>): ValidationIssue[] {
  const project = w.projects.find((p) => p.id === input.projectId);
  const version = w.workflowVersions.find((v) => v.workflowId === input.workflowId && v.version === input.workflowVersion);
  if (project === undefined || version === undefined) return [];
  const issues: ValidationIssue[] = [];
  for (const step of version.spec.steps) {
    if (step.kind !== 'model') continue;
    const path = `profileOverrides.${step.id}`;
    const overrideId = input.profileOverrides?.[step.id];
    const profile =
      overrideId === undefined
        ? w.profiles.find((p) => p.profile.name.toLowerCase() === step.profile.toLowerCase())
        : w.profiles.find((p) => p.profile.id === overrideId);
    if (profile === undefined) {
      issues.push({ path, code: 'unknown_profile', message: `No profile named "${step.profile.slice(0, 40)}".` });
      continue;
    }
    const providerId = profile.profile.providerId;
    if (!project.providerPolicy.allowedProviderIds.includes(providerId)) {
      issues.push({ path, code: 'provider_not_allowed', message: READINESS_MESSAGES.provider_not_allowed });
    }
    if (w.providers.find((p) => p.providerId === providerId)?.connected !== true) {
      issues.push({ path, code: 'missing_credential', message: READINESS_MESSAGES.missing_credential });
    }
  }
  return issues;
}

/** The provider of the first step whose credential is missing (the queued run pauses `auth_required` for it). */
function firstMissingCredential(w: FakeWorld, input: InputOf<'relay/v1/runs.preflight'>): { stepKey: string; providerId: string } | null {
  const issue = readinessIssues(w, input).find((i) => i.code === 'missing_credential');
  if (issue === undefined) return null;
  const stepKey = issue.path.slice('profileOverrides.'.length);
  const version = w.workflowVersions.find((v) => v.workflowId === input.workflowId && v.version === input.workflowVersion);
  const step = version?.spec.steps.find((s) => s.id === stepKey);
  const overrideId = input.profileOverrides?.[stepKey];
  const profile =
    overrideId === undefined
      ? w.profiles.find((p) => step?.kind === 'model' && p.profile.name.toLowerCase() === step.profile.toLowerCase())
      : w.profiles.find((p) => p.profile.id === overrideId);
  return { stepKey, providerId: profile?.profile.providerId ?? 'anthropic' };
}

// ---------------------------------------------------------------------------------------------------------------
// Handlers: one per OPERATIONS key (a missing key is a compile error; fake-bridge.test.ts checks at runtime).

const HANDLERS: { [K in OperationKey]: Handler<K> } = {
  // ---------- app ----------
  'app.getInfo': (w) => w.info,
  'app.getDiagnostics': (w) => w.diagnostics,
  'app.createBackup': (w, _i, ctx) => ({
    backupDisplayPath: `${w.info.userDataDisplayPath}/backups/relay-${String(ctx.now())}.sqlite`,
    createdAt: ctx.now(),
    sizeBytes: w.diagnostics.db.sizeBytes,
  }),
  'app.exportDiagnostics': (w) =>
    w.dialogCancels.has('app.exportDiagnostics') ? { exported: false } : { exported: true, displayPath: '~/Downloads/relay-diagnostics.zip' },
  'app.openExternal': () => ({ opened: true }),
  'app.getSettings': (w) => w.settings,
  'app.updateSettings': (w, patch) => {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    w.settings = appSettingsSchema.parse({ ...w.settings, ...defined });
    return w.settings;
  },

  // ---------- projects ----------
  'projects.pickDirectory': (_w, _i, ctx) => ({
    selection: { selectionId: ctx.newId('selection'), displayPath: '~/code/my-api', expiresAt: ctx.now() + 10 * 60_000 },
  }),
  'projects.previewFiles': (w, input) => {
    // Like the runner: a project's saved exclusions plus `extraExclusions` move matching files to excluded.
    const saved = 'projectId' in input ? (w.projects.find((p) => p.id === input.projectId)?.exclusions ?? []) : [];
    const patterns = [...saved, ...(input.extraExclusions ?? [])].filter((g) => g.trim() !== '');
    if (patterns.length === 0) return w.preview;
    const hit = (relPath: string) => patterns.some((g) => globMatches(g.trim(), relPath));
    const included = w.preview.included.filter((f) => !hit(f.relPath));
    const moved = w.preview.included.filter((f) => hit(f.relPath)).map((f) => ({ relPath: f.relPath, reason: 'user_pattern' as const }));
    return {
      included,
      excluded: [...w.preview.excluded, ...moved],
      totals: { ...w.preview.totals, files: included.length, bytes: included.reduce((sum, f) => sum + f.sizeBytes, 0) },
    };
  },
  'projects.create': (w, input, ctx) => {
    const project = projectSchema.parse({
      id: ctx.newId('project'),
      name: input.name,
      rootDisplayPath: '~/code/my-api',
      exclusions: input.exclusions ?? [],
      providerPolicy: { allowedProviderIds: input.allowedProviderIds, providerOptions: { openai: { storeResponses: true } } },
      monthlyAllowanceMicrousd: input.monthlyAllowanceMicrousd ?? null,
      isDemo: false,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
      archivedAt: null,
    });
    w.projects = [...w.projects, project];
    return project;
  },
  'projects.list': (w, input) => w.projects.filter((p) => input.includeArchived === true || p.archivedAt === null),
  'projects.get': (w, input) => projectDetail(w, input.projectId),
  'projects.update': (w, input, ctx) => {
    const project = w.projects.find((p) => p.id === input.projectId) ?? fail(errors.notFound('project'));
    if (project.updatedAt !== input.expectedUpdatedAt) fail(errors.conflict({ entity: 'project' }));
    const { patch } = input;
    const next = projectSchema.parse({
      ...project,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.exclusions === undefined ? {} : { exclusions: patch.exclusions }),
      ...(patch.monthlyAllowanceMicrousd === undefined ? {} : { monthlyAllowanceMicrousd: patch.monthlyAllowanceMicrousd }),
      providerPolicy: {
        allowedProviderIds: patch.allowedProviderIds ?? project.providerPolicy.allowedProviderIds,
        providerOptions: patch.providerOptions ?? project.providerPolicy.providerOptions,
      },
      updatedAt: Math.max(ctx.now(), project.updatedAt + 1),
    });
    w.projects = w.projects.map((p) => (p.id === next.id ? next : p));
    return next;
  },
  'projects.archive': (w, input, ctx) => {
    const project = w.projects.find((p) => p.id === input.projectId) ?? fail(errors.notFound('project'));
    const active = w.runs.filter((r) => r.projectId === project.id && !isTerminalRunStatus(r.status)).map((r) => r.id);
    if (active.length > 0) fail(errors.conflict({ reason: 'active_run', runIds: active }));
    if (project.archivedAt !== null) fail(errors.conflict({ reason: 'already_archived' }));
    const next = projectSchema.parse({ ...project, archivedAt: ctx.now(), updatedAt: ctx.now() });
    w.projects = w.projects.map((p) => (p.id === next.id ? next : p));
    return next;
  },
  'projects.export': (w, input) => {
    const project = w.projects.find((p) => p.id === input.projectId) ?? fail(errors.notFound('project'));
    if (w.dialogCancels.has('projects.export')) return { exported: false };
    return { exported: true, displayPath: `~/Downloads/${project.name.toLowerCase().replaceAll(/\s+/g, '-')}.relay.json` };
  },
  'projects.createSample': (w, _i, ctx) => {
    const existing = w.projects.find((p) => p.isDemo);
    if (existing !== undefined) return existing;
    const project = projectSchema.parse({
      id: ctx.newId('project'),
      name: 'Sample API',
      rootDisplayPath: '~/Library/Application Support/Relay/samples/sample-api',
      exclusions: [],
      providerPolicy: { allowedProviderIds: ['anthropic', 'openai'], providerOptions: { openai: { storeResponses: true } } },
      monthlyAllowanceMicrousd: 20_000_000,
      isDemo: true,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
      archivedAt: null,
    });
    w.projects = [...w.projects, project];
    w.settings = { ...w.settings, activeProjectId: project.id };
    return project;
  },

  // ---------- providers ----------
  'providers.list': (w) => w.providers,
  'providers.connect': (w, input, ctx) => {
    if (input.storage === 'os_protected' && !w.diagnostics.secureStorage.available) fail(errors.secureStorageUnavailable());
    const current = w.providers.find((p) => p.providerId === input.providerId);
    const next = providerStatusSchema.parse({
      providerId: input.providerId,
      displayName: current?.displayName ?? input.providerId,
      connected: true,
      storage: input.storage,
      redactedLabel: redactKey(input.apiKey),
      lastTest: null,
    });
    w.authFailing.delete(input.providerId);
    w.providers = current === undefined ? [...w.providers, next] : w.providers.map((p) => (p.providerId === next.providerId ? next : p));
    ctx.emit({ type: 'providers.changed' });
    return next;
  },
  'providers.test': (w, input, ctx) => {
    const current = w.providers.find((p) => p.providerId === input.providerId);
    if (current?.connected !== true) fail(errors.authRequired(input.providerId));
    const ok = !w.authFailing.has(input.providerId);
    const result = {
      ok,
      latencyMs: 420,
      modelProbed: input.providerId === 'openai' ? 'gpt-5-mini' : 'claude-haiku-4-5',
      costMicrousd: 40,
      certainty: 'reported' as const,
      ...(ok ? {} : { error: errors.authRequired(input.providerId) }),
    };
    w.providers = w.providers.map((p) =>
      p.providerId === input.providerId
        ? providerStatusSchema.parse({ ...p, lastTest: ok ? { at: ctx.now(), ok } : { at: ctx.now(), ok, code: 'AUTH_REQUIRED' } })
        : p,
    );
    ctx.emit({ type: 'providers.changed' });
    return result;
  },
  'providers.disconnect': (w, input, ctx) => {
    const current = w.providers.find((p) => p.providerId === input.providerId);
    const next = providerStatusSchema.parse({
      providerId: input.providerId,
      displayName: current?.displayName ?? input.providerId,
      connected: false,
      storage: 'none',
      redactedLabel: null,
      lastTest: null,
    });
    w.providers = w.providers.map((p) => (p.providerId === next.providerId ? next : p));
    ctx.emit({ type: 'providers.changed' });
    return next;
  },
  'providers.catalog': (w, input) =>
    input.providerId === undefined ? w.catalog : w.catalog.filter((c) => c.providerId === input.providerId),

  // ---------- profiles ----------
  'profiles.list': (w) => w.profiles,
  'profiles.upsert': (w, input, ctx) => {
    const { profile } = input;
    const existing = profile.id === undefined ? undefined : w.profiles.find((p) => p.profile.id === profile.id);
    if (profile.id !== undefined && existing === undefined) fail(errors.notFound('profile'));
    if (existing !== undefined && input.expectedRevision !== undefined && existing.profile.revision !== input.expectedRevision) {
      fail(errors.conflict({ entity: 'profile', currentRevision: existing.profile.revision }));
    }
    if (existing !== undefined && existing.profile.name.toLowerCase() !== profile.name.toLowerCase()) {
      // Engine: renaming a profile that workflows name would orphan their steps.
      const users = workflowsUsingProfile(w, existing.profile.name);
      if (users.length > 0) fail(errors.conflict({ reason: 'profile_in_use', workflows: users }));
    }
    const known = w.catalog.some((c) => c.providerId === profile.providerId && c.modelId === profile.modelId);
    if (!known) fail(errors.modelUnsupported({ providerId: profile.providerId, modelId: profile.modelId }));
    const row = {
      profile: {
        ...profile,
        id: profile.id ?? ctx.newId('profile'),
        revision: (existing?.profile.revision ?? 0) + 1,
        updatedAt: ctx.now(),
      },
      warnings: [],
    };
    w.profiles =
      existing === undefined ? [...w.profiles, row as never] : w.profiles.map((p) => (p.profile.id === row.profile.id ? (row as never) : p));
    return row;
  },
  'profiles.delete': (w, input) => {
    const row = w.profiles.find((p) => p.profile.id === input.profileId) ?? fail(errors.notFound('profile'));
    const users = workflowsUsingProfile(w, row.profile.name);
    if (users.length > 0) fail(errors.conflict({ reason: 'profile_in_use', workflowIds: [...new Set(users.map((u) => u.id))] }));
    w.profiles = w.profiles.filter((p) => p.profile.id !== input.profileId);
    return { deleted: true as const };
  },

  // ---------- workflows ----------
  'workflows.list': (w) => w.workflows,
  'workflows.get': (w, input) => {
    const summary = w.workflows.find((x) => x.id === input.workflowId) ?? fail(errors.notFound('workflow'));
    const version = input.version ?? summary.latestValidatedVersion ?? 'draft';
    return w.workflowVersions.find((v) => v.workflowId === input.workflowId && v.version === version) ?? fail(errors.notFound('workflow version'));
  },
  'workflows.saveDraft': (w, input) => {
    const summary = w.workflows.find((x) => x.id === input.workflowId) ?? fail(errors.notFound('workflow'));
    const draft = w.workflowVersions.find((v) => v.version === 'draft');
    if ((draft?.draftRevision ?? 0) !== input.expectedDraftRevision) fail(errors.conflict({ reason: 'draft_changed' }));
    const base = draft ?? w.workflowVersions.find((v) => v.version === summary.latestValidatedVersion) ?? fail(errors.notFound('workflow version'));
    const next = applyDraftPatch(base, input.patch, (draft?.draftRevision ?? 0) + 1);
    w.workflowVersions = [...w.workflowVersions.filter((v) => v.version !== 'draft'), next];
    // A saved edit is a new draft: the engine re-validates it, so earlier validation issues no longer apply.
    w.workflowIssues = [];
    w.workflows = w.workflows.map((x) => (x.id === summary.id ? workflowSummarySchema.parse({ ...x, draftVersion: (summary.latestValidatedVersion ?? 0) + 1 }) : x));
    return next;
  },
  'workflows.validate': (w, input) => {
    if (!w.workflows.some((x) => x.id === input.workflowId)) fail(errors.notFound('workflow'));
    if (input.version !== 'draft') return { valid: true, issues: [], warnings: [] };
    if (!w.workflowVersions.some((v) => v.version === 'draft')) fail(errors.notFound('workflow draft'));
    return { valid: w.workflowIssues.length === 0, issues: w.workflowIssues, warnings: w.workflowWarnings };
  },
  'workflows.publish': (w, input) => {
    const summary = w.workflows.find((x) => x.id === input.workflowId) ?? fail(errors.notFound('workflow'));
    const draft = w.workflowVersions.find((v) => v.version === 'draft') ?? fail(errors.validationFailed([{ path: '', message: 'no draft to publish', code: 'custom' }]));
    if (w.workflowIssues.length > 0) fail(errors.validationFailed(w.workflowIssues));
    const version = (summary.latestValidatedVersion ?? 0) + 1;
    const published = workflowVersionViewSchema.parse({
      ...draft,
      version,
      status: 'validated',
      draftRevision: null,
      spec: { ...draft.spec, version },
      contentHash: sha(`c0de${String(version)}`),
    });
    w.workflowVersions = [...w.workflowVersions.filter((v) => v !== draft), published];
    w.workflows = w.workflows.map((x) => (x.id === summary.id ? workflowSummarySchema.parse({ ...x, latestValidatedVersion: version, draftVersion: null }) : x));
    return published;
  },

  // ---------- runs ----------
  'runs.preflight': (w, input) => {
    const files = input.input.kind === 'files' ? input.input.relPaths.length : 1;
    const budget = fakeBudget(w, input.limitOverrides?.budgetMicrousd);
    return {
      inputSummary: {
        files,
        bytes: files * 2_400,
        estimatedInputTokens: files * 620,
        memoryRecords: w.memory
          // Engine semantics: absent = every approved record (§4.5 default context); [] = pinned only; a list = pinned + those.
          .filter((m) => m.status === 'approved' && (input.memoryRecordIds === undefined || m.pinned || input.memoryRecordIds.includes(m.id)))
          .map((m) => ({ id: m.id, revision: m.currentRevision, type: m.type, title: m.title, pinned: m.pinned })),
        providersReceivingContext: ['anthropic', 'openai'],
      },
      firstReservation: { N: budget.N, basis: 'local_estimate' as const },
      budget,
      issues: [
        ...readinessIssues(w, input),
        // The same fact as `budget.allowed = false` (06 F14), at the run allowance field.
        ...(budget.allowed
          ? []
          : [{ path: 'limitOverrides.budgetMicrousd', code: 'budget_run', message: 'The run allowance cannot cover the first reservation.' }]),
        ...w.preflightIssues,
      ],
    };
  },
  'runs.start': (w, input, ctx) => {
    if (w.preflightIssues.length > 0) fail(errors.validationFailed(w.preflightIssues));
    // runs.start stays strict about profiles and the provider policy (06 F14); a missing credential is not an error:
    // the run pauses auth_required while queued, before any reservation or call.
    const readiness = readinessIssues(w, input);
    if (readiness.some((i) => i.code === 'unknown_profile')) fail(errors.notFound('profile'));
    if (readiness.some((i) => i.code === 'provider_not_allowed')) fail(errors.permissionDenied('provider_not_allowed'));
    const budget = fakeBudget(w, input.limitOverrides?.budgetMicrousd);
    if (!budget.allowed) fail(errors.budgetBlocked(budget as never));
    const n = w.nextId++;
    const allowance = input.limitOverrides?.budgetMicrousd ?? 3_000_000;
    const missing = firstMissingCredential(w, input);
    const built = buildRun(
      ctx.now(),
      missing === null
        ? {
            n,
            goal: input.goal,
            status: 'running',
            agoMs: 0,
            durationMs: 0,
            steps: { intake: 'succeeded', review: 'executing' },
            cost: { allowance, reserved: 540_000 },
          }
        : {
            n,
            goal: input.goal,
            status: 'paused',
            pauseReason: 'auth_required',
            neverStarted: true,
            agoMs: 0,
            durationMs: 0,
            steps: {},
            cost: { allowance },
            statusDetail: errors.authRequired(missing.providerId as never, {
              details: { stepKey: missing.stepKey },
              userMessage: READINESS_MESSAGES.missing_credential,
            }),
          },
    );
    w.runs = [built.run, ...w.runs];
    for (const s of built.steps) w.steps.set(s.step.id, s);
    w.events.set(built.run.id, built.events);
    w.ledger.set(built.run.id, built.ledger);
    for (const [id, a] of built.artifacts) w.artifacts.set(id, a);
    ctx.emit({ type: 'run.status', runId: built.run.id, status: 'running', pauseReason: null, seq: built.events.at(-1)?.seq ?? 0 });
    return { runId: built.run.id, status: built.run.status };
  },
  'runs.list': (w, input) => {
    const rows = w.runs
      .filter((r) => r.projectId === input.projectId && (input.status === undefined || input.status.includes(r.status)))
      .sort((a, b) => (input.sort === 'created_asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt))
      .map((r) => ({
        id: r.id,
        projectId: r.projectId,
        goal: r.goal,
        workflow: r.workflow,
        status: r.status,
        pauseReason: r.pauseReason,
        stepProgress: r.stepProgress,
        cost: r.cost,
        createdAt: r.createdAt,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      }));
    return page(rows, input.limit, input.cursor);
  },
  'runs.get': (w, input) => findRun(w, input.runId),
  'runs.getStep': (w, input) => {
    const detail = w.steps.get(input.stepId);
    if (detail === undefined || !findRun(w, input.runId).steps.some((s) => s.id === input.stepId)) fail(errors.notFound('step'));
    return detail;
  },
  'runs.pause': (w, input, ctx) => {
    const run = findRun(w, input.runId);
    if (!run.availableActions.includes('pause')) fail(errors.conflict({ status: run.status }));
    setRunStatus(w, ctx, run, 'paused', 'user');
    return { status: 'paused' as const, inFlight: 'none' as const };
  },
  'runs.resume': (w, input, ctx) => {
    const run = findRun(w, input.runId);
    const allowed = run.status === 'paused' || run.status === 'interrupted';
    if (!allowed) fail(errors.conflict({ status: run.status }));
    if (run.status === 'paused' && run.pauseReason === 'auth_required' && input.decision.kind === 'continue') {
      // 06 resumeContinue: still no credential for a provider the run needs → AUTH_REQUIRED, the run stays paused.
      const providerId = run.statusDetail?.details?.['providerId'];
      if (typeof providerId === 'string' && w.providers.find((p) => p.providerId === providerId)?.connected !== true) {
        fail(errors.authRequired(providerId as never));
      }
    }
    const d = input.decision;
    const limits =
      d.kind === 'raise_limits'
        ? {
            ...run.limits,
            ...(d.maxAttempts === undefined ? {} : { maxAttempts: d.maxAttempts }),
            ...(d.executionTimeoutSeconds === undefined ? {} : { executionTimeoutSeconds: d.executionTimeoutSeconds }),
          }
        : run.limits;
    const next = setRunStatus(w, ctx, run, 'running', null, { limits });
    return { status: next.status };
  },
  'runs.cancel': (w, input, ctx) => {
    const run = findRun(w, input.runId);
    if (!run.availableActions.includes('cancel') && !run.availableActions.includes('stop')) fail(errors.conflict({ status: run.status }));
    const status = run.status === 'running' ? 'cancelling' : 'cancelled';
    setRunStatus(w, ctx, run, status);
    return {
      status,
      unresolvedCharges: run.unresolvedAttempts.map((a) => ({ attemptId: a.id, liabilityMicrousd: a.cost?.microusd ?? 0 })),
    };
  },
  'runs.increaseAllowance': (w, input, ctx) => {
    const run = findRun(w, input.runId);
    if (input.newAllowanceMicrousd <= run.limits.budgetMicrousd) {
      fail(errors.validationFailed([{ path: 'newAllowanceMicrousd', message: 'must be greater than the current allowance', code: 'too_small' }]));
    }
    const cost = costSummary({
      allowance: input.newAllowanceMicrousd,
      reported: run.cost.settledReported,
      calculated: run.cost.settledCalculated,
      estimated: run.cost.settledEstimated,
      reserved: run.cost.reserved,
      unknown: run.cost.unknown,
    });
    const patch = { cost, limits: { ...run.limits, budgetMicrousd: input.newAllowanceMicrousd } };
    const nextAdmission = 540_000;
    const admitted = cost.remaining >= nextAdmission;
    const next =
      run.status === 'paused' && run.pauseReason === 'budget_run' && admitted
        ? setRunStatus(w, ctx, run, 'running', null, patch)
        : replaceRun(w, { ...run, ...patch });
    return {
      cost,
      status: next.status,
      budget: admitted
        ? null
        : { L: cost.allowance, C: cost.allowance - cost.remaining - cost.reserved - cost.unknown, R: cost.reserved, U: cost.unknown, N: nextAdmission, scope: 'run' as const, total: cost.allowance - cost.remaining + nextAdmission, allowed: false },
    };
  },
  'runs.decideUnknown': (w, input, ctx) => {
    const run = findRun(w, input.runId);
    if (!run.unresolvedAttempts.some((a) => a.id === input.attemptId)) fail(errors.conflict({ attemptId: input.attemptId }));
    const unresolvedAttempts = run.unresolvedAttempts.filter((a) => a.id !== input.attemptId);
    const steps = run.steps.map((s) => (s.state === 'unknown' ? { ...s, state: 'failed' as const } : s));
    const base = { ...run, unresolvedAttempts, steps };
    if (run.status === 'paused') return setRunStatus(w, ctx, run, 'paused', run.pauseReason, base);
    return replaceRun(w, {
      ...base,
      availableActions: allowedRunActions(run.status, run.pauseReason, {
        unknownAttempts: unresolvedAttempts.length,
        hasFailedStep: true,
        hasPatchArtifact: hasPatchArtifact(w, run.id),
      }),
    });
  },
  'runs.retryStep': (w, input, ctx) => {
    const run = findRun(w, input.runId);
    const step = run.steps.find((s) => s.id === input.stepId) ?? fail(errors.notFound('step'));
    if (!run.availableActions.includes('retry_step') && !run.availableActions.includes('choose_profile')) fail(errors.conflict({ status: run.status }));
    const retried = { ...step, id: ctx.newId('stepRun'), retryIndex: step.retryIndex + 1, state: 'ready' as const, error: null, outputArtifactId: null };
    const detail = w.steps.get(step.id);
    if (detail !== undefined) w.steps.set(retried.id, { ...detail, step: retried, attempts: [], events: [], output: null });
    return setRunStatus(w, ctx, run, 'running', null, { steps: [...run.steps, retried], statusDetail: null });
  },
  'runs.events': (w, input) => {
    const all = (w.events.get(input.runId) ?? []).filter((e) => e.seq > input.afterSeq);
    const items = all.slice(0, input.limit);
    return { items, nextCursor: items.length < all.length ? String(items.at(-1)?.seq ?? input.afterSeq) : null };
  },

  // ---------- approvals ----------
  'approvals.decide': (w, input, ctx) => {
    const run = w.runs.find((r) => r.pendingApproval?.id === input.approvalId) ?? fail(errors.notFound('approval'));
    const approval = run.pendingApproval ?? fail(errors.notFound('approval'));
    if (approval.planHash !== input.planHash || approval.contextHash !== input.contextHash) {
      fail(errors.approvalStale('plan_changed'));
    }
    const decided = { ...approval, decision: input.decision };
    const steps = run.steps.map((s) =>
      s.state === 'awaiting_approval' ? { ...s, state: input.decision === 'approved' ? ('succeeded' as const) : ('skipped' as const) } : s,
    );
    const status: RunStatus = input.decision === 'rejected' ? 'cancelled' : 'running';
    appendEvent(w, ctx, run.id, 'approval.decided', { decision: input.decision, stepKey: 'approve' });
    const next = setRunStatus(w, ctx, run, status, null, { steps });
    return { approval: decided, runStatus: next.status };
  },

  // ---------- memory ----------
  'memory.list': (w, input) =>
    w.memory
      .filter(
        (m) =>
          m.projectId === input.projectId &&
          m.status !== 'deleted' &&
          (input.status === undefined || input.status.includes(m.status)) &&
          (input.type === undefined || input.type.includes(m.type)) &&
          (input.query === undefined || `${m.title} ${m.content}`.toLowerCase().includes(input.query.toLowerCase())),
      )
      .map(toView),
  'memory.get': (w, input) => findMemory(w, input.recordId),
  'memory.create': (w, input, ctx) => {
    if (!w.projects.some((p) => p.id === input.projectId)) fail(errors.notFound('project'));
    failMemoryConflict(titleConflicts(w, input.projectId, input.title, input.scope));
    const at = ctx.now();
    const record = memoryRecordDetailSchema.parse({
      id: ctx.newId('memory'),
      projectId: input.projectId,
      type: input.type,
      status: 'approved',
      title: input.title,
      excerpt: input.content.slice(0, 140),
      scope: input.scope,
      pinned: input.pinned ?? false,
      currentRevision: 1,
      source: input.sourceFile === undefined ? { kind: 'user' } : { kind: 'file', relPath: input.sourceFile.relPath },
      createdAt: at,
      updatedAt: at,
      expiresAt: input.expiresAt ?? null,
      reviewAt: input.reviewAt ?? null,
      supersededById: null,
      stale: false,
      conflictsWith: [],
      content: input.content,
      revisions: [{ revision: 1, title: input.title, content: input.content, author: 'user', createdAt: at, sourceRefs: [] }],
      events: [{ event: 'approved', revision: 1, actor: 'user', createdAt: at }],
      usedByRuns: 0,
    });
    w.memory = [...w.memory, record];
    ctx.emit({ type: 'memory.changed', projectId: record.projectId });
    return record;
  },
  'memory.update': (w, input, ctx) => {
    const current = findMemory(w, input.recordId);
    if (current.currentRevision !== input.expectedRevision) fail(errors.conflict({ entity: 'memory', currentRevision: current.currentRevision }));
    if (input.unarchive === true && current.supersededById !== null) {
      fail(errors.conflict({ reason: 'memory_superseded', supersededById: current.supersededById, conflictsWith: [current.supersededById] }));
    }
    const titleChanged = input.title !== undefined && normTitle(input.title) !== normTitle(current.title);
    if (input.unarchive === true || titleChanged || input.scope !== undefined) {
      failMemoryConflict(titleConflicts(w, current.projectId, input.title ?? current.title, input.scope ?? current.scope, current.id));
    }
    const patch: Partial<MemoryRecordDetail> = {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      // Recording a review ("Confirm still accurate") also re-tracks the cited source hash: no longer stale.
      ...(input.reviewAt === undefined ? {} : { reviewAt: input.reviewAt, stale: false }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.unarchive === true ? { status: 'approved' as const } : {}),
    };
    return updateMemory(w, ctx, input.recordId, patch, input.unarchive === true ? 'unarchived' : 'edited');
  },
  'memory.approve': (w, input, ctx) => {
    const current = findMemory(w, input.suggestionId);
    if (current.status !== 'suggested' || current.currentRevision !== input.expectedRevision) {
      fail(errors.conflict({ entity: 'memory', currentRevision: current.currentRevision }));
    }
    // Engine: title conflicts + the proposal's live conflicts (still-approved records) → memory_conflict.
    const live = current.conflictsWith.filter((id) => w.memory.some((m) => m.id === id && m.status === 'approved'));
    failMemoryConflict([...titleConflicts(w, current.projectId, input.finalTitle ?? current.title, input.scope ?? current.scope, current.id), ...live]);
    return updateMemory(
      w,
      ctx,
      input.suggestionId,
      {
        status: 'approved',
        ...(input.finalContent === undefined ? {} : { content: input.finalContent }),
        ...(input.finalTitle === undefined ? {} : { title: input.finalTitle }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      },
      'approved',
    );
  },
  'memory.reject': (w, input, ctx) => {
    const current = findMemory(w, input.suggestionId);
    if (current.status !== 'suggested') fail(errors.conflict({ entity: 'memory' }));
    updateMemory(w, ctx, input.suggestionId, { status: 'rejected' }, 'rejected');
    return { status: 'rejected' as const };
  },
  'memory.archive': (w, input, ctx) => updateMemory(w, ctx, input.recordId, { status: 'archived' }, 'archived'),
  'memory.delete': (w, input, ctx) => {
    const current = findMemory(w, input.recordId);
    w.memory = w.memory.filter((m) => m.id !== input.recordId);
    ctx.emit({ type: 'memory.changed', projectId: current.projectId });
    return { deleted: true as const, retainedInRunSnapshots: current.usedByRuns };
  },
  'memory.resolveConflict': (w, input, ctx) => {
    // 02 rules (07 G5): at most one suggestion; the service never auto-merges.
    const [a, b] = input.recordIds.map((id) => findMemory(w, id)) as [MemoryRecordDetail, MemoryRecordDetail];
    if (a.status === 'suggested' && b.status === 'suggested') {
      fail(errors.validationFailed([{ path: 'recordIds', message: 'at most one record may be a suggestion', code: 'custom' }]));
    }
    if ([a, b].some((m) => m.status !== 'suggested' && m.status !== 'approved')) fail(errors.conflict({ entity: 'memory' }));
    /** Takes one input record out of use: a suggestion is rejected, an approved record is archived as superseded. */
    const retire = (m: MemoryRecordDetail, by: MemoryRecordDetail['id']) =>
      m.status === 'suggested'
        ? updateMemory(w, ctx, m.id, { status: 'rejected', conflictsWith: [] }, 'rejected')
        : updateMemory(w, ctx, m.id, { status: 'archived', supersededById: by, conflictsWith: [] }, 'conflict_resolved');
    const r = input.resolution;
    if ('keep' in r) {
      const drop = r.keep === a.id ? b : a;
      updateMemory(w, ctx, r.keep, { status: 'approved', conflictsWith: [] }, 'conflict_resolved');
      retire(drop, r.keep);
      return input.recordIds.map((id) => toView(w.memory.find((m) => m.id === id) ?? findMemory(w, id)));
    }
    if ('rewrite' in r) {
      const at = ctx.now();
      const created = memoryRecordDetailSchema.parse({
        id: ctx.newId('memory'),
        projectId: a.projectId,
        type: (a.status === 'approved' ? a : b).type,
        status: 'approved',
        title: r.rewrite.title,
        excerpt: r.rewrite.content.slice(0, 140),
        scope: r.rewrite.scope,
        pinned: r.rewrite.pinned ?? false,
        currentRevision: 1,
        source: { kind: 'user' },
        createdAt: at,
        updatedAt: at,
        expiresAt: null,
        reviewAt: null,
        supersededById: null,
        stale: false,
        conflictsWith: [],
        content: r.rewrite.content,
        revisions: [{ revision: 1, title: r.rewrite.title, content: r.rewrite.content, author: 'user', createdAt: at, sourceRefs: [] }],
        events: [{ event: 'conflict_resolved', revision: 1, actor: 'user', createdAt: at }],
        usedByRuns: 0,
      });
      w.memory = [...w.memory, created];
      retire(a, created.id);
      retire(b, created.id);
      return [toView(created), ...input.recordIds.map((id) => toView(w.memory.find((m) => m.id === id) ?? findMemory(w, id)))];
    }
    const [x, y] = r.keepBothWithScopes;
    const roles = (s: typeof x.scope) => (s.roles === 'all' ? null : new Set(s.roles));
    const rx = roles(x.scope);
    const ry = roles(y.scope);
    if (rx === null || ry === null || [...rx].some((role) => ry.has(role))) {
      fail(errors.validationFailed([{ path: 'resolution.keepBothWithScopes', message: 'the two scopes must not share a role', code: 'custom' }]));
    }
    for (const entry of r.keepBothWithScopes) {
      updateMemory(w, ctx, entry.recordId, { status: 'approved', scope: entry.scope, conflictsWith: [] }, 'conflict_resolved');
    }
    return input.recordIds.map((id) => toView(findMemory(w, id)));
  },
  'memory.purgeProjectHistory': (w, input) => {
    if (!w.projects.some((p) => p.id === input.projectId)) fail(errors.notFound('project'));
    const runs = w.runs.filter((r) => r.projectId === input.projectId);
    // 03 C8: raw responses + context manifests of the project's runs; `purgeFailures` of them stay for the next sweep.
    const files = runs.reduce((sum, r) => sum + r.steps.filter((s) => s.profileName !== null && s.state !== 'pending').length * 2, 0);
    const failed = Math.min(w.purgeFailures, files);
    return { purgedSnapshots: runs.length, purgedArtifacts: files - failed, failed };
  },

  // ---------- artifacts ----------
  'artifacts.get': (w, input) => w.artifacts.get(input.artifactId) ?? fail(errors.notFound('artifact')),
  'artifacts.importDiff': (w, _i, ctx) =>
    w.dialogCancels.has('artifacts.importDiff')
      ? null
      : {
          artifactId: ctx.newId('artifact'),
          files: ['src/routes/users.ts', 'src/validation/schemas.ts'],
          parseWarnings: [...w.importDiffWarnings],
        },
  'artifacts.export': (w, input) => {
    findRun(w, input.runId);
    if (w.exportFails) fail(errors.artifactWriteFailed());
    if (w.dialogCancels.has('artifacts.export')) return { exported: false, displayPaths: [] };
    const names = input.what === 'both' ? ['report.md', 'patch.diff'] : [input.what === 'report' ? 'report.md' : 'patch.diff'];
    return { exported: true, displayPaths: names.map((n) => `~/Downloads/${n}`) };
  },

  // ---------- ledger ----------
  'ledger.runSummary': (w, input) => {
    const run = findRun(w, input.runId);
    return {
      ...run.cost,
      byStep: run.steps
        .filter((s) => s.profileName !== null && s.state !== 'pending')
        .map((s) => ({ stepKey: s.stepKey, cost: costSummary({ allowance: run.cost.allowance, reported: s.state === 'succeeded' ? 160_000 : 0 }) })),
    };
  },
  'ledger.projectSummary': (w, input) => {
    const project = projectDetail(w, input.projectId);
    const runs = w.runs.filter((r) => r.projectId === input.projectId);
    return {
      trackedMicrousd: project.stats.trackedMonthMicrousd,
      reservedMicrousd: runs.reduce((sum, r) => sum + r.cost.reserved, 0),
      unknownMicrousd: runs.reduce((sum, r) => sum + r.cost.unknown, 0),
      allowance: project.monthlyAllowanceMicrousd,
      label: 'tracked by Relay' as const,
    };
  },
  'ledger.entries': (w, input) => page(w.ledger.get(input.runId) ?? [], input.limit, input.cursor),
  'ledger.export': (w, input) => {
    if ('runId' in input) findRun(w, input.runId);
    if (w.dialogCancels.has('ledger.export')) return { exported: false };
    return { exported: true, displayPath: '~/Downloads/relay-ledger.csv' };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Bridge

/** One recorded `invoke` (tests assert on these). */
export interface FakeCall {
  readonly channel: Channel;
  readonly input: unknown;
}

/** The fake bridge plus test controls. */
export interface FakeBridge extends RelayBridge {
  readonly world: FakeWorld;
  readonly calls: FakeCall[];
  /** Calls made on `channel`, in order. */
  callsTo(channel: Channel): FakeCall[];
  /** Pushes an event to every subscriber (e.g. a `run.event` with a seq gap). */
  emit(e: PushEvent): void;
  /** The next call on `channel` fails with `error` (once). */
  failNext(channel: Channel, error: AppError): void;
  /** Holds calls on `channel` until the returned release function is called (pending-state tests). */
  hold(channel: Channel): () => void;
}

export interface FakeBridgeOptions {
  /** Clock for created entities. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Artificial latency per call in ms (dev realism). Defaults to 0. */
  readonly latencyMs?: number;
}

/** Keys of {@link HANDLERS} (every OPERATIONS key). Exported for the coverage test. */
export const FAKE_HANDLED_OPERATIONS: readonly OperationKey[] = Object.keys(HANDLERS) as OperationKey[];

/** Creates a fake bridge for a scenario name, or around a prepared world. */
export function createFakeBridge(scenario: FakeScenarioName | FakeWorld = DEFAULT_FAKE_SCENARIO, opts: FakeBridgeOptions = {}): FakeBridge {
  const now = opts.now ?? Date.now;
  const world = typeof scenario === 'string' ? buildScenario(scenario, now()) : scenario;
  world.now = now;
  const listeners = new Set<(e: PushEvent) => void>();
  const failures = new Map<Channel, AppError>();
  const holds = new Map<Channel, Promise<void>>();
  const calls: FakeCall[] = [];
  const emit = (e: PushEvent) => {
    for (const l of [...listeners]) l(e);
  };
  const ctx: HandlerContext = {
    now,
    emit,
    newId: <P extends IdPrefixKey>(p: P) => sid(p, world.nextId++) as IdOf<P>,
  };

  async function invoke<C extends Channel>(channel: C, input: InputOf<C>): Promise<IpcResult<C>> {
    calls.push({ channel, input });
    const op = getOperation(channel);
    if (op === undefined) return { ok: false, error: errors.permissionDenied('outside_root') };
    await (holds.get(channel) ?? Promise.resolve());
    if ((opts.latencyMs ?? 0) > 0) await new Promise((r) => setTimeout(r, opts.latencyMs));
    const injected = failures.get(channel);
    if (injected !== undefined) {
      failures.delete(channel);
      return { ok: false, error: injected };
    }
    const parsed = op.input.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: errors.validationFailed(toValidationIssues(parsed.error.issues)) };
    }
    const idemKey = op.idempotent ? `${channel}:${String((parsed.data as { idempotencyKey?: unknown }).idempotencyKey)}` : null;
    if (idemKey !== null && world.idempotency.has(idemKey)) {
      return { ok: true, data: world.idempotency.get(idemKey) } as IpcResult<C>;
    }
    const key = channel.slice(CHANNEL_PREFIX.length) as OperationKey;
    if (world.notImplemented.has(key)) {
      // Test hook: answers like a runner channel that is stubbed (engine services.ts `notImplemented`), so the
      // generic error path for INTERNAL `not_implemented` stays covered.
      return {
        ok: false,
        error: appError('INTERNAL', {
          userMessage: 'This feature is not available in this build yet.',
          details: { reason: 'not_implemented', channel },
        }),
      };
    }
    const handler = HANDLERS[key] as (w: FakeWorld, i: unknown, c: HandlerContext) => unknown;
    let raw: unknown;
    try {
      raw = handler(world, parsed.data, ctx);
    } catch (e) {
      if (e instanceof FakeFailure) return { ok: false, error: e.error };
      throw e;
    }
    // Dev assertion (10 J3): the fake never serves a shape the output schema rejects.
    const out = op.output.safeParse(raw);
    if (!out.success) {
      throw new Error(`fake bridge: invalid ${channel} output: ${JSON.stringify(out.error.issues.slice(0, 3))}`);
    }
    if (idemKey !== null) world.idempotency.set(idemKey, out.data);
    return { ok: true, data: out.data } as IpcResult<C>;
  }

  return {
    world,
    calls,
    invoke,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    callsTo: (channel) => calls.filter((c) => c.channel === channel),
    emit,
    failNext(channel, error) {
      failures.set(channel, error);
    },
    hold(channel) {
      let release: () => void = () => undefined;
      holds.set(
        channel,
        new Promise<void>((resolve) => {
          release = () => {
            holds.delete(channel);
            resolve();
          };
        }),
      );
      return () => {
        release();
      };
    },
  };
}

/** Scenario from `?fake=<name>` (search or hash query); defaults to {@link DEFAULT_FAKE_SCENARIO}. */
export function fakeScenarioFromUrl(location: Pick<Location, 'search' | 'hash'> = window.location): FakeScenarioName {
  const fromSearch = new URLSearchParams(location.search).get('fake');
  const hashQuery = location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?')) : '';
  const fromHash = new URLSearchParams(hashQuery).get('fake');
  const name = fromSearch ?? fromHash;
  return isFakeScenarioName(name) ? name : DEFAULT_FAKE_SCENARIO;
}

/** Test helper: a scenario's seeded project id. */
export const FAKE_PROJECT_ID = PROJECT_ID;
/** Test helper: the seeded workflow id. */
export const FAKE_WORKFLOW_ID = WORKFLOW_ID;
