import type { ProfileId, Result } from '@relay/contracts';
import { err, errors, ok } from '@relay/contracts';
import type { SqlDriver } from '../driver.js';
import { isSqliteConstraint } from '../errors.js';
import { mapProfile } from '../mappers.js';
import { toJson } from '../sql.js';
import type { ProfileRepo, ProfileRow, ProfileUpsert } from '../types.js';
import type { RepoDeps } from './deps.js';

export function createProfileRepo(driver: SqlDriver, deps: RepoDeps): ProfileRepo {
  const get = (id: ProfileId): ProfileRow | undefined => {
    const row = driver.prepare('SELECT * FROM model_profiles WHERE id = ?').get(id);
    return row === undefined ? undefined : mapProfile(row);
  };

  const insert = (p: ProfileUpsert, now: number): void => {
    driver
      .prepare(
        `INSERT INTO model_profiles (id, name, provider_id, model_id, params_json, capabilities_snapshot_json,
           catalog_version, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(p.id, p.name, p.providerId, p.modelId, toJson(p.params), toJson(p.capabilitiesSnapshot), p.catalogVersion, now, now);
  };

  const update = (p: ProfileUpsert, revision: number, now: number): number =>
    driver
      .prepare(
        `UPDATE model_profiles SET name = ?, provider_id = ?, model_id = ?, params_json = ?, capabilities_snapshot_json = ?,
           catalog_version = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(p.name, p.providerId, p.modelId, toJson(p.params), toJson(p.capabilitiesSnapshot), p.catalogVersion, now, p.id, revision)
      .changes;

  const write = (p: ProfileUpsert, expectedRevision: number | undefined): Result<ProfileRow> => {
    const existing = get(p.id);
    const now = deps.clock.now();
    if (existing === undefined) {
      if (expectedRevision !== undefined) {
        return err(errors.notFound('profile'));
      }
      insert(p, now);
    } else {
      const expected = expectedRevision ?? existing.revision;
      if (update(p, expected, now) === 0) {
        return err(errors.conflict({ entity: 'profile', currentRevision: existing.revision }));
      }
    }
    const row = get(p.id);
    return row === undefined ? err(errors.notFound('profile')) : ok(row);
  };

  return {
    list() {
      return driver.prepare('SELECT * FROM model_profiles ORDER BY name').all().map(mapProfile);
    },
    get,
    getByName(name) {
      const row = driver.prepare('SELECT * FROM model_profiles WHERE name = ?').get(name);
      return row === undefined ? undefined : mapProfile(row);
    },
    upsert(p, expectedRevision) {
      try {
        return write(p, expectedRevision);
      } catch (e) {
        if (isSqliteConstraint(e)) {
          return err(errors.conflict({ entity: 'profile', field: 'name' }));
        }
        throw e;
      }
    },
    delete(id) {
      return driver.prepare('DELETE FROM model_profiles WHERE id = ?').run(id).changes > 0;
    },
  };
}
