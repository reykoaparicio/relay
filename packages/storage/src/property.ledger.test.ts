import type { AttemptId, Microusd } from '@relay/contracts';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureDb } from './testing/fixtures.js';
import { newId, openFixtureDb, seedAttempt, seedProject, seedRun, seedStep } from './testing/fixtures.js';
import type { LedgerEntryInsert, RunRow, StepRow } from './types.js';

type Op =
  | { kind: 'reserve'; amount: number }
  | { kind: 'settle'; target: number; cost: number }
  | { kind: 'release'; target: number }
  | { kind: 'unknown'; target: number };

type Final = { state: 'reserved'; n: number } | { state: 'settled'; cost: number } | { state: 'released' } | { state: 'unknown'; n: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('reserve' as const), amount: fc.integer({ min: 0, max: 5_000_000 }) }),
  fc.record({ kind: fc.constant('settle' as const), target: fc.nat(), cost: fc.integer({ min: 0, max: 8_000_000 }) }),
  fc.record({ kind: fc.constant('release' as const), target: fc.nat() }),
  fc.record({ kind: fc.constant('unknown' as const), target: fc.nat() }),
);

describe('ledger property @m1', () => {
  let f: FixtureDb;
  let run: RunRow;
  let step: StepRow;

  beforeAll(async () => {
    f = await openFixtureDb();
    const p = seedProject(f.db, f.clock);
    run = seedRun(f.db, f.clock, p.id);
    step = seedStep(f.db, f.clock, run.id);
  });
  afterAll(async () => {
    await f.db.dispose();
  });

  it('never leaves R negative for any attempt, and C + R + U equals the sum of the attempts’ final states', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
        // Each property run gets its own run row so balances start at zero.
        const r = seedRun(f.db, f.clock, run.projectId);
        const s = seedStep(f.db, f.clock, r.id);
        const attempts: { id: AttemptId; final: Final }[] = [];
        const entry = (e: Omit<LedgerEntryInsert, 'scope' | 'runId' | 'projectId'>): LedgerEntryInsert => ({
          scope: 'run',
          runId: r.id,
          projectId: r.projectId,
          ...e,
        });
        for (const op of ops) {
          if (op.kind === 'reserve') {
            const a = seedAttempt(f.db, f.clock, r.id, s.id, { id: newId('attempt') });
            f.db.tx('immediate', (repos) =>
              repos.ledger.append([entry({ type: 'reserve', bucket: 'reserved', deltaMicrousd: op.amount, attemptId: a.id })]),
            );
            attempts.push({ id: a.id, final: { state: 'reserved', n: op.amount } });
            continue;
          }
          const open = attempts.filter((a) => a.final.state === 'reserved');
          const t = open[op.target % Math.max(open.length, 1)];
          if (t === undefined || t.final.state !== 'reserved') continue; // only valid transitions
          const n = t.final.n;
          const release = entry({ type: 'release', bucket: 'reserved', deltaMicrousd: -n, attemptId: t.id });
          if (op.kind === 'settle') {
            f.db.tx('immediate', (repos) =>
              repos.ledger.append([release, entry({ type: 'settle', bucket: 'settled', deltaMicrousd: op.cost, attemptId: t.id, certainty: 'calculated' })]),
            );
            t.final = { state: 'settled', cost: op.cost };
          } else if (op.kind === 'release') {
            f.db.tx('immediate', (repos) => repos.ledger.append([release]));
            t.final = { state: 'released' };
          } else {
            f.db.tx('immediate', (repos) =>
              repos.ledger.append([release, entry({ type: 'move_to_unknown', bucket: 'unknown', deltaMicrousd: n, attemptId: t.id })]),
            );
            t.final = { state: 'unknown', n };
          }
          expect(f.db.repos.ledger.attemptBalances(t.id).reserved).toBeGreaterThanOrEqual(0);
        }
        let expected = 0;
        for (const a of attempts) {
          const b = f.db.repos.ledger.attemptBalances(a.id);
          expect(b.reserved).toBeGreaterThanOrEqual(0);
          const fin = a.final;
          expected += fin.state === 'reserved' || fin.state === 'unknown' ? fin.n : fin.state === 'settled' ? fin.cost : 0;
        }
        const bal = f.db.repos.ledger.runBalances(r.id);
        expect(bal.R).toBeGreaterThanOrEqual(0);
        expect((bal.C + bal.R + bal.U) as Microusd).toBe(expected);
      }),
      { numRuns: 60 },
    );
    expect(step.runId).toBe(run.id);
  });
});
