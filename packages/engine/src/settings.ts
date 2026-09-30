// App settings stored in the `settings` table (02 `AppSettings`), merged over the defaults.
import { RAW_RESPONSE_RETENTION_DAYS, SETUP_ALLOWANCE_MICROUSD, appSettingsSchema } from '@relay/contracts';
import type { AppSettings } from '@relay/contracts';
import type { Repos } from '@relay/storage';

/** Settings row key. */
export const SETTINGS_KEY = 'app_settings';

/** Current settings merged over the defaults (never fails: a malformed stored value falls back to defaults). */
export function readSettings(r: Pick<Repos, 'settings'>): AppSettings {
  const defaults: AppSettings = {
    theme: 'system', activeProjectId: null, onboardingCompletedAt: null,
    rawResponseRetentionDays: RAW_RESPONSE_RETENTION_DAYS, setupAllowanceMicrousd: SETUP_ALLOWANCE_MICROUSD as AppSettings['setupAllowanceMicrousd'],
  };
  const stored = r.settings.get(SETTINGS_KEY);
  const parsed = appSettingsSchema.safeParse({ ...defaults, ...(typeof stored === 'object' && stored !== null ? stored : {}) });
  return parsed.success ? parsed.data : defaults;
}
