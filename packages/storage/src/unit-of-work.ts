import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Clock, IdGen, Result } from '@relay/contracts';
import { RelayError, createIdGen, errors, invariant, systemClock } from '@relay/contracts';
import type { Migration } from '../migrations/index.js';
import { AUTO_BACKUPS_DIRNAME, autoBackup } from './backup.js';
import type { SqlDriver } from './driver.js';
import { openNodeSqlite } from './driver-node-sqlite.js';
import { isDatabaseBusy, mapOpenError } from './errors.js';
import { migrate } from './migrate.js';
import { readInt } from './mappers.js';
import { applyPragmas, assertWritable, quickCheck } from './pragmas.js';
import { defaultIsPidAlive } from './pid.js';
import { createRepos } from './repos/index.js';
import type { Db, NotPromise, Repos } from './types.js';

/** Options for {@link openDb} (03 §C4). */
export interface OpenDbOptions {
  path: string;
  clock: Clock;
  ids: IdGen;
  backupsDir: string;
  /** LeaseRepo dependency; default uses `process.kill(pid, 0)`, EPERM ⇒ alive. */
  isPidAlive?: (pid: number) => boolean;
  /**
   * Waits between open attempts while the database is locked by another process (E2 #1). Default
   * {@link OPEN_BUSY_RETRY_DELAYS_MS}; after the last one the open fails with `DATABASE_UNAVAILABLE database_busy`.
   */
  busyRetryDelaysMs?: readonly number[];
  /** Called before each busy retry wait (logging). */
  onBusyRetry?: (attempt: number, delayMs: number) => void;
}

/** Backoff of {@link openDb} while the file is locked at boot: ~8 s in total, yielding between attempts. */
export const OPEN_BUSY_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500, 1_000, 2_000, 4_000];

/** Test database: a migrated temp-dir file DB. */
export type TestDb = Db & { readonly path: string; dispose(): Promise<void> };

/** Dependencies of {@link createDb}. */
export interface CreateDbDeps {
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly isPidAlive?: ((pid: number) => boolean) | undefined;
  /** Enables {@link Db.autoBackup}: automatic backups go to the sibling `backups-auto/` of this dir. */
  readonly backupsDir?: string | undefined;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Runs `fn` inside `BEGIN IMMEDIATE … COMMIT` on `driver`. On a throw, issues ROLLBACK only if SQLite still reports
 * an open transaction (it may already have rolled back, e.g. after SQLITE_FULL), then rethrows the original error.
 * When `rollbackIf(result)` holds, the transaction is rolled back instead of committed and the result is returned.
 * @throws Error (invariant) when a transaction is already open (no nesting / savepoints in P0).
 */
export function runImmediate<T>(driver: SqlDriver, fn: () => T, rollbackIf?: (out: T) => boolean): T {
  // Read through a function: the getter changes under us, so control-flow narrowing must not apply.
  const isOpen = (): boolean => driver.inTransaction;
  invariant(!isOpen(), 'nested transactions are not supported');
  driver.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    driver.exec(rollbackIf?.(out) === true ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (e) {
    if (isOpen()) {
      driver.exec('ROLLBACK');
    }
    throw e;
  }
}

/** Wraps an open, migrated connection as a {@link Db}. */
export function createDb(driver: SqlDriver, deps: CreateDbDeps): Db {
  const repos: Repos = createRepos(driver, {
    clock: deps.clock,
    ids: deps.ids,
    isPidAlive: deps.isPidAlive ?? ((pid) => defaultIsPidAlive(pid)),
    inTx: (fn) => (driver.inTransaction ? fn() : runImmediate(driver, fn)),
  });
  return {
    repos,
    tx<T>(_mode: 'immediate', fn: (r: Repos) => NotPromise<T>): T {
      return runImmediate(driver, () => fn(repos));
    },
    txResult<T>(_mode: 'immediate', fn: (r: Repos) => NotPromise<Result<T>>): Result<T> {
      return runImmediate<Result<T>>(driver, () => fn(repos), (out) => !out.ok);
    },
    backupTo: (dest) => driver.backupTo(dest),
    schemaVersion: () =>
      readInt('schema_migrations', driver.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get(), 'v'),
    // The WAL holds every write since the last checkpoint, so it is part of the database's size (E2 #5).
    sizeBytes: () => fileSize(driver.path) + fileSize(`${driver.path}-wal`),
    autoBackup: async (o = {}) => {
      const { backupsDir } = deps;
      if (backupsDir === undefined) return null;
      const userDataDir = dirname(backupsDir);
      const made = await autoBackup({ db: { backupTo: (dest) => driver.backupTo(dest) }, userDataDir, backupsDir: join(userDataDir, AUTO_BACKUPS_DIRNAME),
        clock: deps.clock, ...(o.force === undefined ? {} : { force: o.force }) });
      return made === null ? null : { dir: made.dir, createdAt: made.manifest.createdAt, sizeBytes: made.sizeBytes };
    },
    close: () => {
      driver.close();
    },
  };
}

async function openOnce(opts: OpenDbOptions, migrations: readonly Migration[] | undefined): Promise<Db> {
  const driver = openNodeSqlite(opts.path);
  try {
    applyPragmas(driver);
    quickCheck(driver);
    assertWritable(driver);
    await migrate(driver, { clock: opts.clock, backupsDir: opts.backupsDir, ...(migrations === undefined ? {} : { migrations }) });
  } catch (e) {
    driver.close();
    throw e;
  }
  return createDb(driver, { clock: opts.clock, ids: opts.ids, isPidAlive: opts.isPidAlive, backupsDir: opts.backupsDir });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function open(opts: OpenDbOptions, migrations: readonly Migration[] | undefined): Promise<Db> {
  const delays = opts.busyRetryDelaysMs ?? OPEN_BUSY_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await openOnce(opts, migrations);
    } catch (e) {
      const mapped = mapOpenError(e);
      if (!isDatabaseBusy(mapped)) throw mapped;
      const delay = delays[attempt];
      // Busy at boot is retried with backoff, yielding the event loop; only a lock that outlasts every wait is fatal,
      // and then with its own code (not the generic RUNNER_UNAVAILABLE) so the user is told to close the other app.
      if (delay === undefined) throw new RelayError(errors.databaseUnavailable('database_busy', { details: { attempts: attempt + 1 } }), { cause: e });
      opts.onBusyRetry?.(attempt + 1, delay);
      await sleep(delay);
    }
  }
}

/**
 * Opens the database: C1 pragmas, `quick_check`, a write probe, then the embedded migrations (03 §C4). The runner calls
 * this before sending `ready` (§6.4). A lock held by another process is retried with backoff ({@link
 * OPEN_BUSY_RETRY_DELAYS_MS}) before failing.
 * @throws RelayError DATABASE_UNAVAILABLE with a closed `details.reason`: `database_busy`, `schema_too_new`,
 * `migration_checksum_mismatch`, `disk_full`, `db_readonly`, `db_corrupt`, `integrity_check_failed`, `db_cannot_open`.
 */
export function openDb(opts: OpenDbOptions): Promise<Db> {
  return open(opts, undefined);
}

/** Opens a fresh migrated file DB in a temp dir; `dispose()` closes it and removes the dir. */
export async function openTestDb(
  opts: Partial<OpenDbOptions> & { migrations?: readonly Migration[] } = {},
): Promise<TestDb> {
  const dir = await mkdtemp(join(tmpdir(), 'relay-db-'));
  const clock = opts.clock ?? systemClock;
  const path = opts.path ?? join(dir, 'relay.sqlite');
  const db = await open(
    {
      path,
      clock,
      ids: opts.ids ?? createIdGen(clock, (n) => randomBytes(n)),
      backupsDir: opts.backupsDir ?? join(dir, 'backups'),
      ...(opts.isPidAlive === undefined ? {} : { isPidAlive: opts.isPidAlive }),
    },
    opts.migrations,
  );
  return {
    ...db,
    path,
    async dispose() {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
