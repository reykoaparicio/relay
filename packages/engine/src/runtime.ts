// 06 F16: the Electron-free composition root. The ONLY engine file that value-imports storage, providers, and tools
// (lint override). H7's runner entry, K's crash child, D9b, and M's scripts all build the engine through it.
import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createIdGen, err, errors, ok, systemClock, toDisplayPath } from '@relay/contracts';
import type { Clock, ModelCapabilities, PushEvent } from '@relay/contracts';
import { connectionTestRequest, createProviderRegistry, loadCatalogEntries, supportsRequestLookupFor } from '@relay/providers';
import type { FakeCallLog, FakeScenario, ProviderRegistry } from '@relay/providers';
import { createBackup, createMaintenance, openDb } from '@relay/storage';
import type { Db } from '@relay/storage';
import { createTemplateRegistry } from '@relay/templates';
import type { TemplateRegistry } from '@relay/templates';
import { createArtifactStore, hashFiles, openProjectRoot, readSelected, scanProject } from '@relay/tools';
import type { ArtifactStore } from '@relay/tools';
import { globalTimers } from './clock.js';
import { createContextAssembler } from './context.js';
import { createMemoryService } from './memory.js';
import type { BackupPort, CredentialResolver, EngineApi, EngineTestHooks, Logger, ProjectFsPort, Timers } from './ports.js';
import { createEngine } from './runner.js';
import { seedDatabase } from './seed.js';

/** Options of {@link createRuntime}. */
export interface RuntimeOptions {
  readonly userDataDir: string;
  readonly providerMode: 'live' | 'fake';
  /** FAKE_SCENARIOS key or an inline scenario (fake mode only). */
  readonly fakeScenario?: string | FakeScenario;
  /** Extra success fixtures keyed by name (fake mode only). */
  readonly fakeExtraFixtures?: Record<string, unknown>;
  readonly credentials: CredentialResolver;
  readonly hooks?: EngineTestHooks;
  readonly callLog?: FakeCallLog;
  readonly clock?: Clock;
  readonly fakeCapabilityOverrides?: Partial<ModelCapabilities>;
  readonly emit?: (e: PushEvent) => void;
  readonly logger?: Logger;
  readonly timers?: Timers;
  readonly templates?: TemplateRegistry;
  readonly isPidAlive?: (pid: number) => boolean;
  /** Loop idle wait (default 1 s). */
  readonly idleMs?: number;
}

/** A composed runtime. `dispose()` stops the engine and closes the DB. */
export interface Runtime {
  readonly engine: EngineApi;
  readonly db: Db;
  readonly projectFs: ProjectFsPort;
  readonly artifacts: ArtifactStore;
  readonly providers: ProviderRegistry;
  dispose(): Promise<void>;
}

/** JSON lines on stderr (00b §3 structured logging); callers redact before logging. */
export function createStderrLogger(): Logger {
  const write = (level: string) => (event: string, fields?: Readonly<Record<string, unknown>>) => {
    process.stderr.write(`${JSON.stringify({ ts: Date.now(), level, event, ...fields })}\n`);
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

/** Wraps @relay/tools confined file access as the engine's ProjectFsPort. */
export function createProjectFs(userDataDir: string): ProjectFsPort {
  return {
    openRoot: (rootRealpath) => openProjectRoot(rootRealpath, { userDataDir }),
    readSelected: (root, relPaths, opts) => readSelected(root, relPaths, opts),
    hashFiles: (root, relPaths) => hashFiles(root, relPaths),
    scan: (root, opts) => scanProject(root, opts),
  };
}

/** `app.createBackup` over storage `createBackup` (03 §C7); the directory is returned as a display path. */
export function createBackupPort(o: { db: Db; userDataDir: string; clock: Clock; logger: Logger; homeDir?: string }): BackupPort {
  return {
    async create() {
      try {
        const b = await createBackup({ db: o.db, userDataDir: o.userDataDir, clock: o.clock });
        return ok({ backupDisplayPath: toDisplayPath(b.dir, o.homeDir ?? homedir()), createdAt: b.manifest.createdAt, sizeBytes: b.sizeBytes });
      } catch (e) {
        o.logger.error('backup.failed', { err: e instanceof Error ? e.name : 'unknown' });
        return err(errors.artifactWriteFailed());
      }
    },
  };
}

/**
 * Composes db → seed → providers → artifacts → projectFs → memory → context → engine. Does NOT start the engine;
 * callers run `await runtime.engine.start()`.
 * @throws when the database cannot be opened or migrated, or a bundled template/catalog is invalid.
 */
export async function createRuntime(o: RuntimeOptions): Promise<Runtime> {
  const clock = o.clock ?? systemClock;
  const ids = createIdGen(clock, (n) => new Uint8Array(randomBytes(n)));
  const logger = o.logger ?? createStderrLogger();
  const timers = o.timers ?? globalTimers;
  mkdirSync(o.userDataDir, { recursive: true });
  const dbPath = join(o.userDataDir, 'relay.sqlite');
  const db = await openDb({ path: dbPath, clock, ids, backupsDir: join(o.userDataDir, 'backups'), ...(o.isPidAlive === undefined ? {} : { isPidAlive: o.isPidAlive }) });
  try {
    const templates = o.templates ?? createTemplateRegistry();
    seedDatabase(db, { catalog: loadCatalogEntries(), templates, ids, clock });
    const providers = createProviderRegistry({
      mode: o.providerMode, clock, timers, logger,
      ...(o.fakeScenario === undefined ? {} : { fakeScenario: o.fakeScenario }),
      ...(o.callLog === undefined ? {} : { callLog: o.callLog }),
      ...(o.fakeCapabilityOverrides === undefined ? {} : { fakeCapabilityOverrides: o.fakeCapabilityOverrides }),
      ...(o.fakeExtraFixtures === undefined ? {} : { extraFixtures: o.fakeExtraFixtures }),
    });
    const artifacts = createArtifactStore({ userDataDir: o.userDataDir, clock, log: (event, fields) => {
      logger.warn(event, fields);
    } });
    const projectFs = createProjectFs(o.userDataDir);
    const memory = createMemoryService();
    const context = createContextAssembler({ db, projectFs, artifacts, templates, memory });
    const maintenance = createMaintenance({ db, artifacts, clock });
    const engine = createEngine({
      db, providers, projectFs, artifacts, context, memory, templates, credentials: o.credentials, maintenance, clock, ids, logger,
      emit: o.emit ?? (() => undefined), timers, hooks: o.hooks, idleMs: o.idleMs,
      diagnostics: { dbSizeBytes: () => statSync(dbPath).size },
      requestLookup: supportsRequestLookupFor,
      connectionTestRequest,
      backup: createBackupPort({ db, userDataDir: o.userDataDir, clock, logger }),
    });
    return {
      engine, db, projectFs, artifacts, providers,
      async dispose() {
        await engine.stop({ graceMs: 5_000 });
        db.close();
      },
    };
  } catch (e) {
    db.close();
    throw e;
  }
}
