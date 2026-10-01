// Shared ledger aggregate SQL (used by the ledger repo and the run projections).

/** `{L, C, R, U}` of one run from `run_budget_v` (§9.3). */
export const RUN_BALANCES_SQL = `SELECT
  COALESCE(MAX(allowance_l), 0) AS l, COALESCE(MAX(settled_c), 0) AS c,
  COALESCE(MAX(reserved_r), 0) AS r, COALESCE(MAX(unknown_u), 0) AS u
  FROM run_budget_v WHERE run_id = ?`;

/** Balances + settled split by certainty over the `ledger_entries` rows in scope (aliased `l`). */
const COST_COLUMNS = `COALESCE(SUM(CASE WHEN l.bucket = 'allowance' THEN l.delta_microusd END), 0) AS l,
  COALESCE(SUM(CASE WHEN l.bucket = 'settled' THEN l.delta_microusd END), 0) AS c,
  COALESCE(SUM(CASE WHEN l.bucket = 'reserved' THEN l.delta_microusd END), 0) AS r,
  COALESCE(SUM(CASE WHEN l.bucket = 'unknown' THEN l.delta_microusd END), 0) AS u,
  COALESCE(SUM(CASE WHEN l.bucket = 'settled' AND l.certainty = 'reported' THEN l.delta_microusd END), 0) AS s_reported,
  COALESCE(SUM(CASE WHEN l.bucket = 'settled' AND l.certainty = 'calculated' THEN l.delta_microusd END), 0) AS s_calculated,
  COALESCE(SUM(CASE WHEN l.bucket = 'settled' AND l.certainty = 'estimated' THEN l.delta_microusd END), 0) AS s_estimated,
  COALESCE(SUM(CASE WHEN l.bucket = 'settled' AND l.certainty = 'unknown' THEN l.delta_microusd END), 0) AS s_unknown`;

/** `overran` = some attempt of the run `runRef` settled more than it reserved (§9.5; = the engine's `attemptsOverran`). */
const overranColumn = (runRef: string): string => `EXISTS (SELECT 1 FROM ledger_entries a
    WHERE a.scope = 'run' AND a.run_id = ${runRef} AND a.attempt_id IS NOT NULL
    GROUP BY a.attempt_id
    HAVING SUM(CASE WHEN a.type = 'reserve' THEN 1 ELSE 0 END) > 0
       AND SUM(CASE WHEN a.type = 'settle' THEN a.delta_microusd ELSE 0 END) > SUM(CASE WHEN a.type = 'reserve' THEN a.delta_microusd ELSE 0 END)
  ) AS overran`;

/** Run balances, settled split by certainty, and `overran`, in one statement (`LedgerRepo.runCosts`). */
export const RUN_COSTS_SQL = `SELECT ${COST_COLUMNS},
  ${overranColumn('?1')}
  FROM ledger_entries l WHERE l.scope = 'run' AND l.run_id = ?1`;

/**
 * {@link RUN_COSTS_SQL} for many runs in one statement (`?1` = JSON array of run ids), one row per run that has
 * ledger entries (`run_id` column). A run without entries has no row: its costs are all zero.
 */
export const RUNS_COSTS_SQL = `SELECT l.run_id AS run_id, ${COST_COLUMNS},
  ${overranColumn('l.run_id')}
  FROM ledger_entries l WHERE l.scope = 'run' AND l.run_id IN (SELECT value FROM json_each(?1))
  GROUP BY l.run_id`;
