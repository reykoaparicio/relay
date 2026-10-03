import { existsSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations/index.js';
import type { Migration } from '../migrations/index.js';
import { openNodeSqlite } from './driver-node-sqlite.js';
import { MigrationChecksumError, MigrationVersionError } from './errors.js';
import { mapCredentialRef } from './mappers.js';
import { migrate, migrationChecksum } from './migrate.js';
import { applyPragmas } from './pragmas.js';
import { manualClock } from './testing/fixtures.js';
import type { TestDb } from './unit-of-work.js';
import { openTestDb } from './unit-of-work.js';
import { join, dirname } from 'node:path';

const EXTRA: Migration = { version: MIGRATIONS.length + 1, name: 'extra', sql: 'CREATE TABLE extra_things (id TEXT PRIMARY KEY) STRICT;' };

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

    const pre = `20260930-123456-pre-v${String(EXTRA.version)}`;
    expect(r).toEqual({ from: MIGRATIONS.length, to: EXTRA.version });
    expect(readdirSync(backupsDir)).toEqual([pre]);
    expect(existsSync(join(backupsDir, pre, 'relay.sqlite'))).toBe(true);
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

  it('0004 adds provider_credential_refs.last_test_source: an older test result keeps a null source; the CHECK holds', async () => {
    const db = await track(openTestDb({ migrations: MIGRATIONS.slice(0, 3) }));
    const driver = openNodeSqlite(db.path);
    applyPragmas(driver);
    driver.prepare(`INSERT INTO provider_credential_refs (id, provider_id, storage_mode, vault_file, redacted_label, created_at, updated_at,
      last_test_at, last_test_ok, last_test_code) VALUES ('crd_01J9ZZZZZZZZZZZZZZZZZZZZZ0', 'anthropic', 'session', NULL, 'sk-…', 1, 1, 5, 0, 'AUTH_REQUIRED')`).run();

    const r = await migrate(driver, { clock: manualClock(), backupsDir: join(dirname(db.path), 'pre4') });

    expect(r).toEqual({ from: 3, to: MIGRATIONS.length });
    expect(mapCredentialRef(driver.prepare('SELECT * FROM provider_credential_refs').get()).lastTest).toEqual({ at: 5, ok: false, code: 'AUTH_REQUIRED', source: null });
    expect(() => driver.prepare("UPDATE provider_credential_refs SET last_test_source = 'bogus'").run()).toThrow(/CHECK constraint failed/);
    driver.close();
  });

  it('0005 adds attempts.outcome_uncertain / may_not_have_been_charged: NOT NULL DEFAULT 0 (older attempts read false) with 0/1 CHECKs', async () => {
    const db = await track(openTestDb({ migrations: MIGRATIONS.slice(0, 4) }));
    const driver = openNodeSqlite(db.path);
    applyPragmas(driver);
    const before = driver.prepare("SELECT name FROM pragma_table_info('attempts')").all().map((r) => (r as { name: string }).name);

    const r = await migrate(driver, { clock: manualClock(), backupsDir: join(dirname(db.path), 'pre5') });

    expect(r).toEqual({ from: 4, to: MIGRATIONS.length });
    expect(before).not.toContain('outcome_uncertain');
    const cols = driver.prepare("SELECT name, dflt_value, \"notnull\" AS nn FROM pragma_table_info('attempts') WHERE name IN ('outcome_uncertain', 'may_not_have_been_charged') ORDER BY cid").all();
    expect(cols).toEqual([{ name: 'outcome_uncertain', dflt_value: '0', nn: 1 }, { name: 'may_not_have_been_charged', dflt_value: '0', nn: 1 }]);
    const ddl = (driver.prepare("SELECT sql FROM sqlite_master WHERE name = 'attempts'").get() as { sql: string }).sql;
    expect(ddl).toContain('CHECK (outcome_uncertain IN (0,1))');
    expect(ddl).toContain('CHECK (may_not_have_been_charged IN (0,1))');
    driver.close();
  });

  it('0006 adds attempts.lookup_done (NOT NULL DEFAULT 0, 0/1) and run_config_revisions.max_output_tokens (NULL or > 0)', async () => {
    const db = await track(openTestDb({ migrations: MIGRATIONS.slice(0, 5) }));
    const driver = openNodeSqlite(db.path);
    applyPragmas(driver);

    const r = await migrate(driver, { clock: manualClock(), backupsDir: join(dirname(db.path), 'pre6') });

    expect(r).toEqual({ from: 5, to: MIGRATIONS.length });
    const col = (table: string, name: string) =>
      driver.prepare(`SELECT name, dflt_value, "notnull" AS nn FROM pragma_table_info('${table}') WHERE name = ?`).get(name);
    expect(col('attempts', 'lookup_done')).toEqual({ name: 'lookup_done', dflt_value: '0', nn: 1 });
    expect(col('run_config_revisions', 'max_output_tokens')).toEqual({ name: 'max_output_tokens', dflt_value: null, nn: 0 });
    const ddl = (name: string) => (driver.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string }).sql;
    expect(ddl('attempts')).toContain('CHECK (lookup_done IN (0,1))');
    expect(ddl('run_config_revisions')).toContain('CHECK (max_output_tokens IS NULL OR max_output_tokens > 0)');
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
