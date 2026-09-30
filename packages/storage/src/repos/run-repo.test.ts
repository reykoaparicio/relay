import type { RunId, RunStatus } from '@relay/contracts';
import { epochMs } from '@relay/contracts';
import { randomBytes } from 'node:crypto';
import { createIdGen, systemClock } from '@relay/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver, SqlStatement } from '../driver.js';
import { openNodeSqlite } from '../driver-node-sqlite.js';
import { applyPragmas } from '../pragmas.js';
import type { FixtureDb } from '../testing/fixtures.js';
import { newId, openFixtureDb, seedAttempt, seedProject, seedRun, seedStep, sha } from '../testing/fixtures.js';
import type { ListSort, RunRow } from '../types.js';
import { createRepos } from './index.js';

/** Wraps a driver so every statement execution (run/get/all) and exec is counted. */
function countingDriver(inner: SqlDriver): { driver: SqlDriver; count: () => number; reset: () => void } {
  let n = 0;
  const wrap = (s: SqlStatement): SqlStatement => ({
    run: (...p) => {
      n += 1;
      return s.run(...p);
    },
    get: (...p) => {
      n += 1;
      return s.get(...p);
    },
    all: (...p) => {
      n += 1;
      return s.all(...p);
    },
  });
  const driver: SqlDriver = {
    get path() {
      return inner.path;
    },
    get inTransaction() {
      return inner.inTransaction;
    },
    exec: (sql) => {
      n += 1;
      inner.exec(sql);
    },
    prepare: (sql) => wrap(inner.prepare(sql)),
    close: () => {
      inner.close();
    },
    backupTo: (d) => inner.backupTo(d),
  };
  return { driver, count: () => n, reset: () => (n = 0) };
}

describe('RunRepo', () => {
  let f: FixtureDb;

  beforeEach(async () => {
    f = await openFixtureDb();
  });
  afterEach(async () => {
    await f.db.dispose();
  });

  const pageAll = (projectId: RunRow['projectId'], sort: ListSort, limit: number): RunId[] => {
    const seen: RunId[] = [];
    let cursor: string | undefined;
    for (;;) {
      const r = f.db.repos.runs.list({ projectId, sort, cursor, limit });
      if (!r.ok) throw new Error('page failed');
      seen.push(...r.value.items.map((x) => x.id));
      if (r.value.nextCursor === null) return seen;
      cursor = r.value.nextCursor;
    }
  };

  it('pages stably through equal created_at values in both sorts, each row exactly once', () => {
    const p = seedProject(f.db, f.clock);
    const other = seedProject(f.db, f.clock);
    const ids = Array.from({ length: 7 }, (_, i) => seedRun(f.db, f.clock, p.id, { createdAt: epochMs(1000 + (i < 4 ? 0 : 1)) }).id);
    seedRun(f.db, f.clock, other.id);

    const desc = pageAll(p.id, 'created_desc', 2);
    const asc = pageAll(p.id, 'created_asc', 3);

    const expectedAsc = [...ids.slice(0, 4).sort(), ...ids.slice(4).sort()];
    expect(asc).toEqual(expectedAsc);
    expect(desc).toEqual([...expectedAsc].reverse());
    expect(new Set(desc).size).toBe(7);
  });

  it('filters by status', () => {
    const p = seedProject(f.db, f.clock);
    const a = seedRun(f.db, f.clock, p.id);
    seedRun(f.db, f.clock, p.id);
    f.db.repos.runs.updateStatus(a.id, ['queued'], 'running', { startedAt: f.clock.now() });

    const r = f.db.repos.runs.list({ projectId: p.id, statuses: ['running'], limit: 10 });

    expect(r.ok && r.value.items.map((x) => x.id)).toEqual([a.id]);
  });

  it('rejects a cursor from the other sort, and a malformed cursor, with VALIDATION_FAILED', () => {
    const p = seedProject(f.db, f.clock);
    seedRun(f.db, f.clock, p.id);
    seedRun(f.db, f.clock, p.id);
    const first = f.db.repos.runs.list({ projectId: p.id, sort: 'created_desc', limit: 1 });
    const cursor = first.ok ? (first.value.nextCursor ?? '') : '';

    const crossed = f.db.repos.runs.list({ projectId: p.id, sort: 'created_asc', cursor, limit: 1 });
    const garbage = f.db.repos.runs.list({ projectId: p.id, cursor: '!!!', limit: 1 });
    const wrongShape = f.db.repos.runs.list({ projectId: p.id, cursor: Buffer.from('[1]').toString('base64url'), limit: 1 });

    expect(crossed.ok).toBe(false);
    expect(!crossed.ok && crossed.error.code).toBe('VALIDATION_FAILED');
    expect(!garbage.ok && garbage.error.code).toBe('VALIDATION_FAILED');
    expect(!wrongShape.ok && wrongShape.error.code).toBe('VALIDATION_FAILED');
  });

  it('updateStatus is compare-and-set and clears pause_reason when leaving paused', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const repo = f.db.repos.runs;

    const wrongFrom = repo.updateStatus(run.id, ['running'], 'paused', { pauseReason: 'user' });
    const toRunning = repo.updateStatus(run.id, ['queued'], 'running', { startedAt: f.clock.now() });
    const toPaused = repo.updateStatus(run.id, ['running'], 'paused', {
      pauseReason: 'budget_run',
      statusDetail: { code: 'BUDGET_BLOCKED', userMessage: 'x', retryable: false, nextAction: 'increase_allowance', alternatives: [] },
    });
    const paused = repo.get(run.id);
    const resumed = repo.updateStatus(run.id, ['paused'], 'running', {});
    const running = repo.get(run.id);
    repo.updateStatus(run.id, ['running'], 'completed', {});
    const done = repo.get(run.id);

    expect(wrongFrom).toBe(false);
    expect(toRunning).toBe(true);
    expect(toPaused).toBe(true);
    expect(paused.pauseReason).toBe('budget_run');
    expect(paused.statusDetail?.code).toBe('BUDGET_BLOCKED');
    expect(resumed).toBe(true);
    expect(running.pauseReason).toBeNull();
    expect(running.statusDetail).toBeNull();
    expect(running.startedAt).toBe(paused.startedAt);
    expect(done.endedAt).toBe(f.clock.now());
    const wide = (to: RunStatus): boolean => repo.updateStatus(run.id, ['completed'], to, { pauseReason: null });
    expect(() => wide('paused')).toThrow(/pauseReason/);
    // @ts-expect-error — a literal 'paused' target requires pauseReason at the type level
    const typeOnly = (): boolean => repo.updateStatus(run.id, ['running'], 'paused', {});
    expect(typeof typeOnly).toBe('function');
  });

  it('accrues execution_ms_used across running segments', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const repo = f.db.repos.runs;

    repo.enterRunning(run.id, epochMs(1000));
    repo.enterRunning(run.id, epochMs(1500)); // no-op: a segment is already open
    repo.leaveRunning(run.id, epochMs(1700));
    repo.leaveRunning(run.id, epochMs(9999)); // no-op: nothing open
    repo.enterRunning(run.id, epochMs(2000));
    repo.leaveRunning(run.id, epochMs(2050));

    expect(repo.get(run.id).executionMsUsed).toBe(750);
    expect(repo.get(run.id).runningSince).toBeNull();
  });

  it('round-trips pause_requested and the other simple setters', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const repo = f.db.repos.runs;

    repo.setPauseRequested(run.id, true);
    const on = repo.get(run.id).pauseRequested;
    repo.setPauseRequested(run.id, false);
    repo.incrementAttemptCount(run.id);
    repo.setRevisionCycle(run.id, 2);
    repo.setContextHash(run.id, sha('b'));
    repo.setLimits(run.id, { ...run.limits, maxAttempts: 20 });
    const after = repo.get(run.id);

    expect(on).toBe(true);
    expect(after.pauseRequested).toBe(false);
    expect(after.attemptCount).toBe(1);
    expect(after.revisionCycle).toBe(2);
    expect(after.contextHash).toBe(sha('b'));
    expect(after.limits.maxAttempts).toBe(20);
    expect(repo.find(newId('run'))).toBeUndefined();
    expect(() => repo.get(newId('run'))).toThrow();
  });

  it('returns the oldest queued run and the active runs', () => {
    const p = seedProject(f.db, f.clock);
    const a = seedRun(f.db, f.clock, p.id, { createdAt: epochMs(10) });
    const b = seedRun(f.db, f.clock, p.id, { createdAt: epochMs(20) });
    f.db.repos.runs.updateStatus(a.id, ['queued'], 'cancelled', {});

    expect(f.db.repos.runs.nextQueued()?.id).toBe(b.id);
    expect(f.db.repos.runs.listActive().map((r) => r.id)).toEqual([b.id]);
  });

  it('stores input files with their snapshot artifact ids', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const art = f.db.repos.artifacts.insertIfAbsent({
      id: newId('artifact'),
      runId: run.id,
      projectId: p.id,
      kind: 'input_file',
      relPath: 'artifacts/run/x',
      sha256: sha('1'),
      sizeBytes: 3,
      mediaType: 'text/plain',
      createdAt: f.clock.now(),
    });

    f.db.repos.runs.insertInputFiles(run.id, [
      { relPath: 'src/b.ts' as never, sha256: sha('1'), artifactId: art.id, sizeBytes: 3, capturedAt: f.clock.now() },
      { relPath: 'src/a.ts' as never, sha256: sha('1'), artifactId: art.id, sizeBytes: 3, capturedAt: f.clock.now() },
    ]);

    expect(f.db.repos.runs.inputFiles(run.id).map((x) => [x.relPath, x.artifactId])).toEqual([
      ['src/a.ts', art.id],
      ['src/b.ts', art.id],
    ]);
  });

  it('builds the inspector projection with at most 6 statements', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const s1 = seedStep(f.db, f.clock, run.id);
    seedStep(f.db, f.clock, run.id, { stepKey: 'plan', ordinal: 2, state: 'pending' });
    const att = seedAttempt(f.db, f.clock, run.id, s1.id);
    f.db.repos.ledger.append([
      { scope: 'run', type: 'allowance_set', bucket: 'allowance', deltaMicrousd: 3_000_000, runId: run.id, projectId: p.id },
      { scope: 'run', type: 'reserve', bucket: 'reserved', deltaMicrousd: 1000, runId: run.id, projectId: p.id, attemptId: att.id },
    ]);
    const inner = openNodeSqlite(f.db.path);
    applyPragmas(inner);
    const counting = countingDriver(inner);
    const repos = createRepos(counting.driver, {
      clock: f.clock,
      ids: createIdGen(systemClock, (n) => randomBytes(n)),
      isPidAlive: () => true,
      inTx: (fn) => fn(),
    });
    counting.reset();

    const proj = repos.runs.getInspectorProjection(run.id);

    expect(counting.count()).toBeLessThanOrEqual(6);
    expect(proj.run.id).toBe(run.id);
    expect(proj.workflow.version).toBe(1);
    expect(proj.steps).toHaveLength(2);
    expect(proj.attempts.map((a) => a.id)).toEqual([att.id]);
    expect(proj.balances).toEqual({ L: 3_000_000, C: 0, R: 1000, U: 0 });
    expect(proj.pendingApproval).toBeNull();
    expect(proj.reportArtifactId).toBeNull();
    expect(() => repos.runs.getInspectorProjection(newId('run'))).toThrow();
    inner.close();
  });
});
