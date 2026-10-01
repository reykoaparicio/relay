import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock, IdGen, Result } from '@relay/contracts';
import { createIdGen, invariant, systemClock } from '@relay/contracts';
import type { Migration } from '../migrations/index.js';
import type { SqlDriver } from './driver.js';
import { openNodeSqlite } from './driver-node-sqlite.js';
import { migrate } from './migrate.js';
import { readInt } from './mappers.js';
import { applyPragmas, quickCheck } from './pragmas.js';
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
}

/** Test database: a migrated temp-dir file DB. */
export type TestDb = Db & { readonly path: string; dispose(): Promise<void> };

/** Dependencies of {@link createDb}. */
export interface CreateDbDeps {
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly isPidAlive?: ((pid: number) => boolean) | undefined;
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
    close: () => {
      driver.close();
    },
  };
}

async function open(opts: OpenDbOptions, migrations: readonly Migration[] | undefined): Promise<Db> {
  const driver = openNodeSqlite(opts.path);
  try {
    applyPragmas(driver);
    quickCheck(driver);
    await migrate(driver, { clock: opts.clock, backupsDir: opts.backupsDir, ...(migrations === undefined ? {} : { migrations }) });
  } catch (e) {
    driver.close();
    throw e;
  }
  return createDb(driver, { clock: opts.clock, ids: opts.ids, isPidAlive: opts.isPidAlive });
}

/**
 * Opens the database: C1 pragmas, `quick_check`, then the embedded migrations (03 §C4). The runner calls this before
 * sending `ready` (§6.4).
 * @throws RelayError INTERNAL when the integrity check fails; MigrationChecksumError / MigrationVersionError.
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
