import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNodeSqlite } from './driver-node-sqlite.js';
import { applyPragmas, quickCheck } from './pragmas.js';

describe('openNodeSqlite', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-driver-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a write on a read-only connection with DATABASE_UNAVAILABLE db_readonly (E2 #3)', () => {
    const path = join(dir, 'a.sqlite');
    const rw = openNodeSqlite(path);
    rw.exec('CREATE TABLE t (x INTEGER) STRICT');
    rw.close();

    const ro = openNodeSqlite(path, { readOnly: true });

    let thrown: unknown = null;
    try {
      ro.exec('INSERT INTO t VALUES (1)');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ appError: { code: 'DATABASE_UNAVAILABLE', details: { reason: 'db_readonly' } } });
    ro.close();
  });

  it('reports inTransaction false outside and true inside BEGIN IMMEDIATE', () => {
    const d = openNodeSqlite(join(dir, 'b.sqlite'));

    const before = d.inTransaction;
    d.exec('BEGIN IMMEDIATE');
    const inside = d.inTransaction;
    d.exec('COMMIT');

    expect(before).toBe(false);
    expect(inside).toBe(true);
    expect(d.inTransaction).toBe(false);
    d.close();
  });

  it('returns the same cached statement for the same SQL text', () => {
    const d = openNodeSqlite(join(dir, 'c.sqlite'));

    const a = d.prepare('SELECT 1 AS n');
    const b = d.prepare('SELECT 1 AS n');

    expect(a).toBe(b);
    expect(a.get()).toEqual({ n: 1 });
    expect(a.all()).toEqual([{ n: 1 }]);
    d.close();
    d.close(); // idempotent
  });

  it('backupTo produces an openable file with the same rows', async () => {
    const d = openNodeSqlite(join(dir, 'd.sqlite'));
    applyPragmas(d);
    d.exec('CREATE TABLE t (x INTEGER) STRICT');
    const r = d.prepare('INSERT INTO t VALUES (?)').run(42);
    const dest = join(dir, 'nested', 'copy.sqlite');

    await d.backupTo(dest);
    const copy = openNodeSqlite(dest, { readOnly: true });

    expect(r.changes).toBe(1);
    expect(copy.prepare('SELECT x FROM t').all()).toEqual([{ x: 42 }]);
    expect(copy.path).toBe(dest);
    quickCheck(copy);
    copy.close();
    d.close();
  });

  it('maps SQLITE_BUSY to a retryable DATABASE_UNAVAILABLE database_busy (next action wait) and passes other errors through', () => {
    const path = join(dir, 'e.sqlite');
    const a = openNodeSqlite(path);
    applyPragmas(a);
    a.exec('CREATE TABLE t (x INTEGER) STRICT');
    const b = openNodeSqlite(path);
    b.exec('PRAGMA busy_timeout = 50');
    a.exec('BEGIN IMMEDIATE');

    const busy = (() => {
      try {
        b.prepare('INSERT INTO t VALUES (1)').run();
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(busy).toMatchObject({ appError: { code: 'DATABASE_UNAVAILABLE', retryable: true, nextAction: 'wait', details: { reason: 'database_busy' } } });
    expect(() => b.prepare('SELECT * FROM missing_table').get()).toThrow(/no such table/);
    a.exec('ROLLBACK');
    a.close();
    b.close();
  });
});
