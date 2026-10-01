import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdGen, err, errors, isRelayError, ok, systemClock } from '@relay/contracts';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { openNodeSqlite } from './driver-node-sqlite.js';
import type { FixtureDb } from './testing/fixtures.js';
import { openFixtureDb, seedProject } from './testing/fixtures.js';
import type { Db } from './types.js';
import { createDb, openDb } from './unit-of-work.js';
import { MIGRATIONS } from '../migrations/index.js';

describe('unit of work', () => {
  let f: FixtureDb;

  beforeEach(async () => {
    f = await openFixtureDb();
  });
  afterEach(async () => {
    await f.db.dispose();
  });

  it('commits the callback result', () => {
    const out = f.db.tx('immediate', (r) => {
      r.settings.set('theme', 'dark');
      return 7;
    });

    expect(out).toBe(7);
    expect(f.db.repos.settings.get('theme')).toBe('dark');
  });

  it('rolls back every row when the callback throws', () => {
    const attempt = () =>
      f.db.tx('immediate', (r) => {
        seedProject(f.db, f.clock);
        r.settings.set('theme', 'dark');
        throw new Error('boom');
      });

    expect(attempt).toThrow('boom');
    expect(f.db.repos.projects.list({ includeArchived: true })).toHaveLength(0);
    expect(f.db.repos.settings.get('theme')).toBeUndefined();
  });

  it('surfaces the original error when SQLite already ended the transaction', () => {
    const driver = openNodeSqlite(f.db.path);
    const db = createDb(driver, { clock: f.clock, ids: createIdGen(systemClock, (n) => randomBytes(n)) });

    const attempt = () =>
      db.tx('immediate', () => {
        driver.exec('ROLLBACK'); // simulate SQLite auto-rollback (e.g. SQLITE_FULL)
        throw new Error('original failure');
      });

    expect(attempt).toThrow('original failure');
    expect(driver.inTransaction).toBe(false);
    db.close();
  });

  it('txResult commits an ok Result and rolls back every write of an err Result (returned as is)', () => {
    const committed = f.db.txResult('immediate', (r) => {
      r.settings.set('theme', 'dark');
      return ok(1);
    });
    const failed = f.db.txResult('immediate', (r) => {
      seedProject(f.db, f.clock);
      r.settings.set('theme', 'light');
      r.settings.set('other', 'x');
      return err(errors.conflict({ reason: 'late_failure' }));
    });

    expect(committed).toEqual(ok(1));
    expect(failed.ok ? null : failed.error.details).toEqual({ reason: 'late_failure' });
    expect(f.db.repos.settings.get('theme')).toBe('dark');
    expect(f.db.repos.settings.get('other')).toBeUndefined();
    expect(f.db.repos.projects.list({ includeArchived: true })).toHaveLength(0);
  });

  it('txResult rolls back and rethrows on a throw', () => {
    const attempt = () =>
      f.db.txResult('immediate', (r) => {
        r.settings.set('theme', 'dark');
        throw new Error('boom');
      });

    expect(attempt).toThrow('boom');
    expect(f.db.repos.settings.get('theme')).toBeUndefined();
  });

  it('throws on a nested tx', () => {
    const nested = () => f.db.tx('immediate', () => f.db.tx('immediate', () => 1));

    expect(nested).toThrow(/nested transactions/);
  });

  it('rejects an async callback at compile time', () => {
    const db: Db = f.db;

    // @ts-expect-error — §7.4: no await inside a transaction (NotPromise<T>)
    const typed = (): unknown => db.tx('immediate', async () => Promise.resolve(1));

    const n = db.tx('immediate', () => 1);

    expectTypeOf(n).toEqualTypeOf<number>();
    expect(typeof typed).toBe('function');
  });

  it('maps SQLITE_BUSY on a second connection to a retryable RUNNER_UNAVAILABLE', () => {
    const b = openNodeSqlite(f.db.path);
    b.exec('PRAGMA busy_timeout = 50');
    const dbB = createDb(b, { clock: f.clock, ids: createIdGen(systemClock, (n) => randomBytes(n)) });
    let caught: unknown = null;

    f.db.tx('immediate', (r) => {
      r.settings.set('holder', 'A');
      try {
        dbB.tx('immediate', (rb) => {
          rb.settings.set('writer', 'B');
        });
      } catch (e) {
        caught = e;
      }
    });

    expect(isRelayError(caught)).toBe(true);
    expect(caught).toMatchObject({ appError: { code: 'RUNNER_UNAVAILABLE', retryable: true } });
    expect(f.db.repos.settings.get('writer')).toBeUndefined();
    dbB.close();
  });
});

describe('openDb', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-open-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('opens, migrates, and reopens the same file', async () => {
    const opts = { path: join(dir, 'relay.sqlite'), clock: systemClock, ids: createIdGen(systemClock, (n) => randomBytes(n)), backupsDir: join(dir, 'backups') };

    const first = await openDb(opts);
    first.repos.settings.set('k', { a: 1 });
    first.close();
    const second = await openDb(opts);

    expect(second.repos.settings.get('k')).toEqual({ a: 1 });
    expect(second.schemaVersion()).toBe(MIGRATIONS.length);
    second.close();
  });

  it('closes the connection and rethrows when opening fails', async () => {
    const opts = { path: join(dir, 'missing-dir', 'relay.sqlite'), clock: systemClock, ids: createIdGen(systemClock, (n) => randomBytes(n)), backupsDir: dir };

    await expect(openDb(opts)).rejects.toThrow();
  });
});
