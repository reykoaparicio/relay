import type { ApprovalId } from '@relay/contracts';
import { invariant } from '@relay/contracts';
import type { SqlDriver } from '../driver.js';
import { mapApproval } from '../mappers.js';
import { toJson } from '../sql.js';
import type { ApprovalRepo, ApprovalRow } from '../types.js';

export function createApprovalRepo(driver: SqlDriver): ApprovalRepo {
  const get = (id: ApprovalId): ApprovalRow | undefined => {
    const row = driver.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    return row === undefined ? undefined : mapApproval(row);
  };
  const latest = (sql: string, runId: string): ApprovalRow | undefined => {
    const row = driver.prepare(`${sql} ORDER BY created_at DESC, id DESC LIMIT 1`).get(runId);
    return row === undefined ? undefined : mapApproval(row);
  };
  return {
    insert(a) {
      driver
        .prepare(
          `INSERT INTO approvals (id, run_id, step_run_id, plan_artifact_id, plan_hash, context_hash, file_scope_json,
             requested_permissions_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          a.id,
          a.runId,
          a.stepRunId,
          a.planArtifactId,
          a.planHash,
          a.contextHash,
          toJson(a.fileScope),
          toJson(a.requestedPermissions),
          a.createdAt,
        );
      const row = get(a.id);
      invariant(row !== undefined, 'approval missing after insert');
      return row;
    },
    get,
    listForRun(runId) {
      return driver.prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at, id').all(runId).map(mapApproval);
    },
    pendingForRun(runId) {
      return latest('SELECT * FROM approvals WHERE run_id = ? AND decision IS NULL AND invalidated_at IS NULL', runId);
    },
    latestApprovedForRun(runId) {
      return latest("SELECT * FROM approvals WHERE run_id = ? AND decision = 'approved' AND invalidated_at IS NULL", runId);
    },
    decide(id, decision, note, at) {
      return (
        driver
          .prepare(
            `UPDATE approvals SET decision = ?, decision_note = ?, decided_at = ?
             WHERE id = ? AND decision IS NULL AND invalidated_at IS NULL`,
          )
          .run(decision, note, at, id).changes > 0
      );
    },
    invalidate(id, reason, at) {
      return (
        driver
          .prepare('UPDATE approvals SET invalidated_at = ?, invalidated_reason = ? WHERE id = ? AND invalidated_at IS NULL')
          .run(at, reason, id).changes > 0
      );
    },
  };
}
