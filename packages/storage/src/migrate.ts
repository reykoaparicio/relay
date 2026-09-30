import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Clock } from '@relay/contracts';
import { invariant } from '@relay/contracts';
import type { Migration } from '../migrations/index.js';
import { MIGRATIONS } from '../migrations/index.js';
import type { SqlDriver } from './driver.js';
import { MigrationChecksumError, MigrationVersionError } from './errors.js';
import { backupStamp } from './stamp.js';

/** Options for {@link migrate}. `migrations` exists only so tests can pass a modified list (03 §C2). */
export interface MigrateOptions {
  readonly migrations?: readonly Migration[];
  readonly clock: Clock;
  readonly backupsDir: string;
}

/** Schema versions before and after {@link migrate}. */
export interface MigrateResult {
  readonly from: number;
  readonly to: number;
}

const CREATE_SCHEMA_MIGRATIONS = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT`;

/** sha256 hex of the UTF-8 migration SQL. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function assertContiguous(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    invariant(m.version === i + 1, `migrations must be sorted and contiguous from 1 (got ${String(m.version)} at ${String(i)})`);
  });
}

interface AppliedRow {
  readonly version: number;
  readonly checksum: string;
}

function readApplied(driver: SqlDriver): AppliedRow[] {
  return driver
    .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version')
    .all()
    .map((r) => {
      const row = r as { version?: unknown; checksum?: unknown };
      invariant(typeof row.version === 'number' && typeof row.checksum === 'string', 'malformed schema_migrations row');
      return { version: row.version, checksum: row.checksum };
    });
}

function isNonEmpty(driver: SqlDriver): boolean {
  const row = driver
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'")
    .get() as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

function verifyApplied(applied: readonly AppliedRow[], migrations: readonly Migration[]): void {
  const known = migrations.length;
  for (const a of applied) {
    if (a.version > known) {
      throw new MigrationVersionError(a.version, known);
    }
    const m = migrations[a.version - 1];
    if (m === undefined || migrationChecksum(m.sql) !== a.checksum) {
      throw new MigrationChecksumError(a.version);
    }
  }
}

function applyOne(driver: SqlDriver, m: Migration, now: number): void {
  driver.exec('BEGIN IMMEDIATE');
  try {
    driver.exec(m.sql);
    driver
      .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
      .run(m.version, m.name, migrationChecksum(m.sql), now);
    driver.exec('COMMIT');
  } catch (e) {
    if (driver.inTransaction) {
      driver.exec('ROLLBACK');
    }
    throw e;
  }
}

/**
 * Applies pending embedded migrations, each in its own `BEGIN IMMEDIATE` transaction (03 §C2). Takes a
 * pre-migration backup when the database is non-empty (§6.4, §18.5).
 * @throws MigrationChecksumError when an applied migration's checksum differs from the embedded one.
 * @throws MigrationVersionError when the database is newer than the highest known migration.
 * @throws Error (invariant) when `migrations` is not sorted and contiguous from 1.
 */
export async function migrate(driver: SqlDriver, opts: MigrateOptions): Promise<MigrateResult> {
  const migrations = opts.migrations ?? MIGRATIONS;
  assertContiguous(migrations);
  const nonEmpty = isNonEmpty(driver);
  driver.exec(CREATE_SCHEMA_MIGRATIONS);
  const applied = readApplied(driver);
  verifyApplied(applied, migrations);
  const from = applied.length === 0 ? 0 : Math.max(...applied.map((a) => a.version));
  const pending = migrations.filter((m) => m.version > from);
  const to = pending.length === 0 ? from : migrations.length;
  if (pending.length > 0 && nonEmpty) {
    const dest = join(opts.backupsDir, `${backupStamp(opts.clock.now())}-pre-v${String(to)}`, 'relay.sqlite');
    await driver.backupTo(dest);
  }
  for (const m of pending) {
    applyOne(driver, m, opts.clock.now());
  }
  return { from, to };
}
