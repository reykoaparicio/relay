// Shared ledger aggregate SQL (used by the ledger repo and the run inspector projection).

/** `{L, C, R, U}` of one run from `run_budget_v` (§9.3). */
export const RUN_BALANCES_SQL = `SELECT
  COALESCE(MAX(allowance_l), 0) AS l, COALESCE(MAX(settled_c), 0) AS c,
  COALESCE(MAX(reserved_r), 0) AS r, COALESCE(MAX(unknown_u), 0) AS u
  FROM run_budget_v WHERE run_id = ?`;

/**
 * Run balances plus settled split by certainty, in one statement (inspector projection). `overran` = some attempt of
 * the run settled more than it reserved (§9.5; the same rule as the engine's `attemptsOverran` over the entries).
 */
export const RUN_COSTS_SQL = `SELECT
  COALESCE(SUM(CASE WHEN bucket = 'allowance' THEN delta_microusd END), 0) AS l,
  COALESCE(SUM(CASE WHEN bucket = 'settled' THEN delta_microusd END), 0) AS c,
  COALESCE(SUM(CASE WHEN bucket = 'reserved' THEN delta_microusd END), 0) AS r,
  COALESCE(SUM(CASE WHEN bucket = 'unknown' THEN delta_microusd END), 0) AS u,
  COALESCE(SUM(CASE WHEN bucket = 'settled' AND certainty = 'reported' THEN delta_microusd END), 0) AS s_reported,
  COALESCE(SUM(CASE WHEN bucket = 'settled' AND certainty = 'calculated' THEN delta_microusd END), 0) AS s_calculated,
  COALESCE(SUM(CASE WHEN bucket = 'settled' AND certainty = 'estimated' THEN delta_microusd END), 0) AS s_estimated,
  COALESCE(SUM(CASE WHEN bucket = 'settled' AND certainty = 'unknown' THEN delta_microusd END), 0) AS s_unknown,
  EXISTS (SELECT 1 FROM ledger_entries a WHERE a.scope = 'run' AND a.run_id = ?1 AND a.attempt_id IS NOT NULL
    GROUP BY a.attempt_id
    HAVING SUM(CASE WHEN a.type = 'reserve' THEN 1 ELSE 0 END) > 0
       AND SUM(CASE WHEN a.type = 'settle' THEN a.delta_microusd ELSE 0 END) > SUM(CASE WHEN a.type = 'reserve' THEN a.delta_microusd ELSE 0 END)
  ) AS overran
  FROM ledger_entries WHERE scope = 'run' AND run_id = ?1`;
