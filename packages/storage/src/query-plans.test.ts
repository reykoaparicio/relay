// EXPLAIN QUERY PLAN of the repo statements the 0002 indexes and the literal active-status fragment exist for
// (improvement review items 1 and 18): each statement is captured as the repo runs it, then explained with the same
// parameters, so a refactor that stops using an index fails here.
import { randomBytes } from 'node:crypto';
import { createIdGen, epochMs, systemClock } from '@relay/contracts';
import type { RunId } from '@relay/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver, SqlParam } from './driver.js';
import { openNodeSqlite } from './driver-node-sqlite.js';
import { applyPragmas } from './pragmas.js';
import { createRepos } from './repos/index.js';
import type { FixtureDb } from './testing/fixtures.js';
import { newId, openFixtureDb, seedProject } from './testing/fixtures.js';
import type { Repos } from './types.js';

interface Captured {
  readonly sql: string;
  readonly params: readonly SqlParam[];
}

describe('query plans (0002 indexes, active-status partial index)', () => {
  let f: FixtureDb;
  let inner: SqlDriver;
  let captured: Captured[];
  let repos: Repos;

  beforeEach(async () => {
    f = await openFixtureDb();
    inner = openNodeSqlite(f.db.path);
    applyPragmas(inner);
    captured = [];
    const driver: SqlDriver = {
      get path() {
        return inner.path;
      },
      get inTransaction() {
        return inner.inTransaction;
      },
      exec: (sql) => { inner.exec(sql); },
      prepare: (sql) => {
        const st = inner.prepare(sql);
        const record = (params: SqlParam[]) => captured.push({ sql, params });
        return {
          run: (...p) => (record(p), st.run(...p)),
          get: (...p) => (record(p), st.get(...p)),
          all: (...p) => (record(p), st.all(...p)),
        };
      },
      close: () => { inner.close(); },
      backupTo: (d) => inner.backupTo(d),
    };
    repos = createRepos(driver, { clock: f.clock, ids: createIdGen(systemClock, (n) => randomBytes(n)), isPidAlive: () => true, inTx: (fn) => fn() });
  });
  afterEach(async () => {
    inner.close();
    await f.db.dispose();
  });

  /** The plan details of the statements `read` executes. */
  const plansOf = (read: () => unknown): string[] => {
    captured = [];
    read();
    return captured.map((c) =>
      inner
        .prepare(`EXPLAIN QUERY PLAN ${c.sql}`)
        .all(...c.params)
        .map((r) => String((r as { detail: unknown }).detail))
        .join(' | '),
    );
  };
  const runId = (): RunId => newId('run');

  it('attempts.listForRun seeks attempts_run_idx in index order (no temp B-tree)', () => {
    const [plan] = plansOf(() => repos.attempts.listForRun(runId()));

    expect(plan).toContain('attempts_run_idx');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('memory events by record use memory_events_record_idx; countRunSnapshots uses run_memory_snapshot_record_idx', () => {
    const project = seedProject(f.db, f.clock);
    const item = f.db.repos.memory.insertRecord(
      { id: newId('memory'), projectId: project.id, type: 'user_rule', status: 'approved', scope: { roles: 'all' }, createdAt: f.clock.now() },
      { id: newId('memoryRevision'), title: 't', content: 'c', sourceRefs: [], author: 'user', createdAt: f.clock.now() },
    );

    const read = plansOf(() => repos.memory.getWithRevisions(item.record.id));
    const events = read.find((p) => p.includes('memory_events'));
    const [count] = plansOf(() => repos.memory.countRunSnapshots(item.record.id));

    expect(events).toContain('memory_events_record_idx');
    expect(events).not.toContain('TEMP B-TREE');
    expect(count).toContain('run_memory_snapshot_record_idx');
  });

  it('events.snapshotBinding seeks run_events_type_idx in every subquery (never scans the log)', () => {
    const [plan] = plansOf(() => repos.events.snapshotBinding(runId(), { resnapshot: 'resnapshot', approvalInvalidated: 'approval_invalidated' }));

    expect(plan?.match(/run_events_type_idx/g)?.length).toBe(4);
    expect(plan).not.toMatch(/SCAN run_events/);
  });

  it('ledger.listForProjectWindow seeks ledger_project_window_idx in (created_at, id) order', () => {
    const [plan] = plansOf(() => repos.ledger.listForProjectWindow(newId('project'), epochMs(0), epochMs(10)));

    expect(plan).toContain('ledger_project_window_idx');
    expect(plan).not.toContain('TEMP B-TREE FOR ORDER BY');
  });

  it('runs.listActive uses the runs_active_idx partial index; findActiveByRoot the unique root index', () => {
    const [active] = plansOf(() => repos.runs.listActive());
    const [root] = plansOf(() => repos.projects.findActiveByRoot('/tmp/x'));

    expect(active).toContain('runs_active_idx');
    expect(root).toContain('projects_root_active_uq');
  });
});
