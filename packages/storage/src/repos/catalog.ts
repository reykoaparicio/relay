import type { SqlDriver } from '../driver.js';
import { mapCatalog, RowReader } from '../mappers.js';
import { toJson } from '../sql.js';
import type { CatalogRepo } from '../types.js';
import type { RepoDeps } from './deps.js';

// Latest catalog version per (provider, model); ISO-date versions sort lexicographically.
const LATEST_PER_MODEL = `SELECT c.* FROM model_catalog c
  WHERE (?1 IS NULL OR c.provider_id = ?1)
    AND c.catalog_version = (SELECT max(catalog_version) FROM model_catalog m
                             WHERE m.provider_id = c.provider_id AND m.model_id = c.model_id)
  ORDER BY c.provider_id, c.model_id`;

export function createCatalogRepo(driver: SqlDriver, deps: Pick<RepoDeps, 'inTx'>): CatalogRepo {
  const upsertAll = (entries: Parameters<CatalogRepo['upsertMany']>[0]): number => {
    const stmt = driver.prepare(
      `INSERT INTO model_catalog (provider_id, model_id, catalog_version, display_name, capabilities_json, prices_json,
         effective_date, source, source_retrieved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider_id, model_id, catalog_version) DO NOTHING`,
    );
    let inserted = 0;
    for (const e of entries) {
      inserted += stmt.run(
        e.providerId,
        e.modelId,
        e.catalogVersion,
        e.displayName,
        toJson(e.capabilities),
        toJson(e.prices),
        e.effectiveDate,
        e.source,
        e.sourceRetrievedAt,
      ).changes;
    }
    return inserted;
  };
  return {
    upsertMany(entries) {
      // One catalog import is all-or-nothing (joins an open tx).
      return deps.inTx(() => upsertAll(entries));
    },
    get(providerId, modelId, version) {
      const row = driver
        .prepare(
          `SELECT * FROM model_catalog WHERE provider_id = ? AND model_id = ? AND (?3 IS NULL OR catalog_version = ?3)
           ORDER BY catalog_version DESC LIMIT 1`,
        )
        .get(providerId, modelId, version ?? null);
      return row === undefined ? undefined : mapCatalog(row);
    },
    list(providerId) {
      return driver.prepare(LATEST_PER_MODEL).all(providerId ?? null).map(mapCatalog);
    },
    latestVersion() {
      const row = driver.prepare('SELECT max(catalog_version) AS v FROM model_catalog').get();
      return new RowReader('model_catalog', row, 'v').textN('v');
    },
  };
}
