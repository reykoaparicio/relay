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
  z.object({ kind: z.literal('op'), id: z.string().min(1), channel: runnerChannelSchema, input: z.unknown() }),
  z.object({
    kind: z.literal('credential.response'),
    id: z.string().min(1),
    result: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), apiKey: z.string() }), // in-memory only; the runner never persists/logs it
      z.object({ ok: z.literal(false), error: appErrorSchema }),
    ]),
  }),
  z.object({ kind: z.literal('shutdown'), graceMs: z.number().int().nonnegative().max(RUNNER_SHUTDOWN_MAX_GRACE_MS) }),
]);
/** Main → runner message. */
export type RunnerRequest = z.infer<typeof runnerRequestSchema>;

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
  z.object({ kind: z.literal('fatal'), code: errorCodeSchema, message: z.string() }), // e.g. migration failure
]);
/** Runner → main message. */
export type RunnerMessage = z.infer<typeof runnerMessageSchema>;
