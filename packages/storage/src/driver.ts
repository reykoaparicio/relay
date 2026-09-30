// C1 SQL driver abstraction (ADR-012). The rest of the package only sees these interfaces, so the node:sqlite
// implementation can be swapped for better-sqlite3 without touching repositories.

/** A value that can be bound to a statement parameter. */
export type SqlParam = string | number | bigint | null | Uint8Array;

/** Result of a write statement. */
export interface SqlRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

/** A prepared statement. Rows come back as `unknown` and are validated by the mappers (03 §C5). */
export interface SqlStatement {
  run(...params: SqlParam[]): SqlRunResult;
  get(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
}

/** Synchronous SQLite connection. */
export interface SqlDriver {
  exec(sql: string): void;
  /** Returns a prepared statement, cached by SQL text so statements are reused. */
  prepare(sql: string): SqlStatement;
  /** True while a transaction is open on this connection (node:sqlite `isTransaction`). */
  readonly inTransaction: boolean;
  close(): void;
  /** Consistent online snapshot of the database into `destPath` (§6.4). Creates the parent directory. */
  backupTo(destPath: string): Promise<void>;
  readonly path: string;
}
