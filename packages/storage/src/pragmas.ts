import type { SqlDriver } from './driver.js';
import { integrityError } from './errors.js';

/**
 * SQLite `busy_timeout` (ms). Short on purpose (E2 #2): node:sqlite is synchronous, so a long wait on a lock blocks the
 * runner's event loop (heartbeats stop and main's supervisor kills a healthy runner). A lock that outlasts this surfaces
 * as a retryable `DATABASE_UNAVAILABLE database_busy`; callers retry asynchronously (yielding) instead.
 */
export const BUSY_TIMEOUT_MS = 200;

/** 03 §C1 connection pragmas, applied on open in this order. */
export const CONNECTION_PRAGMAS: readonly string[] = [
  'PRAGMA journal_mode = WAL', // readers never block the single writer
  'PRAGMA synchronous = FULL', // durability for ledger/checkpoints over speed (§3.3 no corruption)
  'PRAGMA foreign_keys = ON',
  `PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`,
  'PRAGMA trusted_schema = OFF',
  'PRAGMA temp_store = MEMORY',
];

/** Applies {@link CONNECTION_PRAGMAS} to a read-write connection. */
export function applyPragmas(driver: SqlDriver): void {
  for (const pragma of CONNECTION_PRAGMAS) {
    driver.exec(pragma);
  }
}

/**
 * Runs `PRAGMA quick_check` (03 §C1).
 * @throws RelayError `INTERNAL` with a restore-from-backups hint when the check does not return `ok`.
 */
export function quickCheck(driver: SqlDriver): void {
  const rows = driver.prepare('PRAGMA quick_check').all();
  const results = rows.map((r): unknown => (typeof r === 'object' && r !== null ? (Object.values(r) as unknown[])[0] : undefined));
  if (results.length !== 1 || results[0] !== 'ok') {
    throw integrityError(results.map(String).join('; '));
  }
}

/**
 * Proves the connection can write (E2 #3): SQLite silently opens a write-protected file read-only and `BEGIN IMMEDIATE`
 * still succeeds there, so a read-only database would otherwise only fail on the first real write. Rewrites
 * `user_version` with its own value inside a rolled-back transaction.
 * @throws the driver's SQLITE_READONLY (mapped by the caller) when the database is not writable.
 */
export function assertWritable(driver: SqlDriver): void {
  driver.exec('BEGIN IMMEDIATE');
  try {
    const row = driver.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
    const v = typeof row?.user_version === 'number' ? row.user_version : 0;
    driver.exec(`PRAGMA user_version = ${String(Math.trunc(v))}`);
  } finally {
    if (driver.inTransaction) driver.exec('ROLLBACK');
  }
}
