// Fake bridge (10 J3): implements EVERY channel in `OPERATIONS` against an in-memory world, validates inputs with the
// contracts schemas, and asserts every output parses with the output schema. Dev (`pnpm dev:renderer?fake=<name>`)
// and tests only: main.tsx imports it dynamically behind `import.meta.env.DEV || MODE === 'test'`, so production
// bundles never contain it.
import {
  appSettingsSchema,
  errors,
  getOperation,
  memoryRecordDetailSchema,
  memoryRecordViewSchema,
  projectSchema,
  providerStatusSchema,
  runDetailSchema,
  runEventSchema,
  toValidationIssues,
  workflowSummarySchema,
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
} from '@relay/contracts';
import type { RelayBridge } from './bridge';
import { allowedRunActions } from './fake-scenarios/allowed-actions';
import { buildScenario, DEFAULT_FAKE_SCENARIO, isFakeScenarioName } from './fake-scenarios/scenarios';
import type { FakeScenarioName } from './fake-scenarios/scenarios';
import { buildRun, buildWorkflowVersion, costSummary, PROJECT_ID, sid, WORKFLOW_ID } from './fake-scenarios/world';
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
  'app.exportDiagnostics': () => ({ exported: true, displayPath: '~/Downloads/relay-diagnostics.zip' }),
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
  'projects.previewFiles': (w) => w.preview,
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
    const next = projectSchema.parse({ ...project, archivedAt: ctx.now(), updatedAt: ctx.now() });
    w.projects = w.projects.map((p) => (p.id === next.id ? next : p));
    return next;
  },
  'projects.export': (w, input) => {
    const project = w.projects.find((p) => p.id === input.projectId) ?? fail(errors.notFound('project'));
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
      fail(errors.conflict({ entity: 'profile' }));
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
    if (!w.profiles.some((p) => p.profile.id === input.profileId)) fail(errors.notFound('profile'));
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
    if ((draft?.draftRevision ?? 0) !== input.expectedDraftRevision) fail(errors.conflict({ entity: 'workflow draft' }));
    const next = buildWorkflowVersion('draft', (draft?.draftRevision ?? 0) + 1);
    w.workflowVersions = [...w.workflowVersions.filter((v) => v.version !== 'draft'), next];
    w.workflows = w.workflows.map((x) => (x.id === summary.id ? workflowSummarySchema.parse({ ...x, draftVersion: (summary.latestValidatedVersion ?? 0) + 1 }) : x));
    return next;
  },
  'workflows.validate': (w, input) => {
    if (!w.workflows.some((x) => x.id === input.workflowId)) fail(errors.notFound('workflow'));
    return { valid: true, issues: [], warnings: [] };
  },
  'workflows.publish': (w, input) => {
    const summary = w.workflows.find((x) => x.id === input.workflowId) ?? fail(errors.notFound('workflow'));
    const draft = w.workflowVersions.find((v) => v.version === 'draft') ?? fail(errors.validationFailed([{ path: '', message: 'no draft to publish', code: 'custom' }]));
    const version = (summary.latestValidatedVersion ?? 0) + 1;
    const published = buildWorkflowVersion(version, null);
    w.workflowVersions = [...w.workflowVersions.filter((v) => v !== draft), published];
    w.workflows = w.workflows.map((x) => (x.id === summary.id ? workflowSummarySchema.parse({ ...x, latestValidatedVersion: version, draftVersion: null }) : x));
    return published;
  },

  // ---------- runs ----------
  'runs.preflight': (w, input) => {
    const files = input.input.kind === 'files' ? input.input.relPaths.length : 1;
    const N = w.preflightBlocked ? 1_500_000 : 540_000;
    const C = w.preflightBlocked ? 1_200_000 : 0;
    const R = w.preflightBlocked ? 400_000 : 0;
    const L = input.limitOverrides?.budgetMicrousd ?? 3_000_000;
    const total = C + R + N;
    return {
      inputSummary: {
        files,
        bytes: files * 2_400,
        estimatedInputTokens: files * 620,
        memoryRecords: w.memory
          .filter((m) => m.status === 'approved' && (m.pinned || (input.memoryRecordIds ?? []).includes(m.id)))
          .map((m) => ({ id: m.id, revision: m.currentRevision, type: m.type, title: m.title, pinned: m.pinned })),
        providersReceivingContext: ['anthropic', 'openai'],
      },
      firstReservation: { N, basis: 'local_estimate' as const },
      budget: { L, C, R, U: 0, N, scope: 'run' as const, total, allowed: total <= L },
      issues: [],
    };
  },
  'runs.start': (w, input, ctx) => {
    if (w.preflightBlocked) {
      fail(errors.budgetBlocked({ L: 3_000_000, C: 1_200_000, R: 400_000, U: 0, N: 1_500_000, scope: 'run', total: 3_100_000, allowed: false } as never));
    }
    const n = w.nextId++;
    const built = buildRun(ctx.now(), {
      n,
      goal: input.goal,
      status: 'running',
      agoMs: 0,
      durationMs: 0,
      steps: { intake: 'succeeded', review: 'executing' },
      cost: { allowance: input.limitOverrides?.budgetMicrousd ?? 3_000_000, reserved: 540_000 },
    });
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
    const patch: Partial<MemoryRecordDetail> = {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.reviewAt === undefined ? {} : { reviewAt: input.reviewAt }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.unarchive === true ? { status: 'approved' as const } : {}),
    };
    return updateMemory(w, ctx, input.recordId, patch, input.unarchive === true ? 'unarchived' : 'edited');
  },
  'memory.approve': (w, input, ctx) => {
    const current = findMemory(w, input.suggestionId);
    if (current.status !== 'suggested' || current.currentRevision !== input.expectedRevision) fail(errors.conflict({ entity: 'memory' }));
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
    const [a, b] = input.recordIds.map((id) => findMemory(w, id)) as [MemoryRecordDetail, MemoryRecordDetail];
    const r = input.resolution;
    if ('keep' in r) {
      const drop = r.keep === a.id ? b : a;
      updateMemory(w, ctx, drop.id, { status: 'archived', supersededById: r.keep, conflictsWith: [] }, 'conflict_resolved');
      updateMemory(w, ctx, r.keep, { status: 'approved', conflictsWith: [] }, 'conflict_resolved');
    } else if ('rewrite' in r) {
      const target = a.status === 'approved' ? a : b;
      const other = target === a ? b : a;
      updateMemory(w, ctx, target.id, { title: r.rewrite.title, content: r.rewrite.content, scope: r.rewrite.scope, conflictsWith: [] }, 'conflict_resolved');
      updateMemory(w, ctx, other.id, { status: 'archived', supersededById: target.id, conflictsWith: [] }, 'conflict_resolved');
    } else {
      for (const entry of r.keepBothWithScopes) {
        updateMemory(w, ctx, entry.recordId, { status: 'approved', scope: entry.scope, conflictsWith: [] }, 'conflict_resolved');
      }
    }
    return input.recordIds.map((id) => toView(findMemory(w, id)));
  },
  'memory.purgeProjectHistory': (w, input) => {
    if (!w.projects.some((p) => p.id === input.projectId)) fail(errors.notFound('project'));
    return { purgedSnapshots: w.runs.filter((r) => r.projectId === input.projectId).length };
  },

  // ---------- artifacts ----------
  'artifacts.get': (w, input) => w.artifacts.get(input.artifactId) ?? fail(errors.notFound('artifact')),
  'artifacts.importDiff': (_w, _i, ctx) => ({
    artifactId: ctx.newId('artifact'),
    files: ['src/routes/users.ts', 'src/validation/schemas.ts'],
    parseWarnings: [],
  }),
  'artifacts.export': (w, input) => {
    findRun(w, input.runId);
    if (w.exportFails) fail(errors.artifactWriteFailed());
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
