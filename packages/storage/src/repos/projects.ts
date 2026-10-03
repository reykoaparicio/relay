import type { EpochMs, ProjectId, Result } from '@relay/contracts';
import { RelayError, err, errors, idSchema, microusd, ok } from '@relay/contracts';
import type { SqlDriver } from '../driver.js';
import { mapProject, mapProjectWithRoot, readInt, RowReader } from '../mappers.js';
import { ACTIVE_STATUS_IN, bit, jsonParam, optionalParams, optionalSetClause, toJson } from '../sql.js';
import type { ProjectPatch, ProjectRepo, ProjectRow } from '../types.js';
import type { RepoDeps } from './deps.js';

const UPDATE_SQL = `UPDATE projects SET ${optionalSetClause([
  'name',
  'exclusions_json',
  'allowed_provider_ids_json',
  'provider_options_json',
  'monthly_allowance_microusd',
])}, updated_at = ? WHERE id = ? AND updated_at = ? AND archived_at IS NULL`;

export function createProjectRepo(driver: SqlDriver, deps: RepoDeps): ProjectRepo {
  const find = (id: ProjectId): ProjectRow | undefined => {
    const row = driver.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return row === undefined ? undefined : mapProject(row);
  };
  const get = (id: ProjectId): ProjectRow => {
    const p = find(id);
    if (p === undefined) {
      throw new RelayError(errors.notFound('project'));
    }
    return p;
  };
  return {
    insert(p) {
      driver
        .prepare(
          `INSERT INTO projects (id, name, root_realpath, root_display_path, exclusions_json, allowed_provider_ids_json,
             provider_options_json, monthly_allowance_microusd, is_demo, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          p.id,
          p.name,
          p.rootRealpath,
          p.rootDisplayPath,
          toJson(p.exclusions),
          toJson(p.providerPolicy.allowedProviderIds),
          toJson(p.providerPolicy.providerOptions),
          p.monthlyAllowanceMicrousd,
          bit(p.isDemo),
          p.createdAt,
          p.createdAt,
        );
      return get(p.id);
    },
    get,
    find,
    getWithRoot(id) {
      const row = driver.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      if (row === undefined) {
        throw new RelayError(errors.notFound('project'));
      }
      return mapProjectWithRoot(row);
    },
    list(opts = {}) {
      return driver
        .prepare('SELECT * FROM projects WHERE (? = 1 OR archived_at IS NULL) ORDER BY created_at DESC, id DESC')
        .all(bit(opts.includeArchived ?? false))
        .map(mapProject);
    },
    findActiveByRoot(rootRealpath) {
      const row = driver.prepare('SELECT * FROM projects WHERE root_realpath = ? AND archived_at IS NULL').get(rootRealpath);
      return row === undefined ? undefined : mapProject(row);
    },
    update(id: ProjectId, patch: ProjectPatch, expectedUpdatedAt: EpochMs): Result<ProjectRow> {
      const current = find(id);
      if (current === undefined) {
        return err(errors.notFound('project'));
      }
      if (current.archivedAt !== null) {
        // An archived project is read-only; the SQL guard below enforces the same rule under the CAS.
        return err(errors.conflict({ entity: 'project', reason: 'archived', currentUpdatedAt: current.updatedAt }));
      }
      // Strictly increasing so a second writer holding the same expectedUpdatedAt always conflicts.
      const now = Math.max(deps.clock.now(), current.updatedAt + 1);
      const changes = driver
        .prepare(UPDATE_SQL)
        .run(
          ...optionalParams([
            patch.name,
            jsonParam(patch.exclusions),
            jsonParam(patch.providerPolicy?.allowedProviderIds),
            jsonParam(patch.providerPolicy?.providerOptions),
            patch.monthlyAllowanceMicrousd,
          ]),
          now,
          id,
          expectedUpdatedAt,
        ).changes;
      if (changes === 0) {
        return err(errors.conflict({ entity: 'project', currentUpdatedAt: current.updatedAt }));
      }
      return ok(get(id));
    },
    archive(id) {
      return deps.inTx(() => {
        const current = find(id);
        if (current === undefined || current.archivedAt !== null) {
          return false;
        }
        // Same strictly increasing rule as update: a wall clock at (or behind) the stored value must still move
        // updated_at forward, or a writer holding the old value could CAS over the archive (ABA).
        const now = deps.clock.now();
        const updatedAt = Math.max(now, current.updatedAt + 1);
        return (
          driver
            .prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL')
            .run(now, updatedAt, id).changes > 0
        );
      });
    },
    unarchive(id) {
      return deps.inTx((): Result<ProjectRow> => {
        const current = find(id);
        if (current === undefined) return err(errors.notFound('project'));
        if (current.archivedAt === null) return err(errors.conflict({ entity: 'project', reason: 'not_archived' }));
        const root = mapProjectWithRoot(driver.prepare('SELECT * FROM projects WHERE id = ?').get(id)).rootRealpath;
        const clash = driver.prepare('SELECT id FROM projects WHERE root_realpath = ? AND archived_at IS NULL').get(root);
        if (clash !== undefined) {
          // projects_root_active_uq: one active project per folder.
          return err(errors.conflict({ entity: 'project', reason: 'root_already_used', projectId: new RowReader('projects', clash).as('id', idSchema('project')) }));
        }
        const updatedAt = Math.max(deps.clock.now(), current.updatedAt + 1);
        driver.prepare('UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL').run(updatedAt, id);
        return ok(get(id));
      });
    },
    setRoot(id, root, expectedUpdatedAt) {
      return deps.inTx((): Result<ProjectRow> => {
        const current = find(id);
        if (current === undefined) return err(errors.notFound('project'));
        if (current.archivedAt !== null) return err(errors.conflict({ entity: 'project', reason: 'archived' }));
        if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
          return err(errors.conflict({ entity: 'project', currentUpdatedAt: current.updatedAt }));
        }
        const clash = driver.prepare('SELECT id FROM projects WHERE root_realpath = ? AND archived_at IS NULL AND id <> ?').get(root.rootRealpath, id);
        if (clash !== undefined) return err(errors.conflict({ entity: 'project', reason: 'root_already_used' }));
        const updatedAt = Math.max(deps.clock.now(), current.updatedAt + 1);
        driver.prepare('UPDATE projects SET root_realpath = ?, root_display_path = ?, updated_at = ? WHERE id = ?')
          .run(root.rootRealpath, root.rootDisplayPath, updatedAt, id);
        return ok(get(id));
      });
    },
    stats(id, monthStart) {
      const row = driver
        .prepare(
          `SELECT
             (SELECT count(*) FROM runs WHERE project_id = ?1) AS runs,
             (SELECT id FROM runs WHERE project_id = ?1 AND ${ACTIVE_STATUS_IN}
               ORDER BY created_at DESC, id DESC LIMIT 1) AS active_run_id,
             (SELECT count(*) FROM memory_records WHERE project_id = ?1 AND status = 'approved') AS approved_memory,
             (SELECT count(*) FROM memory_records WHERE project_id = ?1 AND status = 'suggested') AS suggestions,
             (SELECT COALESCE(SUM(delta_microusd), 0) FROM ledger_entries
               WHERE scope = 'run' AND project_id = ?1 AND bucket = 'settled' AND created_at >= ?2) AS tracked`,
        )
        .get(id, monthStart);
      const r = new RowReader('projects', row, 'active_run_id');
      return {
        runs: r.int('runs'),
        activeRunId: r.asN('active_run_id', idSchema('run')),
        approvedMemory: r.int('approved_memory'),
        suggestions: r.int('suggestions'),
        trackedMonthMicrousd: microusd(readInt('projects', row, 'tracked')),
      };
    },
  };
}
