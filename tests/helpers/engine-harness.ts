/**
 * Integration harness (11 §K3): the REAL storage (temp SQLite), tools (temp dirs), engine, and templates plus the FAKE
 * provider, composed exactly like the desktop runner through `createRuntime` from `@relay/engine` (06 F16). The fake
 * call log is a JSONL file inside `userDataDir`, so it survives restarts and crash children.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { microusd, ok } from '@relay/contracts';
import type {
  AttemptId,
  Clock,
  IpcResult,
  ModelCapabilities,
  ProfileId,
  ProjectId,
  ProviderId,
  RecoveryDecision,
  RunId,
  RunStatus,
  RunnerChannel,
  RunnerInputOf,
  StepKey,
  WorkflowId,
  WorkflowLimits,
} from '@relay/contracts';
import { createRuntime } from '@relay/engine';
import type { CredentialResolver, EngineApi, EngineTestHooks, Logger, Runtime, Timers } from '@relay/engine';
import { createJsonlCallLog } from '@relay/providers';
import type { FakeCall, FakeCallLog, FakeScenario, ProviderRegistry } from '@relay/providers';
import type { AttemptRow, Db, RunRow, StepRow } from '@relay/storage';
import type { ArtifactStore } from '@relay/tools';
import type { ManualClock } from './manual-clock.js';
import { copyFixture, makeTempDir } from './temp-dirs.js';

/** Default test API key (fake mode ignores it; the redaction suite passes its own). */
export const TEST_API_KEY = 'test-key-0000000000000000';

/** The sample-api files the D-owned fake fixtures cite (plus the hostile note and the router used by K2 variants). */
export const DEFAULT_REL_PATHS: readonly string[] = [
  'src/handlers/user.ts',
  'src/handlers/orders.ts',
  'src/lib/format.ts',
  'src/lib/validate.ts',
  'src/errors.ts',
  'src/handlers/health.ts',
];

/** Terminal run statuses. */
export const TERMINAL: readonly RunStatus[] = ['completed', 'incomplete', 'failed', 'cancelled'];

/** Workflow limit overrides with a plain-number budget (branded to Microusd by the harness). */
export type LimitOverrides = Omit<WorkflowLimits, 'budgetMicrousd'> & { readonly budgetMicrousd?: number };

function brandLimits(l: LimitOverrides): WorkflowLimits {
  const { budgetMicrousd, ...rest } = l;
  return budgetMicrousd === undefined ? rest : { ...rest, budgetMicrousd: microusd(budgetMicrousd) };
}

export interface HarnessOptions {
  /** FAKE_SCENARIOS key or an inline scenario (default `happy-path`). */
  readonly scenario?: string | FakeScenario;
  /** K2 variants keyed by fixture name. */
  readonly extraFixtures?: Record<string, unknown>;
  readonly fakeCapabilityOverrides?: Partial<ModelCapabilities>;
  /** Default `limitOverrides` of every `startRun`. */
  readonly limits?: LimitOverrides;
  /** Manual time (injected clock + timers only, never global fake timers). */
  readonly clock?: ManualClock;
  readonly apiKey?: string;
  readonly credentials?: CredentialResolver;
  readonly hooks?: EngineTestHooks;
  readonly allowedProviderIds?: readonly ProviderId[];
  readonly monthlyAllowanceMicrousd?: number | null;
  /** Reuse an existing userData dir (restart). */
  readonly userDataDir?: string;
  /** Reuse an existing project root (default: a fresh copy of sample-api). */
  readonly projectRoot?: string;
  /** Start the engine loop (default true). */
  readonly start?: boolean;
  /** Loop idle wait (default 25 ms: commands also wake it). */
  readonly idleMs?: number;
}

export interface StartRunOptions {
  readonly relPaths?: readonly string[];
  readonly goal?: string;
  readonly key?: string;
  readonly limits?: LimitOverrides;
  readonly profileOverrides?: Record<string, ProfileId>;
  readonly projectId?: ProjectId;
}

type Predicate = (run: RunRow) => boolean;

export interface Harness {
  readonly runtime: Runtime;
  readonly engine: EngineApi;
  readonly db: Db;
  readonly projectFs: Runtime['projectFs'];
  readonly artifacts: ArtifactStore;
  readonly providers: ProviderRegistry;
  readonly callLog: FakeCallLog;
  readonly userDataDir: string;
  readonly dbPath: string;
  readonly projectRoot: string;
  readonly projectId: ProjectId;
  readonly workflowId: WorkflowId;
  readonly logger: Logger & { readonly lines: string[] };
  readonly clock: Clock;
  /** Typed IPC call into the runner. */
  call<C extends RunnerChannel>(channel: C, input: RunnerInputOf<C>): Promise<IpcResult<C>>;
  /** `runs.start` → runId (throws on error). */
  startRun(o?: StartRunOptions): Promise<RunId>;
  /** `runs.start` raw result. */
  startRunRaw(o?: StartRunOptions): Promise<IpcResult<'relay/v1/runs.start'>>;
  /** Waits (real time) until the run is in `status` (or one of them) or `predicate(run)` holds. */
  waitFor(runId: RunId, target: RunStatus | readonly RunStatus[] | Predicate, timeoutMs?: number): Promise<RunRow>;
  /** Waits (real time) until `cond()` holds. */
  waitUntil(cond: () => boolean, timeoutMs?: number, label?: string): Promise<void>;
  /** Approves the pending approval (echoing the shown hashes). */
  approve(runId: RunId, key?: string): Promise<IpcResult<'relay/v1/approvals.decide'>>;
  decideUnknown(runId: RunId, attemptId: AttemptId, decision: 'retry_acknowledging_charge' | 'mark_failed_keep_liability' | 'accept_estimated_charge', key?: string): Promise<IpcResult<'relay/v1/runs.decideUnknown'>>;
  retryStep(runId: RunId, stepKey: string, o?: { profileId?: ProfileId; key?: string }): Promise<IpcResult<'relay/v1/runs.retryStep'>>;
  resume(runId: RunId, decision: RecoveryDecision, key?: string): Promise<IpcResult<'relay/v1/runs.resume'>>;
  /** The step key's rows in (revision, retry) order. */
  steps(runId: RunId, stepKey?: string): StepRow[];
  /** The step key's attempts in dispatch order. */
  attempts(runId: RunId, stepKey?: string): AttemptRow[];
  /** Fake generate calls, optionally filtered. */
  calls(filter?: { runId?: string; stepKey?: string; purpose?: string; providerId?: string }): FakeCall[];
  /** Stops the engine and closes the DB (idempotent). */
  dispose(): Promise<void>;
}

let seq = 0;
const key = (p: string): string => {
  seq += 1;
  return `${p}-${String(process.pid)}-${String(seq).padStart(6, '0')}`;
};

/** Real-time sleep for polling (tests only). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

/** A JSONL file logger inside userData (so the redaction scan covers logs) that also keeps the lines in memory. */
export function fileLogger(path: string): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  mkdirSync(join(path, '..'), { recursive: true });
  const at = (level: string) => (event: string, fields?: Readonly<Record<string, unknown>>) => {
    const line = JSON.stringify({ ts: Date.now(), level, event, ...fields });
    lines.push(line);
    appendFileSync(path, `${line}\n`, 'utf8');
  };
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

function unwrap<T>(res: { ok: true; data: T } | { ok: false; error: { code: string; details?: unknown } }, what: string): T {
  if (!res.ok) throw new Error(`${what}: ${res.error.code} ${JSON.stringify(res.error.details ?? null)}`);
  return res.data;
}

/** Creates (and by default starts) a harness. Always `dispose()` it in afterEach. */
export async function createHarness(o: HarnessOptions = {}): Promise<Harness> {
  const userDataDir = o.userDataDir ?? (await makeTempDir('relay-ud-'));
  const projectRoot = o.projectRoot ?? (await copyFixture('sample-api'));
  const callLog = createJsonlCallLog(join(userDataDir, 'fake-call-log.jsonl'));
  const logger = fileLogger(join(userDataDir, 'logs', 'harness.jsonl'));
  const apiKey = o.apiKey ?? TEST_API_KEY;
  const credentials: CredentialResolver = o.credentials ?? { resolve: () => Promise.resolve(ok(apiKey)) };
  const timers: Timers | undefined = o.clock?.timers;
  const runtime = await createRuntime({
    userDataDir,
    providerMode: 'fake',
    fakeScenario: o.scenario ?? 'happy-path',
    ...(o.extraFixtures === undefined ? {} : { fakeExtraFixtures: o.extraFixtures }),
    ...(o.fakeCapabilityOverrides === undefined ? {} : { fakeCapabilityOverrides: o.fakeCapabilityOverrides }),
    credentials,
    callLog,
    logger,
    ...(o.clock === undefined ? {} : { clock: o.clock.clock }),
    ...(timers === undefined ? {} : { timers }),
    ...(o.hooks === undefined ? {} : { hooks: o.hooks }),
    idleMs: o.idleMs ?? 25,
  });
  const { engine, db } = runtime;
  const call = <C extends RunnerChannel>(channel: C, input: RunnerInputOf<C>): Promise<IpcResult<C>> => engine.handle(channel, input);

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await runtime.dispose();
  };

  try {
    const existing = db.repos.projects.list({ includeArchived: true }).find((p) => db.repos.projects.getWithRoot(p.id).rootRealpath === projectRoot);
    const projectId = existing?.id ?? unwrap(await call('relay/v1/projects.createFromRoot', {
      idempotencyKey: key('harness-project'), rootRealpath: projectRoot, rootDisplayPath: '~/sample-api', name: 'Sample API',
      exclusions: [], allowedProviderIds: [...(o.allowedProviderIds ?? ['anthropic', 'openai', 'gemini', 'fake'])],
      monthlyAllowanceMicrousd: o.monthlyAllowanceMicrousd ?? null, isDemo: false,
    }), 'projects.createFromRoot').id;
    const workflow = db.repos.workflows.listWorkflows()[0];
    if (workflow === undefined) throw new Error('harness: no seeded workflow');
    if (o.start ?? true) await engine.start();

    const startRunRaw = (s: StartRunOptions = {}): Promise<IpcResult<'relay/v1/runs.start'>> => {
      const limits = s.limits ?? o.limits;
      return call('relay/v1/runs.start', {
        idempotencyKey: s.key ?? key('harness-run'),
        projectId: s.projectId ?? projectId, workflowId: workflow.id, workflowVersion: 1,
        goal: s.goal ?? 'Fix the defects in the handlers.',
        input: { kind: 'files', relPaths: [...(s.relPaths ?? DEFAULT_REL_PATHS)] },
        ...(limits === undefined ? {} : { limitOverrides: brandLimits(limits) }),
        ...(s.profileOverrides === undefined ? {} : { profileOverrides: s.profileOverrides }),
      });
    };

    const waitUntil = async (cond: () => boolean, timeoutMs = 15_000, label = 'condition'): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!cond()) {
        if (Date.now() > deadline) throw new Error(`waitUntil: ${label} not met within ${String(timeoutMs)} ms`);
        await sleep(5);
      }
    };

    const steps = (runId: RunId, stepKey?: string): StepRow[] =>
      db.repos.steps.listForRun(runId).filter((s) => stepKey === undefined || s.stepKey === (stepKey as StepKey))
        .slice().sort((a, b) => a.ordinal - b.ordinal || a.revisionIndex - b.revisionIndex || a.retryIndex - b.retryIndex);

    const h: Harness = {
      runtime, engine, db, projectFs: runtime.projectFs, artifacts: runtime.artifacts, providers: runtime.providers, callLog,
      userDataDir, dbPath: join(userDataDir, 'relay.sqlite'), projectRoot, projectId, workflowId: workflow.id, logger,
      clock: o.clock?.clock ?? { now: () => Date.now() as ReturnType<Clock['now']> },
      call,
      startRunRaw,
      async startRun(s) {
        return unwrap(await startRunRaw(s), 'runs.start').runId;
      },
      async waitFor(runId, target, timeoutMs = 15_000) {
        const pred: Predicate = typeof target === 'function' ? target : (run) => (typeof target === 'string' ? [target] : target).includes(run.status);
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const run = db.repos.runs.get(runId);
          if (pred(run)) return run;
          if (Date.now() > deadline) {
            throw new Error(`waitFor: run ${runId} is ${run.status}${run.pauseReason === null ? '' : `(${run.pauseReason})`}, wanted ${typeof target === 'function' ? 'predicate' : String(target)}; detail=${JSON.stringify(run.statusDetail)}`);
          }
          await sleep(5);
        }
      },
      waitUntil,
      async approve(runId, k) {
        const detail = unwrap(await call('relay/v1/runs.get', { runId }), 'runs.get');
        const a = detail.pendingApproval;
        if (a === null) throw new Error(`approve: run ${runId} has no pending approval (status ${detail.status})`);
        return call('relay/v1/approvals.decide', { idempotencyKey: k ?? key('approve'), approvalId: a.id, planHash: a.planHash, contextHash: a.contextHash, decision: 'approved' });
      },
      decideUnknown(runId, attemptId, decision, k) {
        return call('relay/v1/runs.decideUnknown', { idempotencyKey: k ?? key('decide-unknown'), runId, attemptId, decision });
      },
      retryStep(runId, stepKey, r = {}) {
        const row = steps(runId, stepKey).at(-1);
        if (row === undefined) throw new Error(`retryStep: no ${stepKey} row`);
        return call('relay/v1/runs.retryStep', { idempotencyKey: r.key ?? key('retry-step'), runId, stepId: row.id, ...(r.profileId === undefined ? {} : { profileId: r.profileId }) });
      },
      resume(runId, decision, k) {
        return call('relay/v1/runs.resume', { idempotencyKey: k ?? key('resume'), runId, decision });
      },
      steps,
      attempts(runId, stepKey) {
        return steps(runId, stepKey).flatMap((s) => [...db.repos.attempts.listForStep(s.id)].sort((a, b) => a.seq - b.seq));
      },
      calls(f = {}) {
        return callLog.entries().filter((c) => (f.runId === undefined || c.runId === f.runId) && (f.stepKey === undefined || c.stepKey === f.stepKey)
          && (f.purpose === undefined || c.purpose === f.purpose) && (f.providerId === undefined || c.providerId === f.providerId));
      },
      dispose,
    };
    return h;
  } catch (e) {
    await dispose();
    throw e;
  }
}
