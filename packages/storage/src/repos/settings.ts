import type { SqlDriver } from '../driver.js';
import { RowReader } from '../mappers.js';
import { toJson } from '../sql.js';
import type { SettingsRepo } from '../types.js';
import type { RepoDeps } from './deps.js';

export function createSettingsRepo(driver: SqlDriver, deps: RepoDeps): SettingsRepo {
  return {
    get(key) {
      const row = driver.prepare('SELECT key, value_json FROM app_settings WHERE key = ?').get(key);
      return row === undefined ? undefined : new RowReader('app_settings', row, 'key').jsonAny('value_json');
    },
    set(key, value) {
      driver
        .prepare(
          `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run(key, toJson(value), deps.clock.now());
    },
  };
}
