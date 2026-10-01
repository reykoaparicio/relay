// Engine test harness (06 unit tests): a migrated temp DB, a temp userData dir, a temp project root, the fake
// provider registry, the real artifact store + confined fs, the context assembler and memory service, and one shared EngineCtx.
// Never exported from the barrel (R2-2).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdGen, ok } from '@relay/contracts';
import type { IdGen, MemoryId, ProjectId, PushEvent, RunId, RunStatus } from '@relay/contracts';
import { connectionTestRequest, createMemoryCallLog, createProviderRegistry, loadCatalogEntries, supportsRequestLookupFor } from '@relay/providers';
import type { FakeCallLog, FakeScenario, ProviderRegistry } from '@relay/providers';
import { createMaintenance, openTestDb } from '@relay/storage';
import type { TestDb } from '@relay/storage';
import { createTemplateRegistry } from '@relay/templates';
import { createArtifactStore } from '@relay/tools';
import { createContextAssembler } from '../context.js';
import { createMemoryService } from '../memory.js';
import type { ContextAssemblerPort, CredentialResolver, EngineApi, EngineCtx, EngineTestHooks, Logger } from '../ports.js';
import { createEngineContext, createEngineFromContext } from '../runner.js';
import { createBackupPort, createExportPort, createProjectFs } from '../runtime.js';
import { seedDatabase } from '../seed.js';
import { createManualClock, createManualTimers } from './manual-timers.js';
import type { ManualClock, ManualTimers } from './manual-timers.js';

/** The sample-api fixture project (tests/fixtures/sample-api): the fake provider's fixtures reference its files. */
const SAMPLE_API_DIR = fileURLToPath(new URL('../../../../tests/fixtures/sample-api/', import.meta.url));

/** The sample-api files the fake fixtures cite (F8 checks refs, line ranges, and that the patch applies). */
export const SAMPLE_FILES: Readonly<Record<string, string>> = Object.fromEntries(
  ['src/handlers/user.ts', 'src/handlers/orders.ts', 'src/lib/format.ts', 'src/lib/validate.ts', 'src/errors.ts', 'src/handlers/health.ts']
    .map((rel) => [rel, readFileSync(join(SAMPLE_API_DIR, rel), 'utf8')]),
);

/** A logger that records entries (tests assert on it) and prints nothing. */
export function memoryLogger(): Logger & { entries: { level: string; event: string; fields?: Readonly<Record<string, unknown>> }[] } {
  const entries: { level: string; event: string; fields?: Readonly<Record<string, unknown>> }[] = [];
  const at = (level: string) => (event: string, fields?: Readonly<Record<string, unknown>>) => {
    entries.push(fields === undefined ? { level, event } : { level, event, fields });
  };
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** Options of {@link createHarness}. */
export interface HarnessOptions {
  readonly scenario?: string | FakeScenario;
  readonly files?: Readonly<Record<string, string>>;
  readonly hooks?: EngineTestHooks;
  readonly credentials?: CredentialResolver;
  readonly allowedProviderIds?: readonly ('anthropic' | 'openai' | 'gemini' | 'fake')[];
  readonly monthlyAllowanceMicrousd?: number | null;
  readonly context?: (base: ContextAssemblerPort) => ContextAssemblerPort;
  readonly providers?: (base: ProviderRegistry) => ProviderRegistry;
  /** Extra fake success fixtures keyed by name (scenario steps reference them by `fixture`). */
  readonly extraFixtures?: Readonly<Record<string, unknown>>;
}

/** A composed test engine. */
export interface Harness {
  readonly ctx: EngineCtx;
  readonly engine: EngineApi;
  readonly db: TestDb;
  readonly clock: ManualClock;
  readonly timers: ManualTimers;
  readonly ids: IdGen;
  readonly logger: ReturnType<typeof memoryLogger>;
  readonly events: PushEvent[];
  readonly callLog: FakeCallLog;
  readonly userDataDir: string;
  readonly projectRoot: string;
  readonly projectId: ProjectId;
  /** Starts a run over `relPaths` (default: every sample file) through the runner handler. */
  startRun(o?: { relPaths?: readonly string[]; key?: string; goal?: string; budgetMicrousd?: number; memoryRecordIds?: readonly MemoryId[] }): Promise<RunId>;
  /** Polls (real time) until `cond()` holds. */
  waitFor(cond: () => boolean, timeoutMs?: number): Promise<void>;
  /** Polls (real time) until the run reaches one of `statuses`. */
  waitForStatus(runId: RunId, statuses: readonly RunStatus[], timeoutMs?: number): Promise<RunStatus>;
  cleanup(): Promise<void>;
}

async function writeTree(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

const OK_CREDENTIALS: CredentialResolver = { resolve: () => Promise.resolve(ok('test-key-0000000000000000')) };

/** Real-time sleep for polling (tests only; the engine itself never uses global timers). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

/** Creates a harness. Call `cleanup()` in afterEach. */
export async function createHarness(o: HarnessOptions = {}): Promise<Harness> {
  const clock = createManualClock();
  const timers = createManualTimers(clock);
  const ids = createIdGen(clock, (n) => new Uint8Array(randomBytes(n)));
  const db = await openTestDb({ clock, ids });
  const userDataDir = await realpath(await mkdtemp(join(tmpdir(), 'relay-engine-ud-')));
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'relay-engine-prj-')));
  await writeTree(projectRoot, o.files ?? SAMPLE_FILES);
  const templates = createTemplateRegistry();
  seedDatabase(db, { catalog: loadCatalogEntries(), templates, ids, clock });
  const callLog = createMemoryCallLog();
  const logger = memoryLogger();
  const baseProviders = createProviderRegistry({ mode: 'fake', fakeScenario: o.scenario ?? 'happy-path', clock, timers, callLog,
    ...(o.extraFixtures === undefined ? {} : { extraFixtures: o.extraFixtures }) });
  const providers = o.providers?.(baseProviders) ?? baseProviders;
  const artifacts = createArtifactStore({ userDataDir, clock });
  const projectFs = createProjectFs(userDataDir);
  const events: PushEvent[] = [];
  const memory = createMemoryService({ db, artifacts, clock, ids, logger, emit: (e) => events.push(e) });
  const baseContext = createContextAssembler({ db, projectFs, artifacts, templates, memory });
  const ctx = createEngineContext({
    db, providers, projectFs, artifacts, context: o.context?.(baseContext) ?? baseContext, memory, templates,
    credentials: o.credentials ?? OK_CREDENTIALS, maintenance: createMaintenance({ db, artifacts, clock }), clock, ids, logger,
    emit: (e) => events.push(e), timers, hooks: o.hooks, idleMs: 60_000,
    requestLookup: supportsRequestLookupFor, connectionTestRequest, backup: createBackupPort({ db, userDataDir, clock, logger, homeDir: userDataDir }),
    exports: createExportPort(),
  });
  const engine = createEngineFromContext(ctx);
  const created = await engine.handle('relay/v1/projects.createFromRoot', {
    idempotencyKey: 'harness-project-0001', rootRealpath: projectRoot, rootDisplayPath: '~/sample', name: 'Sample',
    exclusions: [], allowedProviderIds: [...(o.allowedProviderIds ?? ['anthropic', 'openai', 'gemini', 'fake'])],
    monthlyAllowanceMicrousd: o.monthlyAllowanceMicrousd ?? null, isDemo: false,
  });
  if (!created.ok) throw new Error(`harness project: ${created.error.code}`);
  const projectId = created.data.id;
  const workflow = db.repos.workflows.listWorkflows()[0];
  if (workflow === undefined) throw new Error('harness: no seeded workflow');
  let runSeq = 0;
  return {
    ctx, engine, db, clock, timers, ids, logger, events, callLog, userDataDir, projectRoot, projectId,
    async startRun(s = {}) {
      runSeq += 1;
      const res = await engine.handle('relay/v1/runs.start', {
        idempotencyKey: s.key ?? `harness-run-key-${String(runSeq).padStart(4, '0')}`,
        projectId, workflowId: workflow.id, workflowVersion: 1, goal: s.goal ?? 'Fix the defects in the handlers.',
        input: { kind: 'files', relPaths: [...(s.relPaths ?? Object.keys(o.files ?? SAMPLE_FILES))] },
        ...(s.budgetMicrousd === undefined ? {} : { limitOverrides: { budgetMicrousd: s.budgetMicrousd } }),
        ...(s.memoryRecordIds === undefined ? {} : { memoryRecordIds: [...s.memoryRecordIds] }),
      });
      if (!res.ok) throw new Error(`harness runs.start: ${res.error.code} ${JSON.stringify(res.error.details)}`);
      return res.data.runId;
    },
    async waitFor(cond, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (!cond()) {
        if (Date.now() > deadline) throw new Error('waitFor: condition not met');
        await sleep(5);
      }
    },
    async waitForStatus(runId, statuses, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const status = db.repos.runs.get(runId).status;
        if (statuses.includes(status)) return status;
        if (Date.now() > deadline) throw new Error(`run ${runId} stuck in ${status}, wanted ${statuses.join('|')}`);
        await sleep(5);
      }
    },
    async cleanup() {
      await engine.stop({ graceMs: 0 });
      await db.dispose();
      await rm(userDataDir, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    },
  };
}
