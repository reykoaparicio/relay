import { z } from 'zod';
import type { BudgetBreakdown } from './domain/ledger.js';
import type { AttemptId, CorrelationId, RunId } from './ids.js';
import { idSchema } from './ids.js';
import type { RelPath } from './primitives.js';
import type { ErrorCode, NextAction, ProviderId } from './status.js';
import { errorCodeSchema, nextActionSchema } from './status.js';
import type { ValidationIssue } from './validation.js';

/** Maximum length of `AppError.userMessage` (plain language; no secrets, paths, or stacks — 00b §2.6 gate). */
export const USER_MESSAGE_MAX = 400;

/** Boundary error shape (§12.6: explanation, retryability, attempt id, next action). */
export const appErrorSchema = z.object({
  code: errorCodeSchema,
  userMessage: z.string().max(USER_MESSAGE_MAX),
  retryable: z.boolean(),
  nextAction: nextActionSchema,
  alternatives: z.array(nextActionSchema).default([]),
  attemptId: idSchema('attempt').optional(),
  runId: idSchema('run').optional(),
  details: z.record(z.string(), z.unknown()).optional(), // redacted; e.g. { issues } | { retryAfterMs } | BudgetBreakdown
  correlationId: idSchema('correlation').optional(),
});
/** Boundary error. */
export type AppError = z.infer<typeof appErrorSchema>;

/** Static policy for one error code (02 §B3 table). */
export interface ErrorDefinition {
  readonly retryable: boolean;
  readonly nextAction: NextAction;
  readonly alternatives: readonly NextAction[];
  /** Status code for the future headless HTTP API. */
  readonly httpStatus: number;
  /** Default user-facing message template. */
  readonly userMessage: string;
}

/** 02 §B3: per-code retryability, next action (+ alternatives), future HTTP status, and default message. */
export const ERROR_DEFINITIONS = {
  AUTH_REQUIRED: {
    retryable: false,
    nextAction: 'reconnect_provider',
    alternatives: [],
    httpStatus: 401,
    userMessage: 'The provider rejected the saved key. Reconnect the provider to continue.',
  },
  MODEL_UNSUPPORTED: {
    retryable: false,
    nextAction: 'choose_profile',
    alternatives: [],
    httpStatus: 422,
    userMessage: 'The selected model cannot run this step. Choose another profile.',
  },
  RATE_LIMITED: {
    retryable: true,
    nextAction: 'wait',
    alternatives: [],
    httpStatus: 429,
    userMessage: 'The provider is rate limiting requests. Relay will wait before trying again.',
  },
  BUDGET_BLOCKED: {
    retryable: false,
    nextAction: 'increase_allowance',
    alternatives: ['choose_profile', 'stop'],
    httpStatus: 402,
    userMessage:
      'This step would exceed the allowance. Increase the allowance, choose a cheaper profile, or stop.',
  },
  CONTEXT_TOO_LARGE: {
    retryable: false,
    nextAction: 'narrow_scope',
    alternatives: ['choose_profile'],
    httpStatus: 413,
    userMessage:
      'The selected context is too large for this model. Select fewer files or choose another profile.',
  },
  OUTPUT_INVALID: {
    retryable: true,
    nextAction: 'retry_step',
    alternatives: [],
    httpStatus: 502,
    userMessage: 'The model response did not match the expected format.',
  },
  APPROVAL_STALE: {
    retryable: false,
    nextAction: 'reapprove',
    alternatives: [],
    httpStatus: 409,
    userMessage: 'The plan or its context changed after it was shown. Review and approve it again.',
  },
  PROJECT_CHANGED: {
    retryable: false,
    nextAction: 'resnapshot_and_replan',
    alternatives: ['use_preserved_snapshot'],
    httpStatus: 409,
    userMessage: 'Project files changed since the run started.',
  },
  REQUEST_OUTCOME_UNKNOWN: {
    retryable: false,
    nextAction: 'decide_unknown',
    alternatives: [],
    httpStatus: 409,
    userMessage:
      'Relay cannot tell whether the provider finished this request. Decide how to handle the possible charge.',
  },
  ARTIFACT_WRITE_FAILED: {
    retryable: true,
    nextAction: 'retry_export',
    alternatives: [],
    httpStatus: 500,
    userMessage: 'Relay could not write the file. Check the destination and try again.',
  },
  RUNNER_UNAVAILABLE: {
    retryable: true,
    nextAction: 'restart_runner',
    alternatives: [],
    httpStatus: 503,
    userMessage: 'The background runner is not available.',
  },
  PROVIDER_UNAVAILABLE: {
    retryable: true,
    nextAction: 'wait',
    alternatives: [],
    httpStatus: 502,
    userMessage: 'The provider could not be reached. The request was not processed.',
  },
  VALIDATION_FAILED: {
    retryable: false,
    nextAction: 'fix_input',
    alternatives: [],
    httpStatus: 400,
    userMessage: 'Some fields are not valid.',
  },
  NOT_FOUND: {
    retryable: false,
    nextAction: 'none',
    alternatives: [],
    httpStatus: 404,
    userMessage: 'The requested item was not found.',
  },
  CONFLICT: {
    retryable: false,
    nextAction: 'reload',
    alternatives: [],
    httpStatus: 409,
    userMessage: 'This item changed since it was loaded. Reload and try again.',
  },
  LIMIT_REACHED: {
    retryable: false,
    nextAction: 'raise_limits',
    alternatives: ['stop'],
    httpStatus: 422,
    userMessage: 'The run reached one of its limits.',
  },
  PERMISSION_DENIED: {
    retryable: false,
    nextAction: 'none',
    alternatives: ['edit_policy'],
    httpStatus: 403,
    userMessage: 'This action is not permitted for this project.',
  },
  SECURE_STORAGE_UNAVAILABLE: {
    retryable: false,
    nextAction: 'use_session_key',
    alternatives: [],
    httpStatus: 503,
    userMessage:
      'Secure storage is not available on this computer. You can use the key for this session only.',
  },
  MODEL_REFUSED: {
    retryable: false,
    nextAction: 'choose_profile',
    alternatives: ['edit_goal'],
    httpStatus: 422,
    userMessage: 'The model declined this request. Choose another profile or edit the goal.',
  },
  INTERNAL: {
    retryable: false,
    nextAction: 'report_bug',
    alternatives: [],
    httpStatus: 500,
    userMessage: 'Something went wrong inside Relay.',
  },
} as const satisfies Record<ErrorCode, ErrorDefinition>;

/** Optional context attached to any error. */
export interface ErrorContext {
  readonly userMessage?: string;
  readonly attemptId?: AttemptId;
  readonly runId?: RunId;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly correlationId?: CorrelationId;
}

/** Builds an {@link AppError} for `code` from its {@link ERROR_DEFINITIONS} policy plus optional context. */
export function appError(code: ErrorCode, ctx: ErrorContext = {}): AppError {
  const def: ErrorDefinition = ERROR_DEFINITIONS[code];
  const e: AppError = {
    code,
    userMessage: (ctx.userMessage ?? def.userMessage).slice(0, USER_MESSAGE_MAX),
    retryable: def.retryable,
    nextAction: def.nextAction,
    alternatives: [...def.alternatives],
  };
  if (ctx.attemptId !== undefined) e.attemptId = ctx.attemptId;
  if (ctx.runId !== undefined) e.runId = ctx.runId;
  if (ctx.details !== undefined) e.details = { ...ctx.details };
  if (ctx.correlationId !== undefined) e.correlationId = ctx.correlationId;
  return e;
}

/** `PERMISSION_DENIED` `details.reason` values (§11). */
export const PERMISSION_DENIED_REASONS = [
  'outside_root',
  'excluded',
  'provider_not_allowed',
  'inside_project',
  'contains_project',
  'unsafe_root',
] as const;
/** Schema for {@link PermissionDeniedReason}. */
export const permissionDeniedReasonSchema = z.enum(PERMISSION_DENIED_REASONS);
/** `PERMISSION_DENIED` reason. */
export type PermissionDeniedReason = z.infer<typeof permissionDeniedReasonSchema>;

/** `LIMIT_REACHED` `details.limit` values (§9.1). */
export const LIMIT_KINDS = ['attempts', 'revisions', 'deadline', 'tool_calls'] as const;
/** Run limit kind. */
export type LimitKind = (typeof LIMIT_KINDS)[number];

/** Why an approval is stale (03 `approvals.invalidated_reason`). */
export const APPROVAL_STALE_REASONS = [
  'plan_changed',
  'scope_changed',
  'project_changed',
  'provider_changed',
] as const;
/** Approval stale reason. */
export type ApprovalStaleReason = (typeof APPROVAL_STALE_REASONS)[number];

/** Error factories, one per {@link ErrorCode} (camelCase of the code). Typed arguments win over `ctx.details`. */
export const errors = {
  authRequired: (providerId: ProviderId, ctx?: ErrorContext): AppError =>
    appError('AUTH_REQUIRED', { ...ctx, details: { ...ctx?.details, providerId } }),
  modelUnsupported: (
    info: { providerId?: ProviderId; modelId?: string; reason?: string } = {},
    ctx?: ErrorContext,
  ) => appError('MODEL_UNSUPPORTED', { ...ctx, details: { ...ctx?.details, ...info } }),
  rateLimited: (retryAfterMs: number | null, ctx?: ErrorContext): AppError =>
    appError('RATE_LIMITED', { ...ctx, details: { ...ctx?.details, retryAfterMs } }),
  budgetBlocked: (breakdown: BudgetBreakdown, ctx?: ErrorContext): AppError =>
    appError('BUDGET_BLOCKED', { ...ctx, details: { ...ctx?.details, ...breakdown } }),
  contextTooLarge: (
    info: { estimatedInputTokens: number; budgetTokens: number },
    ctx?: ErrorContext,
  ): AppError => appError('CONTEXT_TOO_LARGE', { ...ctx, details: { ...ctx?.details, ...info } }),
  outputInvalid: (issues: readonly ValidationIssue[] = [], ctx?: ErrorContext): AppError =>
    appError('OUTPUT_INVALID', { ...ctx, details: { ...ctx?.details, issues: [...issues] } }),
  approvalStale: (reason: ApprovalStaleReason, ctx?: ErrorContext): AppError =>
    appError('APPROVAL_STALE', { ...ctx, details: { ...ctx?.details, reason } }),
  projectChanged: (changedPaths: readonly RelPath[] = [], ctx?: ErrorContext): AppError =>
    appError('PROJECT_CHANGED', { ...ctx, details: { ...ctx?.details, changedPaths: [...changedPaths] } }),
  requestOutcomeUnknown: (attemptId: AttemptId, ctx?: ErrorContext): AppError =>
    appError('REQUEST_OUTCOME_UNKNOWN', { ...ctx, attemptId }),
  artifactWriteFailed: (ctx?: ErrorContext): AppError => appError('ARTIFACT_WRITE_FAILED', ctx),
  runnerUnavailable: (ctx?: ErrorContext): AppError => appError('RUNNER_UNAVAILABLE', ctx),
  providerUnavailable: (providerId?: ProviderId, ctx?: ErrorContext): AppError =>
    appError(
      'PROVIDER_UNAVAILABLE',
      providerId === undefined ? ctx : { ...ctx, details: { ...ctx?.details, providerId } },
    ),
  validationFailed: (issues: readonly ValidationIssue[], ctx?: ErrorContext): AppError =>
    appError('VALIDATION_FAILED', { ...ctx, details: { ...ctx?.details, issues: [...issues] } }),
  notFound: (entity: string, opts: { purged?: boolean } = {}, ctx?: ErrorContext): AppError =>
    appError('NOT_FOUND', { ...ctx, details: { ...ctx?.details, entity, purged: opts.purged ?? false } }),
  conflict: (details: Readonly<Record<string, unknown>> = {}, ctx?: ErrorContext): AppError =>
    appError('CONFLICT', { ...ctx, details: { ...ctx?.details, ...details } }),
  limitReached: (limit: LimitKind, ctx?: ErrorContext): AppError =>
    appError('LIMIT_REACHED', { ...ctx, details: { ...ctx?.details, limit } }),
  permissionDenied: (reason: PermissionDeniedReason, ctx?: ErrorContext): AppError =>
    appError('PERMISSION_DENIED', { ...ctx, details: { ...ctx?.details, reason } }),
  secureStorageUnavailable: (ctx?: ErrorContext): AppError => appError('SECURE_STORAGE_UNAVAILABLE', ctx),
  modelRefused: (providerId?: ProviderId, ctx?: ErrorContext): AppError =>
    appError(
      'MODEL_REFUSED',
      providerId === undefined ? ctx : { ...ctx, details: { ...ctx?.details, providerId } },
    ),
  /**
   * `INTERNAL` carries only the correlation id (02 §B0). It takes no context: a message, details, or ids could leak
   * internals (SQL errors, stacks, paths), and callers passing one at runtime have it ignored.
   */
  internal: (correlationId: CorrelationId): AppError => appError('INTERNAL', { correlationId }),
} as const;

/** Internal exception carrying an {@link AppError}; serialized at boundaries (IPC router, runner protocol server). */
export class RelayError extends Error {
  /** The boundary-safe error. */
  readonly appError: AppError;

  constructor(appErrorValue: AppError) {
    super(appErrorValue.userMessage);
    this.name = 'RelayError';
    this.appError = appErrorValue;
  }
}

/** Type guard for {@link RelayError}. */
export function isRelayError(e: unknown): e is RelayError {
  return e instanceof RelayError;
}

/**
 * Maps anything thrown to an {@link AppError} at a boundary: a {@link RelayError} keeps its error; anything else
 * becomes `INTERNAL` with only the correlation id (no message, stack, or path leaks; 02 §B0).
 */
export function toAppError(e: unknown, correlationId: CorrelationId): AppError {
  return isRelayError(e) ? e.appError : errors.internal(correlationId);
}
