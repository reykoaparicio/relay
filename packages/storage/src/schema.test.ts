import type { ArtifactId, RunId } from '@relay/contracts';
import {
  APPROVAL_DECISIONS,
  ARTIFACT_KINDS,
  ATTEMPT_PURPOSES,
  ATTEMPT_STATES,
  COST_CERTAINTY,
  CREDENTIAL_STORAGE_MODES,
  LEDGER_BUCKETS,
  LEDGER_ENTRY_TYPES,
  LEDGER_SCOPES,
  MEMORY_EVENT_TYPES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  PAUSE_REASONS,
  RUN_STATUSES,
  STEP_STATES,
  workflowVersionViewSchema,
} from '@relay/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver } from './driver.js';
import { openNodeSqlite } from './driver-node-sqlite.js';
import { applyPragmas } from './pragmas.js';
import type { FixtureDb } from './testing/fixtures.js';
import { newId, openFixtureDb, seedAttempt, seedProject, seedRun, seedStep, sha } from './testing/fixtures.js';

/** Every table of 03 §C3 plus the migration bookkeeping table. */
const C3_TABLES = [
  'app_settings',
  'approvals',
  'artifacts',
  'attempts',
  'idempotency_keys',
  'ledger_entries',
  'memory_events',
  'memory_records',
  'memory_revisions',
  'model_catalog',
  'model_profiles',
  'projects',
  'provider_credential_refs',
  'run_config_revisions',
  'run_events',
  'run_input_files',
  'run_memory_snapshot',
  'runner_lease',
  'runs',
  'schema_migrations',
  'step_runs',
  'workflow_versions',
  'workflows',
];

/** Extracts the `CHECK (… col IN (…))` list of a column from the stored DDL. */
function checkList(driver: SqlDriver, table: string, column: string): string[] {
  const row = driver.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
  const re = new RegExp(`CHECK \\((?:${column} IS NULL OR )?${column} IN \\(([^)]*)\\)`);
  const m = re.exec(row.sql);
  if (m === null) {
    throw new Error(`no CHECK list for ${table}.${column}`);
  }
  return (m[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

describe('schema (0001_init)', () => {
  let f: FixtureDb;
  let raw: SqlDriver;

  beforeEach(async () => {
    f = await openFixtureDb();
    raw = openNodeSqlite(f.db.path);
    applyPragmas(raw);
  });
  afterEach(async () => {
    raw.close();
    await f.db.dispose();
  });

  const seedAll = () => {
    const { db, clock } = f;
    const project = seedProject(db, clock);
    const run = seedRun(db, clock, project.id);
    const step = seedStep(db, clock, run.id);
    const attempt = seedAttempt(db, clock, run.id, step.id);
    return { project, run, step, attempt };
  };

  const insertArtifact = (o: { runId: RunId; projectId: string; attemptId: string | null; kind: string; hash: string }): ArtifactId => {
    const id = newId('artifact');
    raw
      .prepare(
        `INSERT INTO artifacts (id, run_id, project_id, attempt_id, kind, rel_path, sha256, size_bytes, media_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'application/json', 1)`,
      )
      .run(id, o.runId, o.projectId, o.attemptId, o.kind, `artifacts/run/${id}`, o.hash);
    return id;
  };

  it('has exactly the C3 table list', () => {
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);

    console.log('tables:', tables.join(', '));
    expect(tables).toEqual(C3_TABLES);
  });

  it('mirrors every contracts enum array in its CHECK list', () => {
    const pairs: [string, string, readonly string[]][] = [
      ['runs', 'status', RUN_STATUSES],
      ['runs', 'pause_reason', PAUSE_REASONS],
      ['step_runs', 'state', STEP_STATES],
      ['attempts', 'purpose', ATTEMPT_PURPOSES],
      ['attempts', 'state', ATTEMPT_STATES],
      ['ledger_entries', 'scope', LEDGER_SCOPES],
      ['ledger_entries', 'type', LEDGER_ENTRY_TYPES],
      ['ledger_entries', 'bucket', LEDGER_BUCKETS],
      ['ledger_entries', 'certainty', COST_CERTAINTY],
      ['artifacts', 'kind', ARTIFACT_KINDS],
      ['approvals', 'decision', APPROVAL_DECISIONS],
      ['memory_records', 'type', MEMORY_TYPES],
      ['memory_records', 'status', MEMORY_STATUSES],
      ['memory_events', 'event', MEMORY_EVENT_TYPES],
      ['provider_credential_refs', 'storage_mode', CREDENTIAL_STORAGE_MODES],
      ['workflow_versions', 'status', workflowVersionViewSchema.shape.status.options],
    ];

    for (const [table, column, expected] of pairs) {
      expect(checkList(raw, table, column), `${table}.${column}`).toEqual([...expected]);
    }
    expect(checkList(raw, 'artifacts', 'kind')).toContain('input_file');
    expect(checkList(raw, 'runs', 'pause_reason')).toHaveLength(14);
  });

  it('aborts UPDATE and DELETE on ledger entries', () => {
    const { run, project } = seedAll();
    f.db.repos.ledger.append([{ scope: 'run', type: 'allowance_set', bucket: 'allowance', deltaMicrousd: 5, runId: run.id, projectId: project.id }]);

    expect(() => { raw.exec('UPDATE ledger_entries SET delta_microusd = 6'); }).toThrow(/ledger_entries are immutable/);
    expect(() => { raw.exec('DELETE FROM ledger_entries'); }).toThrow(/ledger_entries are immutable/);
  });

  it('aborts UPDATE of a validated workflow version', () => {
    seedAll();

    expect(() => { raw.exec("UPDATE workflow_versions SET content_hash = 'x'"); }).toThrow(/immutable once validated/);
  });

  it('keeps a decided approval immutable', () => {
    const { run, step, project } = seedAll();
    const plan = insertArtifact({ runId: run.id, projectId: project.id, attemptId: null, kind: 'plan', hash: sha('1') });
    const a = f.db.repos.approvals.insert({
      id: newId('approval'),
      runId: run.id,
      stepRunId: step.id,
      planArtifactId: plan,
      planHash: sha('2'),
      contextHash: sha('3'),
      fileScope: [],
      requestedPermissions: {},
      createdAt: f.clock.now(),
    });
    f.db.repos.approvals.decide(a.id, 'approved', null, f.clock.now());

    expect(() => raw.prepare("UPDATE approvals SET decision = 'rejected' WHERE id = ?").run(a.id)).toThrow(/approval decision is immutable/);
    expect(() => raw.prepare("UPDATE approvals SET plan_hash = 'x' WHERE id = ?").run(a.id)).toThrow(/immutable/);
    expect(f.db.repos.approvals.invalidate(a.id, 'plan_changed', f.clock.now())).toBe(true);
  });

  it('keeps memory revisions, run events, and config revisions immutable', () => {
    const { project, run } = seedAll();
    f.db.repos.memory.insertRecord(
      { id: newId('memory'), projectId: project.id, type: 'user_rule', status: 'approved', scope: { roles: 'all' }, createdAt: f.clock.now() },
      { id: newId('memoryRevision'), title: 'T', content: 'C', sourceRefs: [], author: 'user', createdAt: f.clock.now() },
    );
    f.db.repos.events.append(run.id, 'run.created', {});
    raw
      .prepare(
        `INSERT INTO run_config_revisions (run_id, revision, step_key, previous_profile_json, profile_snapshot_json, reason, created_at)
         VALUES (?, 1, 'review', '{}', '{}', 'user_switch', 1)`,
      )
      .run(run.id);

    expect(() => { raw.exec("UPDATE memory_revisions SET title = 'x'"); }).toThrow(/memory revisions are immutable/);
    expect(() => { raw.exec("UPDATE run_events SET type = 'x'"); }).toThrow(/run_events are immutable/);
    expect(() => { raw.exec("UPDATE run_config_revisions SET reason = 'x'"); }).toThrow(/config revisions are immutable/);
  });

  it('aborts DELETE of run events, memory revisions, artifacts, and decided approvals (B5)', () => {
    const { project, run, step } = seedAll();
    f.db.repos.memory.insertRecord(
      { id: newId('memory'), projectId: project.id, type: 'user_rule', status: 'approved', scope: { roles: 'all' }, createdAt: f.clock.now() },
      { id: newId('memoryRevision'), title: 'T', content: 'C', sourceRefs: [], author: 'user', createdAt: f.clock.now() },
    );
    f.db.repos.events.append(run.id, 'run.created', {});
    const plan = insertArtifact({ runId: run.id, projectId: project.id, attemptId: null, kind: 'plan', hash: sha('1') });
    const approval = (): ReturnType<typeof f.db.repos.approvals.insert> =>
      f.db.repos.approvals.insert({
        id: newId('approval'),
        runId: run.id,
        stepRunId: step.id,
        planArtifactId: plan,
        planHash: sha('2'),
        contextHash: sha('3'),
        fileScope: [],
        requestedPermissions: {},
        createdAt: f.clock.now(),
      });
    const decided = approval();
    f.db.repos.approvals.decide(decided.id, 'approved', null, f.clock.now());
    const pending = approval();

    expect(() => { raw.exec('DELETE FROM run_events'); }).toThrow(/run_events are immutable/);
    expect(() => { raw.exec('DELETE FROM memory_revisions'); }).toThrow(/memory revisions are never deleted/);
    expect(() => raw.prepare('DELETE FROM artifacts WHERE id = ?').run(plan)).toThrow(/artifacts are never deleted/);
    expect(() => raw.prepare('DELETE FROM approvals WHERE id = ?').run(decided.id)).toThrow(/decided approvals are never deleted/);
    // An undecided approval carries no audit decision and may still be removed.
    expect(raw.prepare('DELETE FROM approvals WHERE id = ?').run(pending.id).changes).toBe(1);
    expect(raw.prepare('SELECT count(*) AS n FROM run_events').get()).toEqual({ n: 1 });
    expect(raw.prepare('SELECT count(*) AS n FROM memory_revisions').get()).toEqual({ n: 1 });
  });

  it('accepts the history_purged memory event (0b)', () => {
    const { project } = seedAll();
    const m = f.db.repos.memory.insertRecord(
      { id: newId('memory'), projectId: project.id, type: 'user_rule', status: 'approved', scope: { roles: 'all' }, createdAt: f.clock.now() },
      { id: newId('memoryRevision'), title: 'T', content: 'C', sourceRefs: [], author: 'user', createdAt: f.clock.now() },
    );

    const e = f.db.repos.memory.recordEvent({ recordId: m.record.id, event: 'history_purged', revision: 1, actor: 'user', createdAt: f.clock.now() });

    expect(e.event).toBe('history_purged');
  });

  it('enforces the runs status CHECKs', () => {
    const { run } = seedAll();
    const set = (status: string, reason: string | null, ended: number | null) => () =>
      raw.prepare('UPDATE runs SET status = ?, pause_reason = ?, ended_at = ? WHERE id = ?').run(status, reason, ended, run.id);

    expect(set('completed', null, null)).toThrow(/CHECK constraint failed/);
    expect(set('paused', null, null)).toThrow(/CHECK constraint failed/);
    expect(set('running', 'user', null)).toThrow(/CHECK constraint failed/);
    expect(set('paused', 'coffee_break', null)).toThrow(/CHECK constraint failed/);
    expect(set('paused', 'user', null)().changes).toBe(1);
    expect(set('completed', null, 5)().changes).toBe(1);
  });

  it('enforces the ledger scope CHECKs', () => {
    const { run, project } = seedAll();
    const insert = (scope: string, runId: string | null, projectId: string | null) => () =>
      raw
        .prepare(
          `INSERT INTO ledger_entries (id, scope, run_id, project_id, type, bucket, delta_microusd, group_id, created_at)
           VALUES (?, ?, ?, ?, 'reserve', 'reserved', 1, 'g', 1)`,
        )
        .run(newId('ledger'), scope, runId, projectId);

    expect(insert('run', run.id, null)).toThrow(/CHECK constraint failed/);
    expect(insert('setup', run.id, project.id)).toThrow(/CHECK constraint failed/);
    expect(insert('setup', null, null)().changes).toBe(1);
    expect(insert('run', run.id, project.id)().changes).toBe(1);
  });

  it('rejects an idempotency result over 2048 bytes', () => {
    const insert = raw.prepare('INSERT INTO idempotency_keys (op, key, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, 1)');

    expect(() => insert.run('op', 'k1', 'h', JSON.stringify({ pad: 'x'.repeat(2100) }))).toThrow(/CHECK constraint failed/);
    expect(insert.run('op', 'k2', 'h', '{"ids":{}}').changes).toBe(1);
  });

  it('accepts step rows differing only in retry_index and rejects exact duplicates', () => {
    const { run } = seedAll();
    const insert = (retry: number) => () =>
      raw
        .prepare(
          `INSERT INTO step_runs (id, run_id, step_key, ordinal, revision_index, retry_index, state, created_at, updated_at)
           VALUES (?, ?, 'plan', 2, 0, ?, 'pending', 1, 1)`,
        )
        .run(newId('stepRun'), run.id, retry);

    expect(insert(0)().changes).toBe(1);
    expect(insert(1)().changes).toBe(1);
    expect(insert(1)).toThrow(/UNIQUE constraint failed/);
  });

  it('keys attempt artifacts on (attempt, kind, sha256) and input files on (run, sha256)', () => {
    const { run, project, attempt } = seedAll();
    const h = sha('d');

    insertArtifact({ runId: run.id, projectId: project.id, attemptId: attempt.id, kind: 'raw_response', hash: h });
    insertArtifact({ runId: run.id, projectId: project.id, attemptId: attempt.id, kind: 'findings', hash: h });
    insertArtifact({ runId: run.id, projectId: project.id, attemptId: null, kind: 'input_file', hash: sha('e') });

    expect(() => insertArtifact({ runId: run.id, projectId: project.id, attemptId: attempt.id, kind: 'findings', hash: h })).toThrow(
      /UNIQUE constraint failed/,
    );
    expect(() => insertArtifact({ runId: run.id, projectId: project.id, attemptId: null, kind: 'input_file', hash: sha('e') })).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('allows setting purged_at but not changing artifact content columns', () => {
    const { run, project } = seedAll();
    const id = insertArtifact({ runId: run.id, projectId: project.id, attemptId: null, kind: 'report', hash: sha('9') });

    expect(raw.prepare('UPDATE artifacts SET purged_at = 5 WHERE id = ?').run(id).changes).toBe(1);
    expect(() => raw.prepare("UPDATE artifacts SET sha256 = 'x' WHERE id = ?").run(id)).toThrow(/artifact content is immutable/);
  });

  it('raises on a foreign key violation', () => {
    expect(() =>
      raw
        .prepare(
          `INSERT INTO step_runs (id, run_id, step_key, ordinal, state, created_at, updated_at)
           VALUES (?, 'run_missing', 'plan', 1, 'pending', 1, 1)`,
        )
        .run(newId('stepRun')),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});
