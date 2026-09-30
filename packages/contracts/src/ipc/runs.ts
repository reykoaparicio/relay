import { z } from 'zod';
import { PAGE_LIMITS, RATE_LIMITS } from '../defaults.js';
import { runEventSchema } from '../domain/event.js';
import { budgetBreakdownSchema, costSummarySchema } from '../domain/ledger.js';
import { memoryRefSchema } from '../domain/memory.js';
import { runDetailSchema, runStartInputSchema, runSummarySchema } from '../domain/run.js';
import { recoveryDecisionSchema, stepDetailSchema } from '../domain/views.js';
import { idSchema } from '../ids.js';
import { microusdSchema, nonNegativeMicrousdSchema } from '../money.js';
import { idempotencyKeySchema } from '../primitives.js';
import { providerIdSchema, runStatusSchema } from '../status.js';
import { validationIssueSchema } from '../validation.js';
import { op, pageOf, pageRequestShape } from './common.js';

/** Errors shared by `runs.preflight` and `runs.start`. */
const PREFLIGHT_ERRORS = [
  'CONTEXT_TOO_LARGE',
  'BUDGET_BLOCKED',
  'MODEL_UNSUPPORTED',
  'AUTH_REQUIRED',
  'PERMISSION_DENIED',
] as const;

/** `runs.preflight` output: drives the new-run form states. */
export const runPreflightSchema = z.object({
  inputSummary: z.object({
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    estimatedInputTokens: z.number().int().nonnegative(),
    memoryRecords: z.array(memoryRefSchema),
    providersReceivingContext: z.array(providerIdSchema),
  }),
  firstReservation: z.object({
    N: nonNegativeMicrousdSchema,
    basis: z.enum(['provider_count', 'local_estimate']),
  }),
  budget: budgetBreakdownSchema,
  issues: z.array(validationIssueSchema),
});
/** Run preflight. */
export type RunPreflight = z.infer<typeof runPreflightSchema>;

/** Decisions for an attempt whose outcome is unknown (§4.4, §7.5). */
export const UNKNOWN_OUTCOME_DECISIONS = [
  'retry_acknowledging_charge',
  'mark_failed_keep_liability',
  'accept_estimated_charge',
] as const;

/** `runs.*` operations. */
export const runOps = {
  'runs.preflight': op({
    channel: 'relay/v1/runs.preflight',
    kind: 'query',
    route: 'runner',
    input: runStartInputSchema.omit({ idempotencyKey: true }),
    output: runPreflightSchema,
    errors: [...PREFLIGHT_ERRORS, 'NOT_FOUND'],
    idempotent: false,
  }),
  'runs.start': op({
    channel: 'relay/v1/runs.start',
    kind: 'command',
    route: 'runner',
    input: runStartInputSchema,
    output: z.object({ runId: idSchema('run'), status: runStatusSchema }),
    errors: [...PREFLIGHT_ERRORS, 'VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT'],
    idempotent: true,
    rateLimit: RATE_LIMITS.dispatch,
  }),
  'runs.list': op({
    channel: 'relay/v1/runs.list',
    kind: 'query',
    route: 'runner',
    input: z.object({
      projectId: idSchema('project'),
      status: z.array(runStatusSchema).optional(),
      sort: z.enum(['created_desc', 'created_asc']).default('created_desc'),
      ...pageRequestShape,
    }),
    output: pageOf(runSummarySchema),
    errors: [],
    idempotent: false,
  }),
  'runs.get': op({
    channel: 'relay/v1/runs.get',
    kind: 'query',
    route: 'runner',
    input: z.object({ runId: idSchema('run') }),
    output: runDetailSchema,
    errors: ['NOT_FOUND'],
    idempotent: false,
  }),
  'runs.getStep': op({
    channel: 'relay/v1/runs.getStep',
    kind: 'query',
    route: 'runner',
    input: z.object({ runId: idSchema('run'), stepId: idSchema('stepRun') }),
    output: stepDetailSchema,
    errors: ['NOT_FOUND'],
    idempotent: false,
  }),
  'runs.pause': op({
    channel: 'relay/v1/runs.pause',
    kind: 'command',
    route: 'runner',
    input: z.object({ runId: idSchema('run') }),
    output: z.object({ status: runStatusSchema, inFlight: z.enum(['none', 'waiting', 'unknown']) }),
    errors: ['CONFLICT', 'NOT_FOUND'],
    idempotent: false,
  }),
  'runs.resume': op({
    channel: 'relay/v1/runs.resume',
    kind: 'command',
    route: 'runner',
    input: z.object({
      idempotencyKey: idempotencyKeySchema,
      runId: idSchema('run'),
      decision: recoveryDecisionSchema,
    }),
    output: z.object({ status: runStatusSchema }),
    errors: [
      'BUDGET_BLOCKED',
      'AUTH_REQUIRED',
      'APPROVAL_STALE',
      'PROJECT_CHANGED',
      'VALIDATION_FAILED',
      'CONFLICT',
      'NOT_FOUND',
      'MODEL_UNSUPPORTED',
      'PERMISSION_DENIED',
    ],
    idempotent: true,
    rateLimit: RATE_LIMITS.dispatch,
  }),
  'runs.cancel': op({
    channel: 'relay/v1/runs.cancel',
    kind: 'command',
    route: 'runner',
    input: z.object({ runId: idSchema('run') }),
    output: z.object({
      status: z.enum(['cancelling', 'cancelled']),
      unresolvedCharges: z.array(
        z.object({ attemptId: idSchema('attempt'), liabilityMicrousd: microusdSchema }),
      ),
    }),
    errors: ['CONFLICT', 'NOT_FOUND'],
    idempotent: false,
  }),
  'runs.increaseAllowance': op({
    channel: 'relay/v1/runs.increaseAllowance',
    kind: 'command',
    route: 'runner',
    input: z.object({
      idempotencyKey: idempotencyKeySchema,
      runId: idSchema('run'),
      newAllowanceMicrousd: nonNegativeMicrousdSchema,
    }),
    output: z.object({
      cost: costSummarySchema,
      status: runStatusSchema,
      budget: budgetBreakdownSchema.nullable(), // next-admission breakdown when the run stays paused (06 F2)
    }),
    errors: ['VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT'],
    idempotent: true,
  }),
  'runs.decideUnknown': op({
    channel: 'relay/v1/runs.decideUnknown',
    kind: 'command',
    route: 'runner',
    input: z.object({
      idempotencyKey: idempotencyKeySchema,
      runId: idSchema('run'),
      attemptId: idSchema('attempt'),
      decision: z.enum(UNKNOWN_OUTCOME_DECISIONS),
    }),
    output: runDetailSchema,
    errors: ['CONFLICT', 'NOT_FOUND'],
    idempotent: true,
  }),
  'runs.retryStep': op({
    channel: 'relay/v1/runs.retryStep',
    kind: 'command',
    route: 'runner',
    input: z.object({
      idempotencyKey: idempotencyKeySchema,
      runId: idSchema('run'),
      stepId: idSchema('stepRun'),
      profileId: idSchema('profile').optional(),
    }),
    output: runDetailSchema,
    errors: [
      'LIMIT_REACHED',
      'BUDGET_BLOCKED',
      'MODEL_UNSUPPORTED',
      'PERMISSION_DENIED',
      'CONFLICT',
      'NOT_FOUND',
    ],
    idempotent: true,
    rateLimit: RATE_LIMITS.dispatch,
  }),
  'runs.events': op({
    channel: 'relay/v1/runs.events',
    kind: 'query',
    route: 'runner',
    input: z.object({
      runId: idSchema('run'),
      afterSeq: z.number().int().nonnegative(), // seq starts at 1, so 0 = from the beginning
      limit: z.number().int().min(1).max(PAGE_LIMITS.eventsMaxLimit).default(PAGE_LIMITS.eventsDefaultLimit),
    }),
    output: pageOf(runEventSchema),
    errors: [],
    idempotent: false,
  }),
} as const;
