// 03 §C1: the connection pragmas are not just executed but in effect. Read back on a real file connection.
import { afterEach, describe, expect, it } from 'vitest';
import { openNodeSqlite } from './driver-node-sqlite.js';
import type { SqlDriver } from './driver.js';
import { CONNECTION_PRAGMAS, applyPragmas } from './pragmas.js';
import { openTestDb } from './unit-of-work.js';
import type { TestDb } from './unit-of-work.js';

let db: TestDb | undefined;
const raws: SqlDriver[] = [];
afterEach(async () => {
  for (const d of raws.splice(0)) d.close();
  await db?.dispose(); // removes only the temp dir openTestDb created
  db = undefined;
});

/** The single value of `PRAGMA <name>` (the column name differs per pragma). */
function pragma(d: SqlDriver, name: string): unknown {
  const row = d.prepare(`PRAGMA ${name}`).get();
  return typeof row === 'object' && row !== null ? Object.values(row)[0] : undefined;
}

async function connection(withPragmas: boolean): Promise<SqlDriver> {
  db ??= await openTestDb();
  const d = openNodeSqlite(db.path);
  raws.push(d);
  if (withPragmas) applyPragmas(d);
  return d;
}

describe('connection pragmas (03 §C1)', () => {
  it('applyPragmas leaves WAL, synchronous FULL, foreign keys on, busy_timeout 5000, trusted_schema off, temp_store MEMORY', async () => {
    const d = await connection(true);

    expect({
      journal_mode: pragma(d, 'journal_mode'),
      synchronous: pragma(d, 'synchronous'),
      foreign_keys: pragma(d, 'foreign_keys'),
      busy_timeout: pragma(d, 'busy_timeout'),
      trusted_schema: pragma(d, 'trusted_schema'),
      temp_store: pragma(d, 'temp_store'),
    }).toEqual({ journal_mode: 'wal', synchronous: 2, foreign_keys: 1, busy_timeout: 5000, trusted_schema: 0, temp_store: 2 }); // FULL = 2, MEMORY = 2
  });

  it('a bare connection lacks the per-connection settings (so they come from applyPragmas) but keeps WAL from the file', async () => {
    const d = await connection(false);

    expect([pragma(d, 'busy_timeout'), pragma(d, 'temp_store')]).toEqual([0, 0]); // per-connection: only applyPragmas sets them
    expect(pragma(d, 'journal_mode')).toBe('wal'); // persistent in the file: openDb already switched it
  });

  it('runs every pragma in the documented order (WAL first, temp_store last)', () => {
    expect(CONNECTION_PRAGMAS.map((p) => p.replace(/^PRAGMA (\w+).*$/, '$1'))).toEqual(['journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout', 'trusted_schema', 'temp_store']);
  });
});
