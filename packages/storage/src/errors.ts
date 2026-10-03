import { RelayError, errnoOf, errors, isDatabaseBusyError, isRelayError } from '@relay/contracts';
import type { DatabaseUnavailableReason } from '@relay/contracts';

/** SQLite primary result codes (extended codes keep them in the low byte). */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_CANTOPEN = 14;
const SQLITE_CONSTRAINT = 19;
const SQLITE_NOTADB = 26;
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

function primaryCode(e: unknown): number | null {
  const code = sqliteErrcode(e);
  return code === null ? null : code & PRIMARY_CODE_MASK;
}

/** True when `e` is a SQLite `SQLITE_BUSY` error (any extended variant). */
export function isSqliteBusy(e: unknown): boolean {
  return primaryCode(e) === SQLITE_BUSY;
}

/** True when `e` is a SQLite constraint violation (UNIQUE, CHECK, FOREIGN KEY, …). */
export function isSqliteConstraint(e: unknown): boolean {
  return primaryCode(e) === SQLITE_CONSTRAINT;
}

/** True when `e` is a raw SQLite busy error or the mapped "database busy" error, i.e. a retry may succeed. */
export function isDatabaseBusy(e: unknown): boolean {
  return isSqliteBusy(e) || isDatabaseBusyError(e);
}

/** The {@link DatabaseUnavailableReason} of a raw SQLite error, or null when it is not a database-level failure. */
export function sqliteReason(e: unknown): DatabaseUnavailableReason | null {
  switch (primaryCode(e)) {
    case SQLITE_BUSY:
    case SQLITE_LOCKED:
      return 'database_busy';
    case SQLITE_FULL:
      return 'disk_full';
    case SQLITE_READONLY:
      return 'db_readonly';
    case SQLITE_CORRUPT:
    case SQLITE_NOTADB:
      return 'db_corrupt';
    case SQLITE_CANTOPEN:
    case SQLITE_IOERR:
      return 'db_cannot_open';
    case null:
    default:
      return null;
  }
}

/** Curated message of a busy error during normal use (the op failed; nothing was written; retry is safe). */
export const DATABASE_BUSY_OP_MESSAGE = 'The Relay database is busy. Try again in a moment.';

/**
 * Maps driver errors during normal use (03 §C4, E2 #2/#3): `SQLITE_BUSY` after the short `busy_timeout` becomes a
 * retryable `DATABASE_UNAVAILABLE database_busy` (next action `wait`); disk full / read-only / damaged become
 * `DATABASE_UNAVAILABLE` with their reason. `SQLITE_CANTOPEN` / `IOERR` mid-session and everything else are returned
 * unchanged. The raw SQLite error stays on the never-serialized `cause`.
 */
export function mapSqliteError(e: unknown): unknown {
  const reason = sqliteReason(e);
  if (reason === null || reason === 'db_cannot_open') return e;
  if (reason === 'database_busy') {
    const appErr = { ...errors.databaseUnavailable('database_busy'), nextAction: 'wait' as const, userMessage: DATABASE_BUSY_OP_MESSAGE };
    return new RelayError(appErr, { cause: e });
  }
  return new RelayError(errors.databaseUnavailable(reason), { cause: e });
}

/**
 * Maps a failure while OPENING the database (pragmas, quick_check, migrations; 03 §C1/§C2) to a fatal
 * `DATABASE_UNAVAILABLE` with a closed reason, so the runner's `fatal` message says what is wrong (E2 #3):
 * newer schema, checksum mismatch, disk full, read-only, damaged (before the integrity check), busy, cannot open.
 * An already-mapped RelayError keeps its error; anything unrecognised is returned unchanged.
 */
export function mapOpenError(e: unknown): unknown {
  if (e instanceof MigrationVersionError) return new RelayError(errors.databaseUnavailable('schema_too_new'), { cause: e });
  if (e instanceof MigrationChecksumError) return new RelayError(errors.databaseUnavailable('migration_checksum_mismatch'), { cause: e });
  if (isRelayError(e)) return e;
  const errno = errnoOf(e);
  if (errno === 'EROFS' || errno === 'EACCES' || errno === 'EPERM') return new RelayError(errors.databaseUnavailable('db_readonly'), { cause: e });
  if (errno === 'ENOSPC') return new RelayError(errors.databaseUnavailable('disk_full'), { cause: e });
  const reason = sqliteReason(e);
  return reason === null ? e : new RelayError(errors.databaseUnavailable(reason), { cause: e });
}

/**
 * Fatal integrity failure on open (03 §C1): the user must restore from `backups/`. `DATABASE_UNAVAILABLE` with the
 * closed reason `integrity_check_failed` and its curated restore message. SQLite's raw check output (which can name
 * tables, indexes, and pages) stays on the never-serialized `cause` for in-process debugging.
 */
export function integrityError(result: string): RelayError {
  return new RelayError(errors.databaseUnavailable('integrity_check_failed'), { cause: new Error(result.slice(0, 200)) });
}
