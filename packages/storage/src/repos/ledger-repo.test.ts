import type { AttemptId, ProjectId, RunId } from '@relay/contracts';
import { epochMs } from '@relay/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FixtureDb } from '../testing/fixtures.js';
import { newId, openFixtureDb, seedAttempt, seedProject, seedRun, seedStep } from '../testing/fixtures.js';
import type { LedgerEntryInsert } from '../types.js';

const START = epochMs(1_000_000);
const END = epochMs(2_000_000);

describe('LedgerRepo', () => {
  let f: FixtureDb;

  beforeEach(async () => {
    f = await openFixtureDb();
  });
  afterEach(async () => {
    await f.db.dispose();
  });

  const setup = () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const step = seedStep(f.db, f.clock, run.id);
    return { p, run, step };
  };
  const runEntry = (runId: RunId, projectId: ProjectId, e: Partial<LedgerEntryInsert> & Pick<LedgerEntryInsert, 'type' | 'bucket' | 'deltaMicrousd'>): LedgerEntryInsert => ({
    scope: 'run',
    runId,
    projectId,
    ...e,
  });

  it('sums buckets for reserve → settle, reserve → move_to_unknown, and allowance changes; overrun may go negative', () => {
    const { p, run, step } = setup();
    const a1 = seedAttempt(f.db, f.clock, run.id, step.id).id;
    const a2 = seedAttempt(f.db, f.clock, run.id, step.id).id;
    const e = (x: Parameters<typeof runEntry>[2]) => runEntry(run.id, p.id, x);
    const repo = f.db.repos.ledger;

    repo.append([e({ type: 'allowance_set', bucket: 'allowance', deltaMicrousd: 1000 })]);
    repo.append([e({ type: 'allowance_change', bucket: 'allowance', deltaMicrousd: 500 })]);
    repo.append([e({ type: 'reserve', bucket: 'reserved', deltaMicrousd: 800, attemptId: a1 })]);
    const settle = repo.append([
      e({ type: 'release', bucket: 'reserved', deltaMicrousd: -800, attemptId: a1 }),
      e({ type: 'settle', bucket: 'settled', deltaMicrousd: 1200, attemptId: a1, certainty: 'reported' }),
    ]);
    repo.append([e({ type: 'reserve', bucket: 'reserved', deltaMicrousd: 600, attemptId: a2 })]);
    repo.append([
      e({ type: 'release', bucket: 'reserved', deltaMicrousd: -600, attemptId: a2 }),
      e({ type: 'move_to_unknown', bucket: 'unknown', deltaMicrousd: 600, attemptId: a2 }),
    ]);

    const b = repo.runBalances(run.id);

    expect(b).toEqual({ L: 1500, C: 1200, R: 0, U: 600 });
    expect(b.L - b.C - b.R - b.U).toBe(-300);
    expect(settle[0]?.groupId).toBe(settle[1]?.groupId);
    expect(repo.attemptBalances(a1)).toEqual({ reserved: 0, unknown: 0, settled: 1200 });
    expect(repo.attemptBalances(a2)).toEqual({ reserved: 0, unknown: 600, settled: 0 });
    expect(repo.settledByCertainty(run.id)).toEqual({ reported: 1200, calculated: 0, estimated: 0, unknown: 0 });
    expect(repo.runBalances(newId('run'))).toEqual({ L: 0, C: 0, R: 0, U: 0 });
  });

  it('decision 1: openUnknownLiabilities lists every open legacy liability (per attempt, and the setup scope as one row), none once resolved', () => {
    const { p, run, step } = setup();
    const a = seedAttempt(f.db, f.clock, run.id, step.id);
    const b = seedAttempt(f.db, f.clock, run.id, step.id);
    f.db.tx('immediate', (r) => {
      r.ledger.append([runEntry(run.id, p.id, { type: 'move_to_unknown', bucket: 'unknown', deltaMicrousd: 300, attemptId: a.id, certainty: 'unknown' })]);
      r.ledger.append([runEntry(run.id, p.id, { type: 'move_to_unknown', bucket: 'unknown', deltaMicrousd: 200, attemptId: b.id, certainty: 'unknown' })]);
      r.ledger.append([runEntry(run.id, p.id, { type: 'resolve_unknown', bucket: 'unknown', deltaMicrousd: -200, attemptId: b.id })]);
      r.ledger.append([{ scope: 'setup', type: 'move_to_unknown', bucket: 'unknown', deltaMicrousd: 50, certainty: 'unknown' }]);
    });

    const open = f.db.repos.ledger.openUnknownLiabilities();
    expect(open).toHaveLength(2);
    expect(open).toEqual(expect.arrayContaining([{ attemptId: a.id, microusd: 300 }, { attemptId: null, microusd: 50 }]));
  });

  it('projectMonthBalances uses a half-open window for C and outstanding R/U regardless of date', () => {
    const { p, run, step } = setup();
    const other = seedProject(f.db, f.clock);
    const otherRun = seedRun(f.db, f.clock, other.id);
    const att = (): AttemptId => seedAttempt(f.db, f.clock, run.id, step.id).id;
    const e = (x: Parameters<typeof runEntry>[2]) => runEntry(run.id, p.id, x);
    const repo = f.db.repos.ledger;

    repo.append([e({ type: 'settle', bucket: 'settled', deltaMicrousd: 10, certainty: 'calculated', createdAt: START, attemptId: att() })]);
    repo.append([e({ type: 'settle', bucket: 'settled', deltaMicrousd: 20, certainty: 'calculated', createdAt: END, attemptId: att() })]);
    repo.append([e({ type: 'settle', bucket: 'settled', deltaMicrousd: 40, certainty: 'calculated', createdAt: epochMs(START - 1) })]);
    repo.append([e({ type: 'reserve', bucket: 'reserved', deltaMicrousd: 300, createdAt: epochMs(START - 5000) })]);
    repo.append([e({ type: 'move_to_unknown', bucket: 'unknown', deltaMicrousd: 70, createdAt: epochMs(START - 5000) })]);
    repo.append([runEntry(otherRun.id, other.id, { type: 'settle', bucket: 'settled', deltaMicrousd: 999, certainty: 'reported', createdAt: START })]);
    repo.append([{ scope: 'setup', type: 'settle', bucket: 'settled', deltaMicrousd: 5, certainty: 'reported', createdAt: START }]);

    expect(repo.projectMonthBalances(p.id, START, END)).toEqual({ C: 10, R: 300, U: 70 });
  });

  it('decision 1: projectMonthEstimated nets estimates in the month (a later correction cancels one)', () => {
    const { p, run, step } = setup();
    const a = seedAttempt(f.db, f.clock, run.id, step.id).id;
    const b = seedAttempt(f.db, f.clock, run.id, step.id).id;
    const e = (x: Parameters<typeof runEntry>[2]) => runEntry(run.id, p.id, x);
    const repo = f.db.repos.ledger;

    repo.append([e({ type: 'settle', bucket: 'settled', deltaMicrousd: 30, certainty: 'calculated', createdAt: START, attemptId: a })]);
    expect(repo.projectMonthEstimated(p.id, START, END)).toBe(0);

    repo.append([e({ type: 'settle', bucket: 'settled', deltaMicrousd: 40, certainty: 'estimated', createdAt: START, attemptId: b })]);
    repo.append([e({ type: 'settle', bucket: 'settled', deltaMicrousd: 99, certainty: 'estimated', createdAt: epochMs(START - 1), attemptId: b })]);
    expect(repo.projectMonthEstimated(p.id, START, END)).toBe(40);

    // Reconciliation correction: the estimate is netted out and the real cost settled.
    repo.append([e({ type: 'settle', bucket: 'settled', deltaMicrousd: -40, certainty: 'estimated', createdAt: START, attemptId: b })]);
    repo.append([e({ type: 'settle', bucket: 'settled', deltaMicrousd: 35, certainty: 'reported', createdAt: START, attemptId: b })]);
    expect(repo.projectMonthEstimated(p.id, START, END)).toBe(0);
  });

  it('setupBalances follows the same rules over scope=setup only', () => {
    const { p, run } = setup();
    const repo = f.db.repos.ledger;

    repo.append([{ scope: 'setup', type: 'settle', bucket: 'settled', deltaMicrousd: 5, certainty: 'reported', createdAt: START }]);
    repo.append([{ scope: 'setup', type: 'settle', bucket: 'settled', deltaMicrousd: 7, certainty: 'reported', createdAt: END }]);
    repo.append([{ scope: 'setup', type: 'reserve', bucket: 'reserved', deltaMicrousd: 11, createdAt: epochMs(0) }]);
    repo.append([{ scope: 'setup', type: 'move_to_unknown', bucket: 'unknown', deltaMicrousd: 13, createdAt: epochMs(0) }]);
    repo.append([runEntry(run.id, p.id, { type: 'settle', bucket: 'settled', deltaMicrousd: 1000, certainty: 'reported', createdAt: START })]);
    repo.append([runEntry(run.id, p.id, { type: 'reserve', bucket: 'reserved', deltaMicrousd: 1000, createdAt: START })]);

    expect(repo.setupBalances(START, END)).toEqual({ C: 5, R: 11, U: 13 });
  });

  it('lists entries with keyset pagination in both sorts and rejects unsafe deltas', () => {
    const { p, run } = setup();
    const repo = f.db.repos.ledger;
    for (let i = 0; i < 5; i += 1) {
      repo.append([runEntry(run.id, p.id, { type: 'allowance_change', bucket: 'allowance', deltaMicrousd: i, createdAt: epochMs(100) })]);
    }
    const collect = (sort: 'created_desc' | 'created_asc'): number[] => {
      const out: number[] = [];
      let cursor: string | undefined;
      for (;;) {
        const r = repo.list(run.id, { sort, cursor, limit: 2 });
        if (!r.ok) throw new Error('page');
        out.push(...r.value.items.map((x) => x.deltaMicrousd));
        if (r.value.nextCursor === null) return out;
        cursor = r.value.nextCursor;
      }
    };

    const asc = collect('created_asc');
    const desc = collect('created_desc');
    const bad = repo.list(run.id, { cursor: 'x', limit: 2 });

    expect([...asc].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(desc).toEqual([...asc].reverse());
    expect(bad.ok).toBe(false);
    expect(() => repo.append([runEntry(run.id, p.id, { type: 'reserve', bucket: 'reserved', deltaMicrousd: 0.5 })])).toThrow();
  });

  it('append is all-or-nothing: a failing entry leaves no partial group and balances unchanged (B2)', () => {
    const { p, run } = setup();
    f.db.repos.ledger.append([runEntry(run.id, p.id, { type: 'allowance_set', bucket: 'allowance', deltaMicrousd: 1000 })]);
    const before = f.db.repos.ledger.runBalances(run.id);

    expect(() =>
      f.db.repos.ledger.append([
        runEntry(run.id, p.id, { type: 'reserve', bucket: 'reserved', deltaMicrousd: 100 }),
        // scope 'run' without project_id violates a CHECK on the second row.
        { scope: 'run', runId: run.id, type: 'reserve', bucket: 'allowance', deltaMicrousd: -100 },
      ]),
    ).toThrow(/CHECK constraint failed/);

    expect(f.db.repos.ledger.runBalances(run.id)).toEqual(before);
    expect(f.db.repos.ledger.list(run.id, { limit: 10 }).ok && f.db.repos.ledger.list(run.id, { limit: 10 })).toMatchObject({
      value: { items: [{ type: 'allowance_set' }] },
    });
  });

  it('append joins an enclosing db.tx instead of nesting, and rolls back with it (B2)', () => {
    const { p, run } = setup();

    expect(() =>
      f.db.tx('immediate', (repos) => {
        repos.ledger.append([runEntry(run.id, p.id, { type: 'allowance_set', bucket: 'allowance', deltaMicrousd: 5 })]);
        throw new Error('abort');
      }),
    ).toThrow('abort');
    const inside = f.db.tx('immediate', (repos) =>
      repos.ledger.append([runEntry(run.id, p.id, { type: 'allowance_set', bucket: 'allowance', deltaMicrousd: 7 })]),
    );

    expect(inside).toHaveLength(1);
    expect(f.db.repos.ledger.runBalances(run.id).L).toBe(7);
  });
});
