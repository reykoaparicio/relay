import { RelayError, errors } from '@relay/contracts';

/** SQLite primary result code for `SQLITE_BUSY` (extended codes keep it in the low byte). */
const SQLITE_BUSY = 5;
const SQLITE_CONSTRAINT = 19;
const PRIMARY_CODE_MASK = 0xff;

/** A stored row failed validation in a mapper (03 §C5). The message carries only table, id, and column. */
export class DataCorruptionError extends Error {
  readonly table: string;
  readonly id: string | null;
  readonly column: string;

  constructor(table: string, id: string | null, column: string) {
    super(`Stored data failed validation: ${table}.${column} (id ${id ?? 'unknown'})`);
    this.name = 'DataCorruptionError';
    this.table = table;
    this.id = id;
    this.column = column;
  }
}

/** A migration applied to this database differs from the embedded migration of the same version (§18.5). */
export class MigrationChecksumError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(`Migration ${String(version)} checksum mismatch; refusing to open the database`);
    this.name = 'MigrationChecksumError';
    this.version = version;
  }
}

/** The database was written by a newer app version (forward-only migrations, 03 §C2). */
export class MigrationVersionError extends Error {
  readonly dbVersion: number;
  readonly appVersion: number;

  constructor(dbVersion: number, appVersion: number) {
    super(`Database schema version ${String(dbVersion)} is newer than this app supports (${String(appVersion)})`);
    this.name = 'MigrationVersionError';
    this.dbVersion = dbVersion;
    this.appVersion = appVersion;
  }
}

function sqliteErrcode(e: unknown): number | null {
  if (typeof e !== 'object' || e === null || !('errcode' in e)) {
    return null;
  }
  const code = e.errcode;
  return typeof code === 'number' ? code : null;
}

/** True when `e` is a SQLite `SQLITE_BUSY` error (any extended variant). */
export function isSqliteBusy(e: unknown): boolean {
  const code = sqliteErrcode(e);
  return code !== null && (code & PRIMARY_CODE_MASK) === SQLITE_BUSY;
}

/** True when `e` is a SQLite constraint violation (UNIQUE, CHECK, FOREIGN KEY, …). */
export function isSqliteConstraint(e: unknown): boolean {
  const code = sqliteErrcode(e);
  return code !== null && (code & PRIMARY_CODE_MASK) === SQLITE_CONSTRAINT;
}

/**
 * Maps driver errors to the taxonomy where one applies: `SQLITE_BUSY` after `busy_timeout` becomes a retryable
 * `RUNNER_UNAVAILABLE` (03 §C4). Everything else is returned unchanged.
 */
export function mapSqliteError(e: unknown): unknown {
  if (isSqliteBusy(e)) {
    const mapped = new RelayError(errors.runnerUnavailable({ details: { reason: 'database_busy' } }));
    return Object.assign(mapped, { cause: e });
  }
  return e;
}

/**
 * Fatal integrity failure on open (03 §C1): the user must restore from `backups/`. Built by `errors.internal` with the
 * closed reason `integrity_check_failed`, whose static recovery `userMessage` ("Restore it from a backup in the backups
 * folder") lives in contracts `INTERNAL_REASON_MESSAGES` — INTERNAL may carry a userMessage, but only a curated one
 * keyed by its reason, never call-site text. SQLite's raw check output (which can name tables, indexes, and pages)
 * stays on the never-serialized `cause` for in-process debugging.
 */
export function integrityError(result: string): RelayError {
  return new RelayError(errors.internal(undefined, 'integrity_check_failed'), { cause: new Error(result.slice(0, 200)) });
}
