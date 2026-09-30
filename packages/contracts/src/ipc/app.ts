import { z } from 'zod';
import { RATE_LIMITS } from '../defaults.js';
import { appSettingsSchema } from '../domain/views.js';
import { idSchema } from '../ids.js';
import { epochMsSchema, idempotencyKeySchema } from '../primitives.js';
import { runnerStateSchema } from '../status.js';
import { emptyInputSchema, exportResultSchema, op } from './common.js';

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
  }),
  db: z.object({
    schemaVersion: z.number().int().nonnegative(),
    migrationsPending: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
  }),
  unresolvedAttempts: z.number().int().nonnegative(),
  secureStorage: z.object({ available: z.boolean(), backend: z.string() }),
  catalog: z.object({ version: z.string().nullable(), models: z.number().int().nonnegative() }),
  prompts: z.object({ loaded: z.number().int().nonnegative() }),
});
/** Diagnostics. */
export type Diagnostics = z.infer<typeof diagnosticsSchema>;

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
    errors: ['ARTIFACT_WRITE_FAILED'],
    idempotent: true,
    rateLimit: RATE_LIMITS.dialog,
  }),
  'app.exportDiagnostics': op({
    channel: 'relay/v1/app.exportDiagnostics',
    kind: 'command',
    route: 'main+runner',
    input: z.object({ includeRunIds: z.array(idSchema('run')).max(50).optional() }),
    output: exportResultSchema,
    errors: ['ARTIFACT_WRITE_FAILED'],
    idempotent: false,
    rateLimit: RATE_LIMITS.dialog,
  }),
  'app.openExternal': op({
    channel: 'relay/v1/app.openExternal',
    kind: 'command',
    route: 'main',
    input: z.object({ url: z.url({ protocol: /^https$/ }).max(2048) }),
    output: z.object({ opened: z.boolean() }),
    errors: ['PERMISSION_DENIED'],
    idempotent: false,
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
