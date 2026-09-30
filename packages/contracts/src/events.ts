import { z } from 'zod';
import { runEventSchema } from './domain/event.js';
import { idSchema } from './ids.js';
import { pauseReasonSchema, runnerStateSchema, runStatusSchema } from './status.js';

/** Push channel main → renderer (`webContents.send`; the preload exposes `subscribe`). */
export const EVENTS_CHANNEL = 'relay/v1/events';

/**
 * Push events. Gapless contract: the renderer calls `runs.events({ afterSeq })` on mount, applies pushes, and
 * backfills when a pushed `seq` is greater than `lastSeq + 1` (10 §J2).
 */
export const pushEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.event'), event: runEventSchema }), // ordered per run by seq
  z.object({
    type: z.literal('run.status'),
    runId: idSchema('run'),
    status: runStatusSchema,
    pauseReason: pauseReasonSchema.nullable(),
    seq: z.number().int(),
  }), // coalesced status for list views
  z.object({ type: z.literal('runner.state'), state: runnerStateSchema }),
  z.object({ type: z.literal('memory.changed'), projectId: idSchema('project') }),
  z.object({ type: z.literal('providers.changed') }),
]);
/** Push event. */
export type PushEvent = z.infer<typeof pushEventSchema>;
