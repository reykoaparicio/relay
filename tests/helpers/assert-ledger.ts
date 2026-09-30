/**
 * Ledger assertions (11 §K3/K4): balances per run, no negative reserved/unknown bucket anywhere, and C + R + U equal to
 * the sum of every attempt's final ledger state.
 */
import { expect } from 'vitest';
import type { RunId } from '@relay/contracts';
import type { Db, RunRow } from '@relay/storage';

/** Every run of every project (archived included). */
export function allRuns(db: Db): RunRow[] {
  const out: RunRow[] = [];
  for (const p of db.repos.projects.list({ includeArchived: true })) {
    let cursor: string | undefined;
    for (;;) {
      const page = db.repos.runs.list({ projectId: p.id, limit: 100, sort: 'created_asc', cursor });
      if (!page.ok) throw new Error(`runs.list: ${page.error.code}`);
      out.push(...page.value.items);
      if (page.value.nextCursor === null) break;
      cursor = page.value.nextCursor;
    }
  }
  return out;
}

/** Asserts the listed balances of the run (omitted keys are not checked). */
export function expectBalances(db: Db, runId: RunId, expected: Partial<Record<'C' | 'R' | 'U' | 'L', number>>): void {
  const b = db.repos.ledger.runBalances(runId);
  const picked: Record<string, number> = {};
  for (const k of Object.keys(expected)) picked[k] = b[k as 'C' | 'R' | 'U' | 'L'];
  expect(picked, `balances of ${runId}`).toEqual(expected);
}

/** No run, and no attempt, ever has a negative reserved or unknown balance. */
export function expectNoNegativeReserved(db: Db): void {
  for (const run of allRuns(db)) {
    const b = db.repos.ledger.runBalances(run.id);
    expect(b.R, `R of ${run.id}`).toBeGreaterThanOrEqual(0);
    expect(b.U, `U of ${run.id}`).toBeGreaterThanOrEqual(0);
    for (const a of db.repos.attempts.listForRun(run.id)) {
      const ab = db.repos.ledger.attemptBalances(a.id);
      expect(ab.reserved, `reserved of ${a.id}`).toBeGreaterThanOrEqual(0);
      expect(ab.unknown, `unknown of ${a.id}`).toBeGreaterThanOrEqual(0);
    }
  }
}

/** C + R + U of the run equals Σ over its attempts of (reserved + unknown + settled). */
export function expectLedgerMatchesAttempts(db: Db, runId: RunId): void {
  const b = db.repos.ledger.runBalances(runId);
  let sum = 0;
  for (const a of db.repos.attempts.listForRun(runId)) {
    const ab = db.repos.ledger.attemptBalances(a.id);
    sum += ab.reserved + ab.unknown + ab.settled;
  }
  expect(b.C + b.R + b.U, `C+R+U of ${runId}`).toBe(sum);
}

/** Attempt-state invariants after recovery: nothing left in created/reserved/dispatching. */
export function expectNoInFlightAttempts(db: Db): void {
  for (const run of allRuns(db)) {
    for (const a of db.repos.attempts.listForRun(run.id)) {
      expect(['created', 'reserved', 'dispatching'], `attempt ${a.id} state`).not.toContain(a.state);
    }
  }
}
