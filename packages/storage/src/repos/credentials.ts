import { invariant } from '@relay/contracts';
import type { SqlDriver } from '../driver.js';
import { mapCredentialRef } from '../mappers.js';
import { bit } from '../sql.js';
import type { CredentialRefRepo, CredentialRefRow } from '../types.js';
import type { RepoDeps } from './deps.js';

export function createCredentialRefRepo(driver: SqlDriver, deps: RepoDeps): CredentialRefRepo {
  const get = (providerId: string): CredentialRefRow | undefined => {
    const row = driver.prepare('SELECT * FROM provider_credential_refs WHERE provider_id = ?').get(providerId);
    return row === undefined ? undefined : mapCredentialRef(row);
  };
  return {
    upsert(ref) {
      const now = deps.clock.now();
      // Replacing a key clears the previous connection-test result: it described the old key.
      driver
        .prepare(
          `INSERT INTO provider_credential_refs (id, provider_id, storage_mode, vault_file, redacted_label, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (provider_id) DO UPDATE SET storage_mode = excluded.storage_mode, vault_file = excluded.vault_file,
             redacted_label = excluded.redacted_label, updated_at = excluded.updated_at,
             last_test_at = NULL, last_test_ok = NULL, last_test_code = NULL, last_test_source = NULL`,
        )
        .run(ref.id, ref.providerId, ref.storageMode, ref.vaultFile, ref.redactedLabel, now, now);
      const row = get(ref.providerId);
      invariant(row !== undefined, 'credential ref missing after upsert');
      return row;
    },
    get,
    list() {
      return driver.prepare('SELECT * FROM provider_credential_refs ORDER BY provider_id').all().map(mapCredentialRef);
    },
    delete(providerId) {
      return driver.prepare('DELETE FROM provider_credential_refs WHERE provider_id = ?').run(providerId).changes > 0;
    },
    recordTest(providerId, ok, code, at, source) {
      return (
        driver
          .prepare(
            `UPDATE provider_credential_refs SET last_test_at = ?, last_test_ok = ?, last_test_code = ?, last_test_source = ?, updated_at = ?
             WHERE provider_id = ?`,
          )
          .run(at, bit(ok), code, source, deps.clock.now(), providerId).changes > 0
      );
    },
  };
}
