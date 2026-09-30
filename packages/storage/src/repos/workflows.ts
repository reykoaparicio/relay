import type { Result, WorkflowId, WorkflowVersionId } from '@relay/contracts';
import { err, errors, invariant, ok } from '@relay/contracts';
import type { SqlDriver } from '../driver.js';
import { mapWorkflow, mapWorkflowVersion } from '../mappers.js';
import { jsonParam, optionalParams, optionalSetClause, toJson } from '../sql.js';
import type { WorkflowRepo, WorkflowRow, WorkflowVersionRow } from '../types.js';
import type { RepoDeps } from './deps.js';

const UPDATE_DRAFT_SQL = `UPDATE workflow_versions SET ${optionalSetClause(['spec_json', 'prompts_json'])},
  content_hash = ?, draft_revision = draft_revision + 1
  WHERE workflow_id = ? AND status = 'draft' AND draft_revision = ?`;

export function createWorkflowRepo(driver: SqlDriver, deps: RepoDeps): WorkflowRepo {
  const one = (sql: string, ...params: (string | number)[]): WorkflowVersionRow | undefined => {
    const row = driver.prepare(sql).get(...params);
    return row === undefined ? undefined : mapWorkflowVersion(row);
  };
  const getVersionById = (id: WorkflowVersionId): WorkflowVersionRow | undefined =>
    one('SELECT * FROM workflow_versions WHERE id = ?', id);
  const getDraft = (workflowId: WorkflowId): WorkflowVersionRow | undefined =>
    one("SELECT * FROM workflow_versions WHERE workflow_id = ? AND status = 'draft'", workflowId);
  const getWorkflowBySlug = (slug: string): WorkflowRow | undefined => {
    const row = driver.prepare('SELECT * FROM workflows WHERE slug = ?').get(slug);
    return row === undefined ? undefined : mapWorkflow(row);
  };

  return {
    ensureWorkflow(slug, name) {
      driver
        .prepare('INSERT INTO workflows (id, slug, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (slug) DO NOTHING')
        .run(deps.ids.next('workflow'), slug, name, deps.clock.now());
      const row = getWorkflowBySlug(slug);
      invariant(row !== undefined, 'workflow missing after ensureWorkflow');
      return row;
    },
    getWorkflow(id) {
      const row = driver.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
      return row === undefined ? undefined : mapWorkflow(row);
    },
    listWorkflows() {
      return driver.prepare('SELECT * FROM workflows ORDER BY created_at, id').all().map(mapWorkflow);
    },
    getVersion(workflowId, version) {
      if (version === 'draft') {
        return getDraft(workflowId);
      }
      return one('SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?', workflowId, version);
    },
    getVersionById,
    latestValidated(workflowId) {
      return one(
        "SELECT * FROM workflow_versions WHERE workflow_id = ? AND status = 'validated' ORDER BY version DESC LIMIT 1",
        workflowId,
      );
    },
    insertVersion(v) {
      driver
        .prepare(
          `INSERT INTO workflow_versions (id, workflow_id, version, status, schema_version, spec_json, prompts_json,
             content_hash, based_on_version, created_at, validated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          v.id,
          v.workflowId,
          v.version,
          v.status,
          v.schemaVersion,
          toJson(v.spec),
          toJson(v.prompts),
          v.contentHash,
          v.basedOnVersion,
          v.createdAt,
          v.validatedAt ?? null,
        );
      const row = getVersionById(v.id);
      invariant(row !== undefined, 'workflow version missing after insert');
      return row;
    },
    updateDraft(workflowId, patch, expectedDraftRevision): Result<WorkflowVersionRow> {
      const draft = getDraft(workflowId);
      if (draft === undefined) {
        return err(errors.notFound('workflow_draft'));
      }
      const changes = driver
        .prepare(UPDATE_DRAFT_SQL)
        .run(
          ...optionalParams([jsonParam(patch.spec), jsonParam(patch.prompts)]),
          patch.contentHash,
          workflowId,
          expectedDraftRevision,
        ).changes;
      if (changes === 0) {
        return err(errors.conflict({ entity: 'workflow_draft', currentDraftRevision: draft.draftRevision }));
      }
      const row = getVersionById(draft.id);
      return row === undefined ? err(errors.notFound('workflow_draft')) : ok(row);
    },
    markValidated(id, at) {
      return (
        driver
          .prepare("UPDATE workflow_versions SET status = 'validated', validated_at = ? WHERE id = ? AND status = 'draft'")
          .run(at, id).changes > 0
      );
    },
  };
}
