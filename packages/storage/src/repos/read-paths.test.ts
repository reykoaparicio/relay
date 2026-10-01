// Batched / single-statement read paths (improvement review items 2, 3, 4, 7, 11, 14, 19): each is checked against
// the per-row reads it replaces over a varied fixture (retries, revisions, overrun, unknown, mixed certainty).
import type { AttemptId, CostCertainty, ProjectId, RunId, StepKey } from '@relay/contracts';
import { epochMs } from '@relay/contracts';
import { randomBytes } from 'node:crypto';
import { createIdGen, systemClock } from '@relay/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver, SqlStatement } from '../driver.js';
import { openNodeSqlite } from '../driver-node-sqlite.js';
import { applyPragmas } from '../pragmas.js';
import type { FixtureDb } from '../testing/fixtures.js';
import { newId, openFixtureDb, seedAttempt, seedProject, seedRun, seedStep, sha } from '../testing/fixtures.js';
import type { LedgerEntryInsert, LedgerEntryRow, Repos, RunRow, StepRow } from '../types.js';
import { createRepos } from './index.js';

/** Counts statement executions of a driver. */
function countingRepos(f: FixtureDb): { repos: Repos; count: () => number; reset: () => void; close: () => void } {
  const inner = openNodeSqlite(f.db.path);
  applyPragmas(inner);
  let n = 0;
  const wrap = (s: SqlStatement): SqlStatement => ({
    run: (...p) => ((n += 1), s.run(...p)),
    get: (...p) => ((n += 1), s.get(...p)),
    all: (...p) => ((n += 1), s.all(...p)),
  });
  const driver: SqlDriver = {
    get path() {
      return inner.path;
    },
    get inTransaction() {
      return inner.inTransaction;
    },
    exec: (sql) => { inner.exec(sql); },
    prepare: (sql) => wrap(inner.prepare(sql)),
    close: () => { inner.close(); },
    backupTo: (d) => inner.backupTo(d),
  };
  const repos = createRepos(driver, { clock: f.clock, ids: createIdGen(systemClock, (k) => randomBytes(k)), isPidAlive: () => true, inTx: (fn) => fn() });
  return { repos, count: () => n, reset: () => (n = 0), close: () => { inner.close(); } };
}

/** The engine's `latestPerKey` + done count, restated independently of the SQL under test. */
function progressOf(steps: readonly StepRow[]): { done: number; total: number } {
  const latest = new Map<string, StepRow>();
  for (const s of steps) {
    const cur = latest.get(s.stepKey);
    if (cur === undefined || s.revisionIndex > cur.revisionIndex || (s.revisionIndex === cur.revisionIndex && s.retryIndex > cur.retryIndex)) latest.set(s.stepKey, s);
  }
  const rows = [...latest.values()];
  return { done: rows.filter((s) => s.state === 'succeeded' || s.state === 'skipped').length, total: rows.length };
}

describe('batched read paths', () => {
  let f: FixtureDb;

  beforeEach(async () => {
    f = await openFixtureDb();
  });
  afterEach(async () => {
    await f.db.dispose();
  });

  const entry = (run: RunRow, e: Pick<LedgerEntryInsert, 'type' | 'bucket' | 'deltaMicrousd'> & Partial<LedgerEntryInsert>): LedgerEntryInsert => ({
    scope: 'run', runId: run.id, projectId: run.projectId, ...e,
  });
  const settled = (run: RunRow, attemptId: AttemptId, n: number, settle: number, certainty: CostCertainty): LedgerEntryInsert[] => [
    entry(run, { type: 'release', bucket: 'reserved', deltaMicrousd: -n, attemptId }),
    entry(run, { type: 'settle', bucket: 'settled', deltaMicrousd: settle, attemptId, certainty }),
  ];

  /** Five runs: overrun + retries + a revision, unknown liability + mixed certainty, empty, skipped steps, paused. */
  const varied = (projectId: ProjectId): RunRow[] => {
    const { db, clock } = f;
    const l = db.repos.ledger;
    const runs: RunRow[] = [];
    // A: review failed then retried (succeeded); plan revised (latest pending); a1 overran (1500 > 1000).
    clock.advance(10);
    const a = seedRun(db, clock, projectId);
    runs.push(a);
    const review = seedStep(db, clock, a.id, { stepKey: 'review', ordinal: 1, state: 'failed' });
    const retry = db.repos.steps.insertRetry(review, { id: newId('stepRun'), state: 'succeeded', createdAt: clock.now() });
    seedStep(db, clock, a.id, { stepKey: 'plan', ordinal: 2, state: 'succeeded' });
    seedStep(db, clock, a.id, { stepKey: 'plan', ordinal: 2, revisionIndex: 1, state: 'pending' });
    const a1 = seedAttempt(db, clock, a.id, review.id, { state: 'succeeded' });
    const a2 = seedAttempt(db, clock, a.id, retry.id, { state: 'succeeded' });
    l.append([entry(a, { type: 'allowance_set', bucket: 'allowance', deltaMicrousd: 3_000_000 })]);
    l.append([entry(a, { type: 'reserve', bucket: 'reserved', deltaMicrousd: 1000, attemptId: a1.id })]);
    l.append(settled(a, a1.id, 1000, 1500, 'calculated'));
    l.append([entry(a, { type: 'reserve', bucket: 'reserved', deltaMicrousd: 900, attemptId: a2.id })]);
    l.append(settled(a, a2.id, 900, 800, 'reported'));
    // B: an unknown liability and mixed certainties; one reservation still open.
    clock.advance(10);
    const b = seedRun(db, clock, projectId);
    runs.push(b);
    const bs = seedStep(db, clock, b.id, { stepKey: 'review', ordinal: 1, state: 'unknown' });
    const b1 = seedAttempt(db, clock, b.id, bs.id, { state: 'unknown' });
    const b2 = seedAttempt(db, clock, b.id, bs.id, { state: 'succeeded' });
    const b3 = seedAttempt(db, clock, b.id, bs.id, { state: 'reserved' });
    l.append([entry(b, { type: 'allowance_set', bucket: 'allowance', deltaMicrousd: 2_000 })]);
    l.append([entry(b, { type: 'reserve', bucket: 'reserved', deltaMicrousd: 1000, attemptId: b1.id })]);
    l.append([
      entry(b, { type: 'move_to_unknown', bucket: 'reserved', deltaMicrousd: -1000, attemptId: b1.id }),
      entry(b, { type: 'move_to_unknown', bucket: 'unknown', deltaMicrousd: 1000, attemptId: b1.id, certainty: 'unknown' }),
    ]);
    l.append([entry(b, { type: 'reserve', bucket: 'reserved', deltaMicrousd: 500, attemptId: b2.id })]);
    l.append([
      entry(b, { type: 'release', bucket: 'reserved', deltaMicrousd: -500, attemptId: b2.id }),
      entry(b, { type: 'settle', bucket: 'settled', deltaMicrousd: 300, attemptId: b2.id, certainty: 'estimated' }),
      entry(b, { type: 'settle', bucket: 'settled', deltaMicrousd: 100, attemptId: b2.id, certainty: 'reported' }),
    ]);
    l.append([entry(b, { type: 'reserve', bucket: 'reserved', deltaMicrousd: 700, attemptId: b3.id })]);
    // C: nothing at all (no steps, no ledger).
    clock.advance(10);
    runs.push(seedRun(db, clock, projectId));
    // D: skipped steps count as done.
    clock.advance(10);
    const d = seedRun(db, clock, projectId);
    runs.push(d);
    seedStep(db, clock, d.id, { stepKey: 'review', ordinal: 1, state: 'skipped' });
    seedStep(db, clock, d.id, { stepKey: 'plan', ordinal: 2, state: 'succeeded' });
    seedStep(db, clock, d.id, { stepKey: 'finalize', ordinal: 3, state: 'ready' });
    l.append([entry(d, { type: 'allowance_set', bucket: 'allowance', deltaMicrousd: 1_000 })]);
    // E: paused for the project budget.
    clock.advance(10);
    const e = seedRun(db, clock, projectId);
    runs.push(e);
    db.repos.runs.updateStatus(e.id, ['queued'], 'paused', { pauseReason: 'budget_project' });
    return runs;
  };

  it('listSummaries agrees with the per-run inspector projection for every row (overrun, unknown, mixed certainty, retries) in 4 statements', () => {
    const p = seedProject(f.db, f.clock);
    const runs = varied(p.id);
    const c = countingRepos(f);

    c.reset();
    const page = c.repos.runs.listSummaries({ projectId: p.id, limit: 50 });
    const statements = c.count();

    if (!page.ok) throw new Error(page.error.code);
    expect(statements).toBe(4);
    expect(page.value.items.map((s) => s.run.id)).toEqual([...runs].reverse().map((r) => r.id)); // created_desc
    for (const s of page.value.items) {
      const proj = f.db.repos.runs.getInspectorProjection(s.run.id);
      expect(s.run, s.run.id).toEqual(proj.run);
      expect(s.workflow).toEqual(proj.workflow);
      expect(s.balances).toEqual(proj.balances);
      expect(s.settledByCertainty).toEqual(proj.settledByCertainty);
      expect(s.attemptsOverran).toBe(proj.attemptsOverran);
      expect(s.stepProgress).toEqual(progressOf(proj.steps));
      expect(f.db.repos.ledger.runCosts(s.run.id)).toEqual({ balances: proj.balances, settledByCertainty: proj.settledByCertainty, attemptsOverran: proj.attemptsOverran });
    }
    const [a, b, empty, d] = runs.map((r) => page.value.items.find((s) => s.run.id === r.id));
    expect(a?.attemptsOverran).toBe(true);
    expect(a?.stepProgress).toEqual({ done: 1, total: 2 }); // review retry succeeded, plan revision pending
    expect(b?.balances).toEqual({ L: 2000, C: 400, R: 700, U: 1000 });
    expect(b?.settledByCertainty).toEqual({ reported: 100, calculated: 0, estimated: 300, unknown: 0 });
    expect(b?.attemptsOverran).toBe(false);
    expect(empty?.stepProgress).toEqual({ done: 0, total: 0 });
    expect(empty?.balances).toEqual({ L: 0, C: 0, R: 0, U: 0 });
    expect(d?.stepProgress).toEqual({ done: 2, total: 3 });
  });

  it('listSummaries pages like list (statuses, cursor) and keeps 4 statements per page', () => {
    const p = seedProject(f.db, f.clock);
    const runs = varied(p.id);
    const c = countingRepos(f);

    const first = c.repos.runs.listSummaries({ projectId: p.id, limit: 2, sort: 'created_asc' });
    if (!first.ok || first.value.nextCursor === null) throw new Error('expected a second page');
    c.reset();
    const second = c.repos.runs.listSummaries({ projectId: p.id, limit: 2, sort: 'created_asc', cursor: first.value.nextCursor });
    const paused = f.db.repos.runs.listSummaries({ projectId: p.id, limit: 10, statuses: ['paused'] });

    expect(c.count()).toBe(4);
    expect(second.ok && second.value.items.map((s) => s.run.id)).toEqual([runs[2]?.id, runs[3]?.id]);
    expect(paused.ok && paused.value.items.map((s) => s.run.id)).toEqual([runs[4]?.id]);
    expect(f.db.repos.runs.listSummaries({ projectId: p.id, limit: 1, cursor: 'garbage' }).ok).toBe(false);
    c.close();
  });

  it('summariesOf keeps the given order, skips unknown ids, and costs 1 + 3 statements', () => {
    const p = seedProject(f.db, f.clock);
    const runs = varied(p.id);
    const c = countingRepos(f);
    const ids = [runs[3], runs[0], runs[1]].map((r) => r?.id as RunId);

    c.reset();
    const got = c.repos.runs.summariesOf([...ids, newId('run')]);

    expect(c.count()).toBe(4);
    expect(got.map((s) => s.run.id)).toEqual(ids);
    expect(f.db.repos.runs.summariesOf([])).toEqual([]);
    c.close();
  });

  it('idsForProject and listPausedFor return every matching run in one statement (no page limit)', () => {
    const p = seedProject(f.db, f.clock);
    const other = seedProject(f.db, f.clock, { root: '/tmp/other-root' });
    const mine: RunId[] = [];
    for (let i = 0; i < 120; i++) {
      f.clock.advance(1);
      const run = seedRun(f.db, f.clock, p.id);
      mine.push(run.id);
      f.db.repos.runs.updateStatus(run.id, ['queued'], 'paused', { pauseReason: i % 2 === 0 ? 'budget_project' : 'user' });
    }
    seedRun(f.db, f.clock, other.id);
    const c = countingRepos(f);

    c.reset();
    const ids = c.repos.runs.idsForProject(p.id);
    const paused = c.repos.runs.listPausedFor(p.id, 'budget_project');

    expect(c.count()).toBe(2);
    expect(ids).toEqual(mine);
    expect(paused).toHaveLength(60);
    expect(paused.map((r) => r.id)).toEqual(mine.filter((_, i) => i % 2 === 0).reverse()); // newest first, like list
    c.close();
  });

  it('ledger.listForRun returns every entry oldest first with its attempt step key in one statement', () => {
    const p = seedProject(f.db, f.clock);
    const [a] = varied(p.id);
    if (a === undefined) throw new Error('run');
    const c = countingRepos(f);
    const stepOf = new Map(f.db.repos.steps.listForRun(a.id).map((s) => [s.id, s.stepKey]));
    const attemptStep = new Map(f.db.repos.attempts.listForRun(a.id).map((x) => [x.id as string, stepOf.get(x.stepRunId) ?? null]));
    const paged: LedgerEntryRow[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = f.db.repos.ledger.list(a.id, { limit: 2, sort: 'created_asc', cursor });
      if (!page.ok) throw new Error(page.error.code);
      paged.push(...page.value.items);
      if (page.value.nextCursor === null) break;
      cursor = page.value.nextCursor;
    }

    c.reset();
    const rows = c.repos.ledger.listForRun(a.id);

    expect(c.count()).toBe(1);
    expect(rows.map((x) => x.entry)).toEqual(paged);
    expect(rows.map((x) => x.stepKey)).toEqual(paged.map((e) => (e.attemptId === null ? null : (attemptStep.get(e.attemptId) ?? null))));
    expect(rows.filter((x) => x.stepKey === ('review' as StepKey))).toHaveLength(6);
    c.close();
  });

  it('ledger.listForProjectWindow keeps run entries of the project inside [start, end), ordered by (created_at, id)', () => {
    const p = seedProject(f.db, f.clock);
    const other = seedProject(f.db, f.clock, { root: '/tmp/other-root' });
    const run = seedRun(f.db, f.clock, p.id);
    const otherRun = seedRun(f.db, f.clock, other.id);
    const at = (ms: number, r: RunRow, delta: number) => entry(r, { type: 'allowance_change', bucket: 'allowance', deltaMicrousd: delta, createdAt: epochMs(ms) });
    f.db.repos.ledger.append([at(999, run, 1), at(1000, run, 2), at(1500, run, 3), at(1500, otherRun, 4), at(2000, run, 5)]);
    f.db.repos.ledger.append([at(1500, run, 6)]);
    f.db.repos.ledger.append([{ scope: 'setup', type: 'allowance_change', bucket: 'allowance', deltaMicrousd: 7, createdAt: epochMs(1200) }]);

    const rows = f.db.repos.ledger.listForProjectWindow(p.id, epochMs(1000), epochMs(2000));

    expect(rows.map((x) => x.entry.deltaMicrousd)).toEqual(
      [...rows].sort((x, y) => x.entry.createdAt - y.entry.createdAt || (x.entry.id < y.entry.id ? -1 : 1)).map((x) => x.entry.deltaMicrousd),
    );
    expect(rows.map((x) => x.entry.deltaMicrousd).sort()).toEqual([2, 3, 6]);
    expect(rows.every((x) => x.stepKey === null)).toBe(true);
  });

  it('attempts.countInState counts without loading rows', () => {
    const p = seedProject(f.db, f.clock);
    const [, b] = varied(p.id);
    if (b === undefined) throw new Error('run');

    expect(f.db.repos.attempts.countInState(b.id, 'unknown')).toBe(1);
    expect(f.db.repos.attempts.countInState(b.id, 'reserved')).toBe(1);
    expect(f.db.repos.attempts.countInState(b.id, 'failed')).toBe(0);
  });

  it('events.snapshotBinding reads the latest re-snapshot, preserve, and invalidation events in one statement', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const ev = f.db.repos.events;
    const kinds = { resnapshot: 'resnapshot', approvalInvalidated: 'approval_invalidated' };
    const c = countingRepos(f);
    const empty = c.repos.events.snapshotBinding(run.id, kinds);
    ev.append(run.id, 'context.assembled', { kind: 'intake' }); // 1
    ev.append(run.id, 'error.recorded', { kind: 'approval_invalidated', approvalId: 'apr_x' }); // 2
    ev.append(run.id, 'run.snapshot_preserved', { at: 1 }); // 3
    ev.append(run.id, 'context.assembled', { kind: 'resnapshot' }); // 4
    ev.append(run.id, 'error.recorded', { kind: 'approval_invalidated', approvalId: 7 }); // 5: not a string id
    ev.append(run.id, 'error.recorded', { kind: 'other' }); // 6

    c.reset();
    const b = c.repos.events.snapshotBinding(run.id, kinds);

    expect(c.count()).toBe(1);
    expect(empty).toEqual({ resnapshotSeq: 0, preservedSeq: 0, invalidation: null });
    expect(b).toEqual({ resnapshotSeq: 4, preservedSeq: 3, invalidation: { seq: 5, approvalId: null } });
    c.close();
  });

  it('events.listForStep keeps events naming the step row or one of its attempts, by seq', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const step = seedStep(f.db, f.clock, run.id);
    const other = seedStep(f.db, f.clock, run.id, { stepKey: 'plan', ordinal: 2 });
    const att = seedAttempt(f.db, f.clock, run.id, step.id);
    const ev = f.db.repos.events;
    ev.append(run.id, 'step.state_changed', { stepRunId: step.id }); // 1 ✓
    ev.append(run.id, 'step.state_changed', { stepRunId: other.id }); // 2
    ev.append(run.id, 'attempt.stream_progress', { attemptId: att.id }); // 3 ✓
    ev.append(run.id, 'attempt.stream_progress', { attemptId: 'att_other' }); // 4
    ev.append(run.id, 'run.status_changed', { status: 'running' }); // 5

    const got = ev.listForStep(run.id, step.id, [att.id]);

    expect(got.map((e) => e.seq)).toEqual([1, 3]);
    expect(ev.listForStep(run.id, step.id, []).map((e) => e.seq)).toEqual([1]);
  });

  it('projects.findActiveByRoot finds only the non-archived project at that root', () => {
    const p = seedProject(f.db, f.clock, { root: '/tmp/root-a' });

    const found = f.db.repos.projects.findActiveByRoot('/tmp/root-a');
    f.db.repos.projects.archive(p.id);

    expect(found?.id).toBe(p.id);
    expect(f.db.repos.projects.findActiveByRoot('/tmp/root-a')).toBeUndefined();
    expect(f.db.repos.projects.findActiveByRoot('/tmp/nope')).toBeUndefined();
  });

  it('workflows.listSummaries equals listWorkflows + latestValidated + draft per workflow', () => {
    seedRun(f.db, f.clock, seedProject(f.db, f.clock).id); // seeds a workflow with a validated version
    const w = f.db.repos.workflows;
    const extra = w.ensureWorkflow('second', 'Second');
    const base = w.listWorkflows()[0];
    const v1 = base === undefined ? undefined : w.latestValidated(base.id);
    if (base === undefined || v1 === undefined) throw new Error('fixture');
    w.insertVersion({ ...v1, id: newId('workflowVersion'), version: v1.version + 1, status: 'draft', basedOnVersion: v1.version, contentHash: sha('d') });

    const got = w.listSummaries();

    expect(got).toEqual(w.listWorkflows().map((x) => ({ id: x.id, name: x.name, latestValidatedVersion: w.latestValidated(x.id)?.version ?? null,
      draftVersion: w.getVersion(x.id, 'draft')?.version ?? null })));
    expect(got.find((x) => x.id === extra.id)).toEqual({ id: extra.id, name: 'Second', latestValidatedVersion: null, draftVersion: null });
    expect(got.find((x) => x.id === base.id)?.draftVersion).toBe(v1.version + 1);
  });

  it('memory.list filters by sourceRunId', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const add = (sourceRunId: RunId | null, title: string) =>
      f.db.repos.memory.insertRecord(
        { id: newId('memory'), projectId: p.id, type: 'project_decision', status: 'suggested', scope: { roles: 'all' }, sourceRunId, createdAt: f.clock.now() },
        { id: newId('memoryRevision'), title, content: 'c', sourceRefs: [], author: 'user', createdAt: f.clock.now() },
      );
    const mine = add(run.id, 'from the run');
    add(null, 'by hand');

    expect(f.db.repos.memory.list({ projectId: p.id, sourceRunId: run.id }).map((m) => m.record.id)).toEqual([mine.record.id]);
    expect(f.db.repos.memory.list({ projectId: p.id })).toHaveLength(2);
  });
});
