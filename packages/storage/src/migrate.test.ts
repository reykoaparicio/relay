import { existsSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations/index.js';
import type { Migration } from '../migrations/index.js';
import { openNodeSqlite } from './driver-node-sqlite.js';
import { MigrationChecksumError, MigrationVersionError } from './errors.js';
import { migrate, migrationChecksum } from './migrate.js';
import { applyPragmas } from './pragmas.js';
import { manualClock } from './testing/fixtures.js';
import type { TestDb } from './unit-of-work.js';
import { openTestDb } from './unit-of-work.js';
import { join, dirname } from 'node:path';

const EXTRA: Migration = { version: 2, name: 'extra', sql: 'CREATE TABLE extra_things (id TEXT PRIMARY KEY) STRICT;' };

describe('migrate', () => {
  const open: TestDb[] = [];
  const track = async (p: Promise<TestDb>): Promise<TestDb> => {
    const d = await p;
    open.push(d);
    return d;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((d) => d.dispose()));
  });

  it('brings a fresh DB to the latest version, and re-running is a no-op', async () => {
    const db = await track(openTestDb());
    const driver = openNodeSqlite(db.path);

    const again = await migrate(driver, { clock: manualClock(), backupsDir: join(dirname(db.path), 'b2') });

    expect(db.schemaVersion()).toBe(MIGRATIONS.length);
    expect(again).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length });
    expect(existsSync(join(dirname(db.path), 'b2'))).toBe(false);
    driver.close();
  });

  it('keeps MIGRATIONS contiguous from 1 with no backtick, dollar-brace, or backslash in any sql', () => {
    MIGRATIONS.forEach((m, i) => {
      expect(m.version).toBe(i + 1);
      expect(m.sql).not.toMatch(/[`\\]/);
      expect(m.sql.includes('${')).toBe(false);
    });
  });

  it('refuses a non-contiguous migration list', async () => {
    const driver = openNodeSqlite(':memory:');

    await expect(migrate(driver, { migrations: [EXTRA], clock: manualClock(), backupsDir: '/nonexistent' })).rejects.toThrow(
      /contiguous/,
    );
    driver.close();
  });

  it('fails with MigrationChecksumError when an applied migration differs by one byte', async () => {
    const db = await track(openTestDb());
    const [first] = MIGRATIONS;
    const tampered: Migration[] = first === undefined ? [] : [{ ...first, sql: `${first.sql} ` }];
    const driver = openNodeSqlite(db.path);

    const run = migrate(driver, { migrations: tampered, clock: manualClock(), backupsDir: '/nonexistent' });

    await expect(run).rejects.toBeInstanceOf(MigrationChecksumError);
    expect(migrationChecksum('a')).toMatch(/^[a-f0-9]{64}$/);
    driver.close();
  });

  it('refuses a DB whose version is newer than the app knows', async () => {
    const db = await track(openTestDb({ migrations: [...MIGRATIONS, EXTRA] }));
    const driver = openNodeSqlite(db.path);

    await expect(migrate(driver, { clock: manualClock(), backupsDir: '/nonexistent' })).rejects.toBeInstanceOf(MigrationVersionError);
    driver.close();
  });

  it('takes a pre-migration backup when the DB is non-empty and migrations are pending', async () => {
    const db = await track(openTestDb());
    const driver = openNodeSqlite(db.path);
    applyPragmas(driver);
    const backupsDir = join(dirname(db.path), 'pre');
    const clock = manualClock(Date.UTC(2026, 8, 30, 12, 34, 56));

    const r = await migrate(driver, { migrations: [...MIGRATIONS, EXTRA], clock, backupsDir });

    expect(r).toEqual({ from: 1, to: 2 });
    expect(readdirSync(backupsDir)).toEqual(['20260930-123456-pre-v2']);
    expect(existsSync(join(backupsDir, '20260930-123456-pre-v2', 'relay.sqlite'))).toBe(true);
    driver.close();
  });

  it('does not back up an empty DB and rolls back a failing migration', async () => {
    const driver = openNodeSqlite(':memory:');
    const bad: Migration = { version: 1, name: 'bad', sql: 'CREATE TABLE ok_t (x INTEGER) STRICT; CREATE TABLE ok_t (x INTEGER);' };

    await expect(migrate(driver, { migrations: [bad], clock: manualClock(), backupsDir: '/nonexistent' })).rejects.toThrow(
      /already exists/,
    );
    expect(driver.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'ok_t'").get()).toEqual({ n: 0 });
    expect(driver.inTransaction).toBe(false);
    driver.close();
  });

  it('keeps CHECK (json_valid) working with trusted_schema = OFF', async () => {
    const db = await track(openTestDb());
    const driver = openNodeSqlite(db.path);
    applyPragmas(driver);
    const insert = driver.prepare('INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, 1)');

    expect(driver.prepare('PRAGMA trusted_schema').get()).toEqual({ trusted_schema: 0 });
    expect(() => insert.run('bad', '{not json')).toThrow(/CHECK constraint failed/);
    expect(insert.run('good', '{"a":1}').changes).toBe(1);
    driver.close();
  });
});
