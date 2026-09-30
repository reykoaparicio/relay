import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import type { SqlDriver, SqlParam, SqlRunResult, SqlStatement } from './driver.js';
import { mapSqliteError } from './errors.js';

/** Options for {@link openNodeSqlite}. */
export interface OpenNodeSqliteOptions {
  readonly readOnly?: boolean;
}

function wrapStatement(stmt: StatementSync): SqlStatement {
  return {
    run(...params: SqlParam[]): SqlRunResult {
      try {
        const r = stmt.run(...params);
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
      } catch (e) {
        throw mapSqliteError(e);
      }
    },
    get(...params: SqlParam[]): unknown {
      try {
        return stmt.get(...params);
      } catch (e) {
        throw mapSqliteError(e);
      }
    },
    all(...params: SqlParam[]): unknown[] {
      try {
        return stmt.all(...params);
      } catch (e) {
        throw mapSqliteError(e);
      }
    },
  };
}

/**
 * Opens a `node:sqlite` `DatabaseSync` connection behind {@link SqlDriver} (ADR-012). Pragmas are not applied here
 * (see `applyPragmas`), so tests can open raw connections.
 */
export function openNodeSqlite(path: string, opts: OpenNodeSqliteOptions = {}): SqlDriver {
  const db = new DatabaseSync(path, { readOnly: opts.readOnly ?? false });
  const cache = new Map<string, SqlStatement>();
  return {
    path,
    get inTransaction(): boolean {
      return db.isTransaction;
    },
    exec(sql: string): void {
      try {
        db.exec(sql);
      } catch (e) {
        throw mapSqliteError(e);
      }
    },
    prepare(sql: string): SqlStatement {
      const hit = cache.get(sql);
      if (hit !== undefined) {
        return hit;
      }
      const stmt = wrapStatement(db.prepare(sql));
      cache.set(sql, stmt);
      return stmt;
    },
    close(): void {
      cache.clear();
      if (db.isOpen) {
        db.close();
      }
    },
    async backupTo(destPath: string): Promise<void> {
      mkdirSync(dirname(destPath), { recursive: true });
      await backup(db, destPath);
      // The snapshot inherits WAL mode; switch it to a rollback journal so the backup is one self-contained file.
      const copy = new DatabaseSync(destPath);
      try {
        copy.exec('PRAGMA journal_mode = DELETE');
      } finally {
        copy.close();
      }
    },
  };
}
