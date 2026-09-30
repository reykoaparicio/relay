import { z } from 'zod';
import { idSchema } from '../ids.js';
import { epochMsSchema } from '../primitives.js';

/** Persisted run event types (03 `run_events`; pushed as `run.event`). */
export const RUN_EVENT_TYPES = [
  'run.created',
  'run.status_changed',
  'run.config_revised',
  'step.state_changed',
  'attempt.created',
  'attempt.dispatching',
  'attempt.stream_progress',
  'attempt.settled',
  'attempt.unknown',
  'ledger.reserved',
  'ledger.settled',
  'ledger.blocked',
  'approval.requested',
  'approval.decided',
  'artifact.created',
  'memory.suggested',
  'context.assembled',
  'error.recorded',
  'ledger.overrun',
  'artifact.write_failed',
  'run.limits_raised',
  'report.created',
  'run.snapshot_preserved',
] as const;
/** Schema for {@link RunEventType}. */
export const runEventTypeSchema = z.enum(RUN_EVENT_TYPES);
/** Run event type. */
export type RunEventType = z.infer<typeof runEventTypeSchema>;

/**
 * Persisted/pushed run event DTO, ordered per run by `seq` (starts at 1). Payload is redacted.
 * `attempt.stream_progress` carries only `{ outputTokensSoFar, elapsedMs }`, never content (§5.7).
 */
export const runEventSchema = z.object({
  id: idSchema('event'),
  runId: idSchema('run'),
  seq: z.number().int().nonnegative(),
  type: runEventTypeSchema,
  at: epochMsSchema,
  payload: z.record(z.string(), z.unknown()),
});
/** Run event. */
export type RunEvent = z.infer<typeof runEventSchema>;
