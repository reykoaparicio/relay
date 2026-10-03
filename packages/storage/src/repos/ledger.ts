import type { AttemptId, ProjectId, Result, RunId } from '@relay/contracts';
import { invariant, ok, stepKeySchema } from '@relay/contracts';
import { decodeCursor, encodeCursor } from '../cursor.js';
import type { SqlDriver } from '../driver.js';
import { mapLedgerEntry, RowReader } from '../mappers.js';
import { KEYSET } from '../sql.js';
import type { LedgerEntryRow, LedgerEntryWithStep, LedgerRepo, Page, PageRequest, WindowBalances } from '../types.js';
import type { RepoDeps } from './deps.js';
import { RUN_BALANCES_SQL, RUN_COSTS_SQL } from './ledger-sql.js';
import { readRunCosts } from './runs.js';

// §9.3 month windows are half-open [start, end). C counts settled entries inside the window; R and U are the
// outstanding totals with no date filter (an open reservation or unknown liability from last month still binds).
const windowSql = (scopeFilter: string): string => `SELECT
  COALESCE(SUM(CASE WHEN bucket = 'settled' AND created_at >= ?1 AND created_at < ?2 THEN delta_microusd END), 0) AS c,
  COALESCE(SUM(CASE WHEN bucket = 'reserved' THEN delta_microusd END), 0) AS r,
  COALESCE(SUM(CASE WHEN bucket = 'unknown' THEN delta_microusd END), 0) AS u
  FROM ledger_entries WHERE ${scopeFilter}`;
const PROJECT_WINDOW_SQL = windowSql("scope = 'run' AND project_id = ?3");
/**
 * D1-1: the estimated amount still uncorrected in a project month, PER ATTEMPT: each attempt's `estimated` settle entries
 * in the window are netted, and only attempts left with a positive estimate count (a correction nets its own attempt to
 * 0; a stray negative never hides another attempt's genuine estimate). Run-scope entries without an attempt count alone.
 */
const PROJECT_WINDOW_ESTIMATED_SQL = `SELECT COALESCE(SUM(e), 0) AS e FROM (
  SELECT SUM(delta_microusd) AS e FROM ledger_entries
  WHERE scope = 'run' AND project_id = ?3 AND bucket = 'settled' AND certainty = 'estimated'
  AND created_at >= ?1 AND created_at < ?2
  GROUP BY COALESCE(attempt_id, id) HAVING SUM(delta_microusd) > 0)`;
const SETUP_WINDOW_SQL = windowSql("scope = 'setup'");

const listSql = (sort: 'created_desc' | 'created_asc', withCursor: boolean): string =>
  `SELECT * FROM ledger_entries WHERE run_id = ? ${withCursor ? `AND ${KEYSET[sort].after}` : ''} ${KEYSET[sort].order} LIMIT ?`;

/** Ledger rows + the step key of their attempt (`attempts.step_run_id` is FK-bound, so a non-null attempt has one). */
const WITH_STEP_SELECT = `SELECT l.*, s.step_key AS entry_step_key FROM ledger_entries l
  LEFT JOIN attempts a ON a.id = l.attempt_id LEFT JOIN step_runs s ON s.id = a.step_run_id`;

function withStep(row: unknown): LedgerEntryWithStep {
  return { entry: mapLedgerEntry(row), stepKey: new RowReader('ledger_entries', row).asN('entry_step_key', stepKeySchema) };
}

function readWindow(row: unknown): WindowBalances {
  const r = new RowReader('ledger_entries', row, 'c');
  return { C: r.money('c'), R: r.money('r'), U: r.money('u') };
}

export function createLedgerRepo(driver: SqlDriver, deps: RepoDeps): LedgerRepo {
  const list = (runId: RunId, page: PageRequest): Result<Page<LedgerEntryRow>> => {
    const sort = page.sort ?? 'created_desc';
    let rows: unknown[];
    if (page.cursor === undefined) {
      rows = driver.prepare(listSql(sort, false)).all(runId, page.limit + 1);
    } else {
      const pos = decodeCursor(page.cursor, sort);
      if (!pos.ok) {
        return pos;
      }
      rows = driver.prepare(listSql(sort, true)).all(runId, pos.value.createdAt, pos.value.id, page.limit + 1);
    }
    const items = rows.slice(0, page.limit).map(mapLedgerEntry);
    const last = items.at(-1);
    const nextCursor = rows.length > page.limit && last !== undefined ? encodeCursor({ createdAt: last.createdAt, id: last.id }, sort) : null;
    return ok({ items, nextCursor });
  };

  const appendGroup = (entries: Parameters<LedgerRepo['append']>[0]): LedgerEntryRow[] => {
    const groupId = deps.ids.next('ledger');
    const now = deps.clock.now();
    const stmt = driver.prepare(
      `INSERT INTO ledger_entries (id, scope, run_id, project_id, attempt_id, type, bucket, delta_microusd, certainty,
         price_catalog_version, group_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    );
    return entries.map((e) => {
      invariant(Number.isSafeInteger(e.deltaMicrousd), 'ledger delta must be a safe-integer µUSD amount');
      const row = stmt.get(
        deps.ids.next('ledger'),
        e.scope,
        e.runId ?? null,
        e.projectId ?? null,
        e.attemptId ?? null,
        e.type,
        e.bucket,
        e.deltaMicrousd,
        e.certainty ?? null,
        e.priceCatalogVersion ?? null,
        groupId,
        e.note ?? null,
        e.createdAt ?? now,
      );
      return mapLedgerEntry(row);
    });
  };

  return {
    append(entries) {
      // One group is all-or-nothing: a failing entry must never leave the others behind (joins an open tx).
      return deps.inTx(() => appendGroup(entries));
    },
    runBalances(runId) {
      const r = new RowReader('run_budget_v', driver.prepare(RUN_BALANCES_SQL).get(runId), 'l');
      return { L: r.money('l'), C: r.money('c'), R: r.money('r'), U: r.money('u') };
    },
    projectMonthBalances(projectId: ProjectId, monthStartMs, monthEndMs) {
      return readWindow(driver.prepare(PROJECT_WINDOW_SQL).get(monthStartMs, monthEndMs, projectId));
    },
    projectMonthEstimated(projectId: ProjectId, monthStartMs, monthEndMs) {
      return new RowReader('ledger_entries', driver.prepare(PROJECT_WINDOW_ESTIMATED_SQL).get(monthStartMs, monthEndMs, projectId), 'e').money('e');
    },
    setupBalances(monthStartMs, monthEndMs) {
      return readWindow(driver.prepare(SETUP_WINDOW_SQL).get(monthStartMs, monthEndMs));
    },
    attemptBalances(attemptId: AttemptId) {
      const row = driver
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN bucket = 'reserved' THEN delta_microusd END), 0) AS reserved,
             COALESCE(SUM(CASE WHEN bucket = 'unknown' THEN delta_microusd END), 0) AS unknown,
             COALESCE(SUM(CASE WHEN bucket = 'settled' THEN delta_microusd END), 0) AS settled
           FROM ledger_entries WHERE attempt_id = ?`,
        )
        .get(attemptId);
      const r = new RowReader('ledger_entries', row, 'reserved');
      return { reserved: r.money('reserved'), unknown: r.money('unknown'), settled: r.money('settled') };
    },
    openUnknownLiabilities() {
      return driver
        .prepare(
          `SELECT attempt_id, SUM(delta_microusd) AS u, MIN(created_at) AS first_at FROM ledger_entries
           WHERE bucket = 'unknown' GROUP BY attempt_id HAVING SUM(delta_microusd) > 0 ORDER BY first_at, attempt_id`,
        )
        .all()
        .map((row) => {
          const r = new RowReader('ledger_entries', row, 'u');
          return { attemptId: r.idN('attempt_id', 'attempt'), microusd: r.money('u') };
        });
    },
    list,
    runCosts(runId) {
      return readRunCosts(driver.prepare(RUN_COSTS_SQL).get(runId));
    },
    listForRun(runId) {
      return driver.prepare(`${WITH_STEP_SELECT} WHERE l.run_id = ? ORDER BY l.created_at, l.id`).all(runId).map(withStep);
    },
    listForProjectWindow(projectId, startMs, endMs) {
      return driver
        .prepare(
          `${WITH_STEP_SELECT} WHERE l.scope = 'run' AND l.project_id = ? AND l.created_at >= ? AND l.created_at < ?
           ORDER BY l.created_at, l.id`,
        )
        .all(projectId, startMs, endMs)
        .map(withStep);
    },
    attemptsOverran(runId) {
      return readRunCosts(driver.prepare(RUN_COSTS_SQL).get(runId)).attemptsOverran;
    },
    settledByCertainty(runId) {
      return readRunCosts(driver.prepare(RUN_COSTS_SQL).get(runId)).settledByCertainty;
    },
  };
}
