/**
 * Read-only SQLite inspection for integration assertions: `integrity_check` and a custom dump of every row of every
 * table (the redaction scan, 11 §K6). Tests only; product code talks to SQLite through @relay/storage.
 */
import { DatabaseSync } from 'node:sqlite';

/** Runs `fn` over a read-only connection to `dbPath`. */
export function withReadonlyDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** `PRAGMA integrity_check` rows joined (`'ok'` when healthy). */
export function integrityCheck(dbPath: string): string {
  return withReadonlyDb(dbPath, (db) =>
    db.prepare('PRAGMA integrity_check').all().map((r) => String(Object.values(r)[0])).join('\n'));
}

/** One value of the dump. */
export interface DumpedValue {
  readonly table: string;
  readonly column: string;
  readonly value: string;
}

/** Every column value of every table (`sqlite_master` iteration, `SELECT *`), as text (blobs decoded as UTF-8). */
export function dumpAllValues(dbPath: string): DumpedValue[] {
  return withReadonlyDb(dbPath, (db) => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r['name']));
    const out: DumpedValue[] = [];
    for (const table of tables) {
      for (const row of db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all()) {
        for (const [column, v] of Object.entries(row)) {
          if (v === null) continue;
          const value = v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v);
          out.push({ table, column, value });
        }
      }
    }
    return out;
  });
}

/** Rows of an arbitrary read-only query. */
export function queryAll(dbPath: string, sql: string, ...params: (string | number | null)[]): Record<string, unknown>[] {
  return withReadonlyDb(dbPath, (db) => db.prepare(sql).all(...params) as Record<string, unknown>[]);
}
