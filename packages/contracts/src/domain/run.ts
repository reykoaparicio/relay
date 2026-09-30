import { z } from 'zod';
import { INPUT_CAPS, MIN_EXECUTION_TIMEOUT_SECONDS, RUN_LIMIT_MAXIMUMS } from '../defaults.js';
import { appErrorSchema } from '../errors.js';
import { idSchema } from '../ids.js';
import { nonNegativeMicrousdSchema } from '../money.js';
import {
  epochMsSchema,
  idempotencyKeySchema,
  relPathSchema,
  sha256Schema,
  stepKeySchema,
} from '../primitives.js';
import { pauseReasonSchema, runActionSchema, runStatusSchema } from '../status.js';
import { approvalViewSchema } from './approval.js';
import { attemptViewSchema } from './attempt.js';
import { costSummarySchema } from './ledger.js';
import { stepViewSchema } from './step.js';

/** §9.1 run limits (bounded by `RUN_LIMIT_MAXIMUMS`). */
export const runLimitsSchema = z.object({
  budgetMicrousd: nonNegativeMicrousdSchema,
  maxRevisionCycles: z.number().int().min(0).max(RUN_LIMIT_MAXIMUMS.maxRevisionCycles),
  maxAttempts: z.number().int().min(1).max(RUN_LIMIT_MAXIMUMS.maxAttempts),
  maxConcurrentSteps: z.literal(1), // §9.1 P0
  executionTimeoutSeconds: z
    .number()
    .int()
    .min(MIN_EXECUTION_TIMEOUT_SECONDS)
    .max(RUN_LIMIT_MAXIMUMS.executionTimeoutSeconds),
  maxToolCalls: z.number().int().min(0).max(0), // ADR-014
});
/** Run limits. */
export type RunLimits = z.infer<typeof runLimitsSchema>;

/** Workflow default limits; missing fields fall back to `DEFAULT_LIMITS`. */
export const workflowLimitsSchema = runLimitsSchema.partial();
/** Workflow limits. */
export type WorkflowLimits = z.infer<typeof workflowLimitsSchema>;

/** Run input: selected files, or an imported diff (imported as an artifact first, ADR-015). */
export const runInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('files'), relPaths: z.array(relPathSchema).min(1).max(INPUT_CAPS.maxFiles) }),
  z.object({ kind: z.literal('diff'), diffArtifactId: idSchema('artifact') }),
]);
/** Run input. */
export type RunInput = z.infer<typeof runInputSchema>;

/**
 * `runs.start` input (§12.5). `memoryRecordIds` = approved records the user ticked; pinned user rules are always
 * included. `profileOverrides` = per-step profile for this run only.
 */
export const runStartInputSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  projectId: idSchema('project'),
  workflowId: idSchema('workflow'),
  workflowVersion: z.number().int().positive(),
  goal: z.string().min(1).max(2000),
  input: runInputSchema,
  limitOverrides: workflowLimitsSchema.optional(),
  profileOverrides: z.record(stepKeySchema, idSchema('profile')).optional(),
  memoryRecordIds: z.array(idSchema('memory')).max(50).optional(),
});
/** Run start input. */
export type RunStartInput = z.infer<typeof runStartInputSchema>;

/** Run list row. */
export const runSummarySchema = z.object({
  id: idSchema('run'),
  projectId: idSchema('project'),
  goal: z.string(),
  workflow: z.object({ id: idSchema('workflow'), version: z.number().int(), name: z.string() }),
  status: runStatusSchema,
  pauseReason: pauseReasonSchema.nullable(),
  stepProgress: z.object({ done: z.number().int(), total: z.number().int() }),
  cost: costSummarySchema,
  createdAt: epochMsSchema,
  startedAt: epochMsSchema.nullable(),
  endedAt: epochMsSchema.nullable(),
});
/** Run summary. */
export type RunSummary = z.infer<typeof runSummarySchema>;

/** Run inspector projection. `availableActions` is server-computed (06 F2); the UI never re-derives rules. */
export const runDetailSchema = runSummarySchema.extend({
  limits: runLimitsSchema,
  input: runInputSchema,
  contextHash: sha256Schema.nullable(),
  steps: z.array(stepViewSchema),
  pendingApproval: approvalViewSchema.nullable(),
  unresolvedAttempts: z.array(attemptViewSchema), // unknown outcomes surfaced on relaunch (§4.4)
  executionMsUsed: z.number().int().nonnegative(), // §9.1 execution time (accrues only while running)
  revisionCycle: z.number().int(),
  statusDetail: appErrorSchema.nullable(), // the blocking error behind pauseReason
  reportArtifactId: idSchema('artifact').nullable(), // report.v1, set on every terminal transition (06 F17)
  availableActions: z.array(runActionSchema),
});
/** Run detail. */
export type RunDetail = z.infer<typeof runDetailSchema>;
