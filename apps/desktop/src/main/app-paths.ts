// 08 H1: userData layout and the dev/E2E-only environment overrides. Never hardcodes a home path (§12.3).
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, basename, isAbsolute, join, resolve } from 'node:path';

/** The on-disk layout under userData (§12.3). */
export interface AppPaths {
  readonly userData: string;
  readonly artifacts: string;
  readonly backups: string;
  readonly logs: string;
  readonly exports: string;
  readonly secrets: string;
  /** Where H10 copies the bundled sample (outside userData: the runner refuses roots inside it, 05 E1). */
  readonly samples: string;
  readonly dbFile: string;
}

/**
 * True when this build was made with `MAIN_VITE_RELAY_PACKAGED_E2E=1` (inlined at build time; never read from the
 * runtime environment). Only such a build honors RELAY_E2E=1 once packaged.
 */
export function packagedE2eAllowedByBuild(): boolean {
  try {
    return import.meta.env.MAIN_VITE_RELAY_PACKAGED_E2E === '1';
  } catch {
    return false;
  }
}

/**
 * RELAY_E2E=1 is honored by unpackaged builds (Playwright launches out/main/index.js), and by a packaged build only
 * when the build-time flag allows it — a shipped app ignores it, with every override it unlocks.
 */
export function isE2eAllowed(isPackaged: boolean, env: NodeJS.ProcessEnv, packagedE2eAllowed: boolean = packagedE2eAllowedByBuild()): boolean {
  return env['RELAY_E2E'] === '1' && (!isPackaged || packagedE2eAllowed);
}

/** Only an unpackaged build, or an allowed E2E run, may honor RELAY_* dev overrides (08 H1 steps 1 and 3). */
export function areDevOverridesAllowed(isPackaged: boolean, env: NodeJS.ProcessEnv, packagedE2eAllowed: boolean = packagedE2eAllowedByBuild()): boolean {
  return !isPackaged || isE2eAllowed(isPackaged, env, packagedE2eAllowed);
}

/** The userData override (absolute), or null when unset or not allowed. */
export function resolveUserDataOverride(isPackaged: boolean, env: NodeJS.ProcessEnv, packagedE2eAllowed: boolean = packagedE2eAllowedByBuild()): string | null {
  const dir = env['RELAY_USER_DATA_DIR'];
  if (dir === undefined || dir.trim() === '' || !areDevOverridesAllowed(isPackaged, env, packagedE2eAllowed)) return null;
  return isAbsolute(dir) ? dir : resolve(dir);
}

/** Effective provider mode (`fake` only under the override condition) and the fake scenario name. */
export interface ProviderModeConfig {
  readonly providerMode: 'live' | 'fake';
  readonly fakeScenario: string | null;
}

/** 08 H1 step 3: RELAY_PROVIDER_MODE=fake is honored only when dev overrides are allowed; otherwise `live`. */
export function resolveProviderMode(isPackaged: boolean, env: NodeJS.ProcessEnv, packagedE2eAllowed: boolean = packagedE2eAllowedByBuild()): ProviderModeConfig {
  const fake = env['RELAY_PROVIDER_MODE'] === 'fake' && areDevOverridesAllowed(isPackaged, env, packagedE2eAllowed);
  if (!fake) return { providerMode: 'live', fakeScenario: null };
  const scenario = env['RELAY_FAKE_SCENARIO'];
  return { providerMode: 'fake', fakeScenario: scenario === undefined || scenario === '' ? null : scenario };
}

/**
 * Samples root: with an overridden userData (dev/E2E temp profiles) a sibling `<userData>-samples` dir, otherwise
 * `<documents>/Relay Samples`. Never inside userData or ~/Library, which the runner refuses as project roots.
 */
export function samplesRoot(userData: string, documentsDir: string, overridden: boolean): string {
  return overridden ? join(dirname(userData), `${basename(userData)}-samples`) : join(documentsDir, 'Relay Samples');
}

/** The layout for `userData`. */
export function appPaths(userData: string, samples: string): AppPaths {
  return {
    userData,
    artifacts: join(userData, 'artifacts'),
    backups: join(userData, 'backups'),
    logs: join(userData, 'logs'),
    exports: join(userData, 'exports'),
    secrets: join(userData, 'secrets'),
    samples,
    dbFile: join(userData, 'relay.sqlite'),
  };
}

const SECRETS_DIR_MODE = 0o700;

/** Creates every layout directory; `secrets` is 0700 (§18.2). */
export async function ensureLayout(p: AppPaths): Promise<void> {
  await Promise.all(
    [p.artifacts, p.backups, p.logs, p.exports].map((d) => mkdir(d, { recursive: true })),
  );
  await mkdir(p.secrets, { recursive: true, mode: SECRETS_DIR_MODE });
  await chmod(p.secrets, SECRETS_DIR_MODE);
}
