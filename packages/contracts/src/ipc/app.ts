import { z } from 'zod';
import { RATE_LIMITS } from '../defaults.js';
import { appSettingsSchema } from '../domain/views.js';
import { idSchema } from '../ids.js';
import { epochMsSchema, idempotencyKeySchema } from '../primitives.js';
import { errorCodeSchema, runnerStateSchema } from '../status.js';
import { emptyInputSchema, exportResultSchema, op } from './common.js';

/**
 * How the previous session ended (main writes `<userData>/last-shutdown.json`). `clean: true` = the user quit (or
 * relaunched) Relay and main finished its shutdown; `clean: false` = the previous session never recorded a clean quit
 * (crash, force quit, power loss). `at` = the clean-quit time, or the start time of the session that did not end
 * cleanly. `runActive` = a run was in flight when that session quit (the user confirmed quitting during a run).
 */
export const lastShutdownSchema = z.object({
  clean: z.boolean(),
  at: epochMsSchema,
  runActive: z.boolean(),
});
/** How the previous session ended. */
export type LastShutdown = z.infer<typeof lastShutdownSchema>;

/**
 * Why the runner last became `unavailable` (kept by main's supervisor until the next restart). `code` / `reason` come
 * from the runner's `fatal` message (`reason` = a stable snake_case cause such as `schema_too_new`, `db_corrupt`,
 * `db_locked`, `db_readonly`, `disk_full`; null when the runner sent none) or are main's own (`RUNNER_UNAVAILABLE` /
 * `restart_limit` when the runner kept crashing). `message` is redacted, user-presentable detail.
 */
export const runnerFatalSchema = z.object({
  code: errorCodeSchema,
  reason: z.string().nullable(),
  message: z.string(),
  at: epochMsSchema,
});
/** Why the runner last became unavailable. */
export type RunnerFatal = z.infer<typeof runnerFatalSchema>;

/** `app.getInfo` output. `fakeScenario` = `RELAY_FAKE_SCENARIO` in fake mode, else null. */
export const appInfoSchema = z.object({
  version: z.string(),
  buildId: z.string(),
  electron: z.string(),
  node: z.string(),
  platform: z.string(),
  userDataDisplayPath: z.string(),
  isPackaged: z.boolean(),
  providerMode: z.enum(['live', 'fake']),
  fakeScenario: z.string().nullable(),
  /** How the previous session ended; null on first launch (or when the marker is unreadable). Optional: older mains. */
  lastShutdown: lastShutdownSchema.nullable().optional(),
});
/** App info. */
export type AppInfo = z.infer<typeof appInfoSchema>;

/** `app.getDiagnostics` output (§18.3). */
export const diagnosticsSchema = z.object({
  runner: z.object({
    state: runnerStateSchema,
    pid: z.number().int().nullable(),
    lastHeartbeatAt: epochMsSchema.nullable(),
    restarts: z.number().int().nonnegative(),
    /** Why the runner last became unavailable; null while none recorded. Optional: older mains / the runner half. */
    lastFatal: runnerFatalSchema.nullable().optional(),
  }),
  db: z.object({
    schemaVersion: z.number().int().nonnegative(),
    migrationsPending: z.number().int().nonnegative(),
    /** `relay.sqlite` + `relay.sqlite-wal`, measured on disk by main (also while the runner is down). */
    sizeBytes: z.number().int().nonnegative(),
    /** `~`-relative path of `relay.sqlite` (main fills it in; also while the runner is down). */
    displayPath: z.string().optional(),
  }),
  unresolvedAttempts: z.number().int().nonnegative(),
  secureStorage: z.object({ available: z.boolean(), backend: z.string() }),
  catalog: z.object({ version: z.string().nullable(), models: z.number().int().nonnegative() }),
  prompts: z.object({ loaded: z.number().int().nonnegative() }),
  /** True while main's log file cannot be written (lines go to stderr and an OS-temp fallback file). */
  loggingDegraded: z.boolean().optional(),
  /** How the previous session ended (same as `app.getInfo().lastShutdown`). */
  lastShutdown: lastShutdownSchema.nullable().optional(),
});
/** Diagnostics. */
export type Diagnostics = z.infer<typeof diagnosticsSchema>;

/** `app.restartRunner`: at most 3 attempts, then one per 10 s (each attempt may fork a runner and run migrations). */
export const RESTART_RUNNER_RATE_LIMIT = { capacity: 3, refillPerSec: 1 / 10 } as const;

/** Settings patch (`Partial<AppSettings>`). */
export const appSettingsPatchSchema = appSettingsSchema.partial();

/** `app.*` operations. */
export const appOps = {
  'app.getInfo': op({
    channel: 'relay/v1/app.getInfo',
    kind: 'query',
    route: 'main',
    input: emptyInputSchema,
    output: appInfoSchema,
    errors: [],
    idempotent: false,
  }),
  'app.getDiagnostics': op({
    channel: 'relay/v1/app.getDiagnostics',
    kind: 'query',
    route: 'main+runner',
    input: emptyInputSchema,
    output: diagnosticsSchema,
    errors: ['RUNNER_UNAVAILABLE'],
    idempotent: false,
  }),
  'app.createBackup': op({
    channel: 'relay/v1/app.createBackup',
    kind: 'command',
    route: 'runner',
    input: z.object({ idempotencyKey: idempotencyKeySchema }),
    output: z.object({
      backupDisplayPath: z.string(),
      createdAt: epochMsSchema,
      sizeBytes: z.number().int().nonnegative(),
    }),
    errors: ['ARTIFACT_WRITE_FAILED', 'CONFLICT'],
    idempotent: true,
    rateLimit: RATE_LIMITS.dialog,
  }),
  'app.exportDiagnostics': op({
    channel: 'relay/v1/app.exportDiagnostics',
    kind: 'command',
    route: 'main+runner',
    input: z.object({ includeRunIds: z.array(idSchema('run')).max(50).optional() }),
    output: exportResultSchema,
    errors: ['ARTIFACT_WRITE_FAILED', 'NOT_FOUND'],
    idempotent: false,
    rateLimit: RATE_LIMITS.dialog,
  }),
  'app.openExternal': op({
    channel: 'relay/v1/app.openExternal',
    kind: 'command',
    route: 'main',
    input: z.object({ url: z.url({ protocol: /^https$/ }).max(2048) }),
    output: z.object({ opened: z.boolean() }),
    errors: [],
    idempotent: false,
  }),
  /**
   * Restarts the runner after it became `unavailable` (no app relaunch). A no-op (`restarted: false`) while a runner
   * is starting, restarting, or ready. Resolves once the new runner is `ready`; RUNNER_UNAVAILABLE (details.reason /
   * details.fatalCode from the new failure) when it fails again.
   */
  'app.restartRunner': op({
    channel: 'relay/v1/app.restartRunner',
    kind: 'command',
    route: 'main',
    input: emptyInputSchema,
    output: z.object({ restarted: z.boolean(), state: runnerStateSchema }),
    errors: ['RUNNER_UNAVAILABLE'],
    idempotent: false,
    rateLimit: RESTART_RUNNER_RATE_LIMIT,
  }),
  /**
   * Quits and relaunches Relay (the last resort when restarting the runner does not help). The renderer confirms
   * first; main answers `{ relaunching: true }`, then shuts the runner down, records a clean quit, and relaunches.
   */
  'app.relaunch': op({
    channel: 'relay/v1/app.relaunch',
    kind: 'command',
    route: 'main',
    input: emptyInputSchema,
    output: z.object({ relaunching: z.boolean() }),
    errors: [],
    idempotent: false,
    rateLimit: RATE_LIMITS.dialog,
  }),
  /**
   * Restores the newest healthy backup over a database the runner cannot open (corrupt, newer schema, …), then
   * restarts the runner. Only while the runner is `unavailable` (CONFLICT otherwise: never under a live runner). The
   * previous database files are moved aside (`previousMovedToDisplayPath`), never deleted. `restored: false` = no
   * usable backup; nothing changed. The renderer confirms first.
   */
  'app.restoreLatestBackup': op({
    channel: 'relay/v1/app.restoreLatestBackup',
    kind: 'command',
    route: 'main',
    input: emptyInputSchema,
    output: z.object({
      restored: z.boolean(),
      restoredFromDisplayPath: z.string().nullable(),
      backupCreatedAt: epochMsSchema.nullable(),
      previousMovedToDisplayPath: z.string().nullable(),
      /** Runner state after the restore and restart (`ready` on success). */
      runnerState: runnerStateSchema,
    }),
    errors: ['CONFLICT', 'ARTIFACT_WRITE_FAILED'],
    idempotent: false,
    rateLimit: RATE_LIMITS.dialog,
  }),
  'app.getSettings': op({
    channel: 'relay/v1/app.getSettings',
    kind: 'query',
    route: 'runner',
    input: emptyInputSchema,
    output: appSettingsSchema,
    errors: [],
    idempotent: false,
  }),
  'app.updateSettings': op({
    channel: 'relay/v1/app.updateSettings',
    kind: 'command',
    route: 'runner',
    input: appSettingsPatchSchema,
    output: appSettingsSchema,
    errors: ['VALIDATION_FAILED'],
    idempotent: false,
  }),
} as const;
