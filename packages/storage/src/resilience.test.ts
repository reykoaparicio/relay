// E2 database / backup resilience: boot-time busy retry, distinct fatal open errors, WAL-inclusive size, atomic and
// rolling backups, and the runner-independent restore.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_UNAVAILABLE_MESSAGES, createIdGen, epochMs, fatalInfoOf, isRelayError, systemClock } from '@relay/contracts';
import type { Clock } from '@relay/contracts';
import { AUTO_BACKUP_KEEP, autoBackup, createBackup, listBackups, pruneAutoBackups, restoreLatestBackup } from './backup.js';
import { openNodeSqlite } from './driver-node-sqlite.js';
import { mapOpenError } from './errors.js';
import { MigrationChecksumError, MigrationVersionError } from './errors.js';
import { openDb } from './unit-of-work.js';
import type { OpenDbOptions } from './unit-of-work.js';

const PREFIX = 'relay-e2-res-';
const created = new Set<string>();

/** Guarded delete: only directories this file created under the OS temp dir with {@link PREFIX}. */
async function removeOwned(dir: string): Promise<void> {
  const tmp = await realpath(tmpdir());
  if (!created.has(dir) || !dir.startsWith(`${tmp}${sep}${PREFIX}`)) throw new Error(`refusing to remove ${dir}`);
  created.delete(dir);
  await rm(dir, { recursive: true, force: true });
}

function manual(start = Date.UTC(2026, 9, 1, 12, 0, 0)): Clock & { set(ms: number): void; advance(ms: number): void } {
  let now = start;
  return {
    now: () => epochMs(now),
    set: (ms: number) => {
      now = ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const errorOf = async (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

describe('storage resilience (E2)', () => {
  let dir: string;
  let opts: OpenDbOptions;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), PREFIX)));
    created.add(dir);
    opts = { path: join(dir, 'relay.sqlite'), clock: systemClock, ids: createIdGen(systemClock, (n) => randomBytes(n)), backupsDir: join(dir, 'backups'), busyRetryDelaysMs: [] };
  });
  afterEach(async () => {
    chmodSync(dir, 0o755);
    await removeOwned(dir);
  });

  it('the guarded delete refuses the temp dir itself, its parent, home and /', async () => {
    for (const p of [tmpdir(), join(tmpdir(), '..'), process.env['HOME'] ?? '/Users', '/']) await expect(removeOwned(p)).rejects.toThrow(/refusing/);
  });

  describe('openDb at boot', () => {
    it('#1: a lock held at boot is retried with backoff and the open succeeds once it is released', async () => {
      (await openDb(opts)).close();
      const holder = openNodeSqlite(opts.path);
      holder.exec('BEGIN IMMEDIATE');
      const retries: number[] = [];
      setTimeout(() => {
        holder.exec('ROLLBACK');
      }, 250);

      const db = await openDb({ ...opts, busyRetryDelaysMs: [100, 100, 100, 100, 100, 100], onBusyRetry: (n) => retries.push(n) });

      expect(retries.length).toBeGreaterThan(0);
      expect(db.schemaVersion()).toBeGreaterThan(0);
      db.close();
      holder.close();
    });

    it('#1: a lock that outlasts every retry fails with DATABASE_UNAVAILABLE database_busy (retryable, restart_runner), not RUNNER_UNAVAILABLE', async () => {
      (await openDb(opts)).close();
      const holder = openNodeSqlite(opts.path);
      holder.exec('BEGIN IMMEDIATE');

      const e = await errorOf(openDb({ ...opts, busyRetryDelaysMs: [10, 10] }));

      expect(e).toMatchObject({ appError: { code: 'DATABASE_UNAVAILABLE', retryable: true, nextAction: 'restart_runner', details: { reason: 'database_busy', attempts: 3 } } });
      expect(fatalInfoOf(e)).toEqual({ code: 'DATABASE_UNAVAILABLE', reason: 'database_busy', message: DATABASE_UNAVAILABLE_MESSAGES.database_busy });
      holder.exec('ROLLBACK');
      holder.close();
    });

    it('#3: a database from a newer schema → schema_too_new (was INTERNAL)', async () => {
      const db = await openDb(opts);
      db.tx('immediate', () => undefined);
      db.close();
      const raw = openNodeSqlite(opts.path);
      raw.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, ?, ?, 0)').run('future', 'x');
      raw.close();

      const e = await errorOf(openDb(opts));

      expect(isRelayError(e) && e.appError).toMatchObject({ code: 'DATABASE_UNAVAILABLE', retryable: false, details: { reason: 'schema_too_new' },
        userMessage: DATABASE_UNAVAILABLE_MESSAGES.schema_too_new });
      expect(isRelayError(e) && e.cause).toBeInstanceOf(MigrationVersionError);
    });

    it('#3: a garbage file at open → db_corrupt, before the integrity check', async () => {
      writeFileSync(opts.path, 'definitely not a sqlite database '.repeat(300));

      const e = await errorOf(openDb(opts));

      expect(fatalInfoOf(e)).toMatchObject({ code: 'DATABASE_UNAVAILABLE', reason: 'db_corrupt' });
    });

    it('#3: a write-protected database file → db_readonly at open (not on the first write)', async () => {
      (await openDb(opts)).close();
      chmodSync(opts.path, 0o444);

      const e = await errorOf(openDb(opts));

      chmodSync(opts.path, 0o644);
      expect(fatalInfoOf(e)).toMatchObject({ code: 'DATABASE_UNAVAILABLE', reason: 'db_readonly' });
    });

    it('#3: an unopenable path → db_cannot_open; checksum mismatch and disk full map to their own reasons', async () => {
      const e = await errorOf(openDb({ ...opts, path: join(dir, 'missing', 'relay.sqlite') }));

      expect(fatalInfoOf(e)).toMatchObject({ code: 'DATABASE_UNAVAILABLE', reason: 'db_cannot_open' });
      expect(fatalInfoOf(mapOpenError(new MigrationChecksumError(1)))).toMatchObject({ reason: 'migration_checksum_mismatch' });
      expect(fatalInfoOf(mapOpenError(Object.assign(new Error('full'), { errcode: 13 })))).toMatchObject({ reason: 'disk_full' });
      expect(fatalInfoOf(mapOpenError(Object.assign(new Error('x'), { code: 'ENOSPC' })))).toMatchObject({ reason: 'disk_full' });
      expect(fatalInfoOf(new Error('raw sqlite text /Users/me'))).toEqual({ code: 'INTERNAL', message: 'Something went wrong inside Relay.' });
    });
  });

  it('#5: sizeBytes counts the WAL', async () => {
    const db = await openDb(opts);
    db.tx('immediate', (r) => {
      r.settings.set('big', { s: 'x'.repeat(200_000) });
    });
    const main = readFileSync(opts.path).byteLength;
    const wal = readFileSync(`${opts.path}-wal`).byteLength;

    expect(wal).toBeGreaterThan(0);
    expect(db.sizeBytes()).toBe(main + wal);
    db.close();
  });

  describe('backups', () => {
    it('#4: a failed backup leaves no directory (written as *.partial, removed on failure)', async () => {
      const userData = join(dir, 'ud');
      const failing = { backupTo: (): Promise<void> => Promise.reject(new Error('disk gone')) };

      await expect(createBackup({ db: failing, userDataDir: userData, clock: manual() })).rejects.toThrow('disk gone');

      expect(readdirSync(join(userData, 'backups'))).toEqual([]);
    });

    it('#4: a successful backup is renamed from *.partial and lists as complete; a manifest-less dir is ignored', async () => {
      const db = await openDb(opts);
      const userData = join(dir, 'ud');
      mkdirSync(join(userData, 'backups', '20200101-000000'), { recursive: true });
      writeFileSync(join(userData, 'backups', '20200101-000000', 'relay.sqlite'), 'half');

      const b = await createBackup({ db, userDataDir: userData, clock: manual() });

      expect(b.dir.endsWith('20261001-120000')).toBe(true);
      expect(readdirSync(join(userData, 'backups')).sort()).toEqual(['20200101-000000', '20261001-120000']);
      expect((await listBackups(join(userData, 'backups'))).map((x) => [x.name, x.kind])).toEqual([['20261001-120000', 'manual']]);
      db.close();
    });

    it('#4: automatic backups are daily, DB-only, and pruned to the newest 5; manual backups are never pruned', async () => {
      const clock = manual();
      const db = await openDb({ ...opts, clock });
      const userData = join(dir, 'ud');
      const backupsDir = join(userData, 'backups');
      await createBackup({ db, userDataDir: userData, clock });
      const made: (string | null)[] = [];
      for (let day = 0; day < 8; day += 1) {
        made.push((await autoBackup({ db, userDataDir: userData, backupsDir, clock }))?.dir ?? null);
        made.push((await autoBackup({ db, userDataDir: userData, backupsDir, clock }))?.dir ?? null); // same day: not due
        clock.advance(24 * 60 * 60 * 1_000 + 1);
      }
      const list = await listBackups(backupsDir);

      expect(made.filter((m) => m !== null)).toHaveLength(8);
      expect(list.filter((b) => b.kind === 'auto')).toHaveLength(AUTO_BACKUP_KEEP);
      expect(list.filter((b) => b.kind === 'manual')).toHaveLength(1);
      expect(list.find((b) => b.kind === 'auto')?.name.endsWith('-auto')).toBe(true);
      expect(readdirSync(list[0]?.dir ?? '').sort()).toEqual(['manifest.json', 'relay.sqlite']);
      db.close();
    });

    it('#4: Db.autoBackup writes to backups-auto/ next to the backups dir of openDb, and stale *.partial dirs are pruned', async () => {
      const clock = manual();
      const db = await openDb({ ...opts, clock });
      const autoDir = join(dir, 'backups-auto');
      const stale = join(autoDir, '20200101-000000-auto.partial');
      mkdirSync(stale, { recursive: true });
      utimesSync(stale, new Date(2020, 0, 1), new Date(2020, 0, 1));

      const first = await db.autoBackup();
      const second = await db.autoBackup();
      const forced = await db.autoBackup({ force: true });

      expect(first?.dir.startsWith(`${autoDir}${sep}`)).toBe(true);
      expect(existsSync(opts.backupsDir) ? readdirSync(opts.backupsDir) : []).toEqual([]); // manual backups dir untouched
      expect(second).toBeNull();
      expect(forced).not.toBeNull();
      expect(existsSync(stale)).toBe(false);
      expect(await pruneAutoBackups(autoDir, clock.now())).toEqual([]);
      db.close();
    });

    it('#4: restoreLatestBackup works when the live DB is corrupt: newest healthy backup, old files moved aside', async () => {
      const clock = manual();
      const db = await openDb({ ...opts, clock });
      db.tx('immediate', (r) => {
        r.settings.set('marker', 'from-backup');
      });
      const userData = dir;
      await createBackup({ db, userDataDir: userData, clock });
      clock.advance(60_000);
      const newest = await db.autoBackup({ force: true }); // backups-auto/ is searched too
      if (newest === null) throw new Error('no automatic backup');
      writeFileSync(join(newest.dir, 'relay.sqlite'), 'damaged backup'); // the newest (automatic) backup is damaged → skipped
      db.close();
      writeFileSync(opts.path, 'corrupted live database '.repeat(100));

      const res = await restoreLatestBackup({ userDataDir: userData, clock });

      expect(res?.restoredFrom.endsWith('20261001-120000')).toBe(true);
      expect(res?.previousMovedTo).not.toBeNull();
      expect(readFileSync(join(res?.previousMovedTo ?? '', 'relay.sqlite'), 'utf8')).toContain('corrupted live');
      const reopened = await openDb({ ...opts, clock });
      expect(reopened.repos.settings.get('marker')).toBe('from-backup');
      reopened.close();
    });

    it('#4: restoreLatestBackup with no usable backup changes nothing', async () => {
      writeFileSync(opts.path, 'live');

      expect(await restoreLatestBackup({ userDataDir: dir, clock: manual() })).toBeNull();
      expect(readFileSync(opts.path, 'utf8')).toBe('live');
    });
  });
});
