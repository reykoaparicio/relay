import { z } from 'zod';
import { RUNNER_SHUTDOWN_MAX_GRACE_MS } from './defaults.js';
import { appErrorSchema } from './errors.js';
import { pushEventSchema } from './events.js';
import { idSchema } from './ids.js';
import { runnerChannelSchema } from './ipc/catalog.js';
import { epochMsSchema } from './primitives.js';
import { ipcResultSchema } from './result.js';
import { errorCodeSchema, providerIdSchema } from './status.js';

// Main ↔ runner messages over a MessagePortMain pair, validated on BOTH sides (02 §B7).

/** Why the runner needs a key: a model dispatch (resolved before estimating) or `providers.test`. */
export const CREDENTIAL_PURPOSES = ['dispatch', 'connection_test'] as const;

/** Main → runner messages. */
export const runnerRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('op'),
    id: z.string().min(1),
    channel: runnerChannelSchema,
    input: z.unknown(),
  }),
  z.object({
    kind: z.literal('credential.response'),
    id: z.string().min(1),
    providerId: providerIdSchema, // echoed so the runner rejects an answer for a different provider (08 audit F2)
    result: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), apiKey: z.string() }), // in-memory only; the runner never persists/logs it
      z.object({ ok: z.literal(false), error: appErrorSchema }),
    ]),
  }),
  z.object({
    kind: z.literal('shutdown'),
    graceMs: z.number().int().nonnegative().max(RUNNER_SHUTDOWN_MAX_GRACE_MS),
  }),
]);
/** Main → runner message. */
export type RunnerRequest = z.infer<typeof runnerRequestSchema>;

/** One-shot runner tasks that run INSTEAD of booting the engine (selected by main via `RELAY_RUNNER_TASK`). */
export const RUNNER_MAINTENANCE_TASKS = ['restore_latest_backup'] as const;
/** Runner maintenance task. */
export type RunnerMaintenanceTask = (typeof RUNNER_MAINTENANCE_TASKS)[number];

/** Runner → main messages. */
export const runnerMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), schemaVersion: z.number().int(), pid: z.number().int() }), // after migrations (§6.4)
  z.object({ kind: z.literal('op.result'), id: z.string().min(1), result: ipcResultSchema }),
  z.object({
    kind: z.literal('credential.request'),
    id: z.string().min(1),
    providerId: providerIdSchema,
    purpose: z.enum(CREDENTIAL_PURPOSES),
    attemptId: idSchema('attempt').nullable(), // null for the pre-estimate dispatch resolve and connection_test
  }),
  z.object({ kind: z.literal('heartbeat'), at: epochMsSchema, activeRunId: idSchema('run').nullable() }),
  z.object({ kind: z.literal('event'), event: pushEventSchema }),
  // e.g. migration failure. `reason` (optional, additive) is the closed `details.reason` of the error when it has one,
  // e.g. DATABASE_UNAVAILABLE `schema_too_new` / `disk_full` / `database_busy` (E2 #3); main stores and shows it.
  z.object({ kind: z.literal('fatal'), code: errorCodeSchema, message: z.string(), reason: z.string().max(64).optional() }),
  // E2 #4: result of a runner started in maintenance mode (`RELAY_RUNNER_TASK=restore_latest_backup`), which never opens
  // the database (so it works when the DB is corrupt) and exits after posting this. Paths are display paths.
  z.object({
    kind: z.literal('maintenance.result'),
    task: z.enum(RUNNER_MAINTENANCE_TASKS),
    result: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        restored: z.boolean(), // false = no usable backup; nothing was changed
        restoredFromDisplayPath: z.string().nullable(),
        backupCreatedAt: epochMsSchema.nullable(),
        previousMovedToDisplayPath: z.string().nullable(),
      }),
      z.object({ ok: z.literal(false), error: appErrorSchema }),
    ]),
  }),
]);
/** Runner → main message. */
export type RunnerMessage = z.infer<typeof runnerMessageSchema>;
