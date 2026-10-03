import type { ProjectId, Result, RunId, RunStatus } from '@relay/contracts';
import { RelayError, TERMINAL_RUN_STATUSES, errors, idSchema, invariant, isTerminalRunStatus, ok } from '@relay/contracts';
import { decodeCursor, encodeCursor } from '../cursor.js';
import type { SqlDriver, SqlParam } from '../driver.js';
import { mapApproval, mapAttempt, mapInputFile, mapRun, mapStep, RowReader } from '../mappers.js';
import { ACTIVE_STATUS_IN, bit, KEYSET, toJson } from '../sql.js';
import type {
  InspectorProjection,
  Page,
  RunCosts,
  RunListQuery,
  RunRepo,
  RunRow,
  RunStatusFields,
  RunSummaryProjection,
  RunWorkflowRef,
} from '../types.js';
import type { RepoDeps } from './deps.js';
import { RUNS_COSTS_SQL, RUN_COSTS_SQL } from './ledger-sql.js';

/** Status filter via json_each keeps one static statement per sort (00b §4: whitelisted fragments only). */
const listSql = (sort: 'created_desc' | 'created_asc', withCursor: boolean): string =>
  `SELECT * FROM runs WHERE project_id = ?
     AND (?2 IS NULL OR status IN (SELECT value FROM json_each(?2)))
     ${withCursor ? `AND ${KEYSET[sort].after}` : ''}
   ${KEYSET[sort].order} LIMIT ?`;

const UPDATE_STATUS_SQL = `UPDATE runs SET status = ?, pause_reason = ?, status_detail_json = ?, ended_at = ?,
    started_at = COALESCE(?, started_at), updated_at = ?
  WHERE id = ? AND status IN (SELECT value FROM json_each(?))`;

/** Reads one {@link RUN_COSTS_SQL} / {@link RUNS_COSTS_SQL} row. */
export function readRunCosts(row: unknown): RunCosts {
  const r = new RowReader('ledger_entries', row, 'l');
  return {
    attemptsOverran: r.bool('overran'),
    balances: { L: r.money('l'), C: r.money('c'), R: r.money('r'), U: r.money('u') },
    settledByCertainty: {
      reported: r.money('s_reported'),
      calculated: r.money('s_calculated'),
      estimated: r.money('s_estimated'),
      unknown: r.money('s_unknown'),
    },
  };
}

const ZERO_COSTS: RunCosts = readRunCosts({ l: 0, c: 0, r: 0, u: 0, s_reported: 0, s_calculated: 0, s_estimated: 0, s_unknown: 0, overran: 0 });

/** Workflow of each run (`?1` = JSON array of run ids). */
const RUNS_WORKFLOW_SQL = `SELECT r.id AS run_id, w.id AS wf_id, w.name AS wf_name, v.version AS wf_version
  FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id
  WHERE r.id IN (SELECT value FROM json_each(?1))`;

/** Latest-row step progress of each run (`?1` = JSON array of run ids); = the engine's `latestPerKey` + done count. */
const RUNS_PROGRESS_SQL = `SELECT s.run_id AS run_id, COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN s.state IN ('succeeded', 'skipped') THEN 1 ELSE 0 END), 0) AS done
  FROM step_runs s WHERE s.run_id IN (SELECT value FROM json_each(?1)) AND NOT EXISTS (
    SELECT 1 FROM step_runs o WHERE o.run_id = s.run_id AND o.step_key = s.step_key
      AND (o.revision_index, o.retry_index) > (s.revision_index, s.retry_index))
  GROUP BY s.run_id`;

function readWorkflowRef(row: unknown): RunWorkflowRef {
  const wf = new RowReader('workflows', row, 'wf_id');
  return { id: wf.id('wf_id', 'workflow'), name: wf.text('wf_name'), version: wf.int('wf_version') };
}

const runIdOf = (row: unknown): string => new RowReader('runs', row, 'run_id').text('run_id');

export function createRunRepo(driver: SqlDriver, deps: RepoDeps): RunRepo {
  const find = (id: RunId): RunRow | undefined => {
    const row = driver.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row === undefined ? undefined : mapRun(row);
  };
  const get = (id: RunId): RunRow => {
    const run = find(id);
    if (run === undefined) {
      throw new RelayError(errors.notFound('run'));
    }
    return run;
  };
  const touch = (sql: string, ...params: SqlParam[]): void => {
    driver.prepare(sql).run(...params);
  };

  const list = (q: RunListQuery): Result<Page<RunRow>> => {
    const sort = q.sort ?? 'created_desc';
    const statuses = q.statuses === undefined ? null : JSON.stringify(q.statuses);
    let rows: unknown[];
    if (q.cursor === undefined) {
      rows = driver.prepare(listSql(sort, false)).all(q.projectId, statuses, q.limit + 1);
    } else {
      const pos = decodeCursor(q.cursor, sort);
      if (!pos.ok) {
        return pos;
      }
      rows = driver.prepare(listSql(sort, true)).all(q.projectId, statuses, pos.value.createdAt, pos.value.id, q.limit + 1);
    }
    const items = rows.slice(0, q.limit).map(mapRun);
    const last = items.at(-1);
    const nextCursor = rows.length > q.limit && last !== undefined ? encodeCursor({ createdAt: last.createdAt, id: last.id }, sort) : null;
    return ok({ items, nextCursor });
  };

  const updateStatus = <To extends RunStatus>(
    id: RunId,
    from: readonly RunStatus[],
    to: To,
    fields: RunStatusFields<To>,
  ): boolean => {
    const pauseReason = to === 'paused' ? (fields.pauseReason ?? null) : null;
    invariant(to !== 'paused' || pauseReason !== null, 'a paused run requires a pauseReason');
    const now = deps.clock.now();
    const endedAt = isTerminalRunStatus(to) ? (fields.endedAt ?? now) : null;
    const detail = fields.statusDetail === undefined || fields.statusDetail === null ? null : toJson(fields.statusDetail);
    const changes = driver
      .prepare(UPDATE_STATUS_SQL)
      .run(to, pauseReason, detail, endedAt, fields.startedAt ?? null, now, id, JSON.stringify(from)).changes;
    return changes > 0;
  };

  const getInspectorProjection = (runId: RunId): InspectorProjection => {
    // 1: run + workflow meta
    const row = driver
      .prepare(
        `SELECT r.*, w.id AS wf_id, w.name AS wf_name, v.version AS wf_version
         FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id JOIN workflows w ON w.id = v.workflow_id
         WHERE r.id = ?`,
      )
      .get(runId);
    if (row === undefined) {
      throw new RelayError(errors.notFound('run'));
    }
    // 2–6: steps, attempts, ledger aggregates, pending approval, latest report artifact
    const steps = driver
      .prepare('SELECT * FROM step_runs WHERE run_id = ? ORDER BY ordinal, revision_index, retry_index')
      .all(runId)
      .map(mapStep);
    const attempts = driver.prepare('SELECT * FROM attempts WHERE run_id = ? ORDER BY created_at, seq').all(runId).map(mapAttempt);
    const costs = readRunCosts(driver.prepare(RUN_COSTS_SQL).get(runId));
    const approval = driver
      .prepare(
        `SELECT * FROM approvals WHERE run_id = ? AND decision IS NULL AND invalidated_at IS NULL
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(runId);
    const report = driver
      .prepare("SELECT id FROM artifacts WHERE run_id = ? AND kind = 'report' ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(runId);
    return {
      run: mapRun(row),
      workflow: readWorkflowRef(row),
      steps,
      attempts,
      ...costs,
      pendingApproval: approval === undefined ? null : mapApproval(approval),
      reportArtifactId: report === undefined ? null : new RowReader('artifacts', report).as('id', idSchema('artifact')),
    };
  };

  /** 3 statements for any number of runs: workflow, progress, costs (each grouped over the ids). */
  const summariesFor = (runs: readonly RunRow[]): RunSummaryProjection[] => {
    if (runs.length === 0) return [];
    const ids = JSON.stringify(runs.map((r) => r.id));
    const workflows = new Map(driver.prepare(RUNS_WORKFLOW_SQL).all(ids).map((row) => [runIdOf(row), readWorkflowRef(row)]));
    const progress = new Map(
      driver.prepare(RUNS_PROGRESS_SQL).all(ids).map((row) => {
        const p = new RowReader('step_runs', row, 'run_id');
        return [runIdOf(row), { done: p.int('done'), total: p.int('total') }];
      }),
    );
    const costs = new Map(driver.prepare(RUNS_COSTS_SQL).all(ids).map((row) => [runIdOf(row), readRunCosts(row)]));
    return runs.map((run) => {
      const workflow = workflows.get(run.id);
      invariant(workflow !== undefined, 'every run references a workflow version (FK)');
      return { run, workflow, stepProgress: progress.get(run.id) ?? { done: 0, total: 0 }, ...(costs.get(run.id) ?? ZERO_COSTS) };
    });
  };

  return {
    insert(run) {
      driver
        .prepare(
          `INSERT INTO runs (id, project_id, workflow_version_id, goal, status, input_json, snapshot_json, limits_json,
             context_hash, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.projectId,
          run.workflowVersionId,
          run.goal,
          run.status ?? 'queued',
          toJson(run.input),
          toJson(run.snapshot),
          toJson(run.limits),
          run.contextHash ?? null,
          run.idempotencyKey,
          run.createdAt,
          run.createdAt,
        );
      return get(run.id);
    },
    get,
    find,
    findByIdempotencyKey(key) {
      // `runs.idempotency_key` is UNIQUE (0001), so its implicit index serves this one-row lookup.
      const row = driver.prepare('SELECT * FROM runs WHERE idempotency_key = ?').get(key);
      return row === undefined ? undefined : mapRun(row);
    },
    list,
    updateStatus,
    nextQueued() {
      const row = driver.prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").get();
      return row === undefined ? undefined : mapRun(row);
    },
    listActive() {
      // Literal IN list (not json_each): the planner then uses the runs_active_idx partial index.
      return driver.prepare(`SELECT * FROM runs WHERE ${ACTIVE_STATUS_IN} ORDER BY created_at, id`).all().map(mapRun);
    },
    listTerminalWithoutReport() {
      return driver
        .prepare(
          `SELECT * FROM runs WHERE status IN (SELECT value FROM json_each(?))
             AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.run_id = runs.id AND a.kind = 'report')
           ORDER BY created_at, id`,
        )
        .all(JSON.stringify(TERMINAL_RUN_STATUSES))
        .map(mapRun);
    },
    listTerminalWithUncertainCosts() {
      return driver
        .prepare(
          `SELECT * FROM runs WHERE status IN (SELECT value FROM json_each(?))
             AND EXISTS (SELECT 1 FROM artifacts a WHERE a.run_id = runs.id AND a.kind = 'report')
             AND (EXISTS (SELECT 1 FROM attempts t WHERE t.run_id = runs.id AND t.outcome_uncertain = 1)
               OR EXISTS (SELECT 1 FROM ledger_entries l WHERE l.run_id = runs.id AND l.bucket = 'unknown'))
           ORDER BY created_at, id`,
        )
        .all(JSON.stringify(TERMINAL_RUN_STATUSES))
        .map(mapRun);
    },
    listTerminalIdsForProject(projectId) {
      return driver
        .prepare('SELECT id FROM runs WHERE project_id = ?1 AND status IN (SELECT value FROM json_each(?2)) ORDER BY created_at, id')
        .all(projectId, JSON.stringify(TERMINAL_RUN_STATUSES))
        .map((r) => new RowReader('runs', r).as('id', idSchema('run')));
    },
    incrementAttemptCount(id) {
      touch('UPDATE runs SET attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?', deps.clock.now(), id);
    },
    setRevisionCycle(id, cycle) {
      touch('UPDATE runs SET revision_cycle = ?, updated_at = ? WHERE id = ?', cycle, deps.clock.now(), id);
    },
    setDeferredPause(id, pause) {
      touch('UPDATE runs SET deferred_pause = ?, deferred_pause_detail_json = ?, updated_at = ? WHERE id = ?',
        pause?.reason ?? null, pause === null ? null : toJson(pause.detail), deps.clock.now(), id);
    },
    setPauseRequested(id, requested) {
      touch('UPDATE runs SET pause_requested = ?, updated_at = ? WHERE id = ?', bit(requested), deps.clock.now(), id);
    },
    setContextHash(id, hash) {
      touch('UPDATE runs SET context_hash = ?, updated_at = ? WHERE id = ?', hash, deps.clock.now(), id);
    },
    setLimits(id, limits) {
      touch('UPDATE runs SET limits_json = ?, updated_at = ? WHERE id = ?', toJson(limits), deps.clock.now(), id);
    },
    enterRunning(id, now) {
      touch('UPDATE runs SET running_since = ?, updated_at = ? WHERE id = ? AND running_since IS NULL', now, now, id);
    },
    leaveRunning(id, now) {
      touch(
        `UPDATE runs SET execution_ms_used = execution_ms_used + MAX(0, ? - running_since), running_since = NULL, updated_at = ?
         WHERE id = ? AND running_since IS NOT NULL`,
        now,
        now,
        id,
      );
    },
    insertInputFiles(runId, files) {
      // All-or-nothing (joins an open tx).
      deps.inTx(() => {
        const stmt = driver.prepare(
          'INSERT INTO run_input_files (run_id, rel_path, sha256, artifact_id, size_bytes, captured_at) VALUES (?, ?, ?, ?, ?, ?)',
        );
        for (const f of files) {
          stmt.run(runId, f.relPath, f.sha256, f.artifactId, f.sizeBytes, f.capturedAt);
        }
      });
    },
    replaceInputFiles(runId, files) {
      // All-or-nothing (joins an open tx). Nothing references run_input_files, and every new row's artifact_id is
      // FK-checked against artifacts on insert; the old input_file artifacts stay (history, retention).
      deps.inTx(() => {
        driver.prepare('DELETE FROM run_input_files WHERE run_id = ?').run(runId);
        const stmt = driver.prepare(
          'INSERT INTO run_input_files (run_id, rel_path, sha256, artifact_id, size_bytes, captured_at) VALUES (?, ?, ?, ?, ?, ?)',
        );
        for (const f of files) {
          stmt.run(runId, f.relPath, f.sha256, f.artifactId, f.sizeBytes, f.capturedAt);
        }
      });
    },
    latestProjectInputFiles(projectId, limit) {
      // The newest captured hash per path over the project's runs (E2 #7 root re-point verification).
      return driver
        .prepare(
          `SELECT f.* FROM run_input_files f JOIN runs r ON r.id = f.run_id
            WHERE r.project_id = ?1
              AND f.captured_at = (SELECT MAX(g.captured_at) FROM run_input_files g JOIN runs q ON q.id = g.run_id
                                    WHERE q.project_id = ?1 AND g.rel_path = f.rel_path)
            GROUP BY f.rel_path ORDER BY f.captured_at DESC, f.rel_path LIMIT ?2`,
        )
        .all(projectId, limit)
        .map(mapInputFile);
    },
    inputFiles(runId) {
      return driver.prepare('SELECT * FROM run_input_files WHERE run_id = ? ORDER BY rel_path').all(runId).map(mapInputFile);
    },
    getInspectorProjection,
    listSummaries(q) {
      const page = list(q);
      return page.ok ? ok({ items: summariesFor(page.value.items), nextCursor: page.value.nextCursor }) : page;
    },
    summariesOf(ids) {
      if (ids.length === 0) return [];
      const rows = driver.prepare('SELECT * FROM runs WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)).map(mapRun);
      const byId = new Map(rows.map((r) => [r.id, r]));
      return summariesFor(ids.flatMap((id) => byId.get(id) ?? []));
    },
    idsForProject(projectId: ProjectId) {
      return driver
        .prepare('SELECT id FROM runs WHERE project_id = ? ORDER BY created_at, id')
        .all(projectId)
        .map((row) => new RowReader('runs', row).id('id', 'run'));
    },
    listPausedFor(projectId, pauseReason) {
      return driver
        .prepare("SELECT * FROM runs WHERE project_id = ? AND status = 'paused' AND pause_reason = ? ORDER BY created_at DESC, id DESC")
        .all(projectId, pauseReason)
        .map(mapRun);
    },
  };
}
