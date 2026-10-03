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
    nextAction: 'retry_step',
    alternatives: ['stop'],
    httpStatus: 409,
    userMessage:
      'Relay cannot tell whether the provider finished this request. Its cost was counted as an estimate. Retry the step (this may incur another charge) or stop the run.',
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
  DATABASE_UNAVAILABLE: {
    retryable: false,
    nextAction: 'none',
    alternatives: [],
    httpStatus: 503,
    userMessage: 'Relay cannot use its database.',
  },
  PROJECT_ROOT_MISSING: {
    retryable: false,
    nextAction: 'none',
    alternatives: [],
    httpStatus: 404,
    userMessage: 'The project folder was moved, renamed, or deleted. Locate the folder to continue.',
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

/** Every {@link ErrorCode} except `INTERNAL`, which only {@link errors.internal} builds (02 §B0, B13). */
export type PublicErrorCode = Exclude<ErrorCode, 'INTERNAL'>;

function buildAppError(code: ErrorCode, ctx: ErrorContext): AppError {
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

/**
 * Builds an {@link AppError} for `code` from its {@link ERROR_DEFINITIONS} policy plus optional context.
 *
 * `code` cannot be `'INTERNAL'`: an internal error must not carry free-form context (a message, details, or ids could
 * leak SQL errors, stacks, or paths), so it is built only by {@link errors.internal}. A caller that gets past the type
 * (a cast, untyped JS) is routed there too: everything but the correlation id and a known reason is dropped.
 */
export function appError(code: PublicErrorCode, ctx: ErrorContext = {}): AppError {
  if ((code as ErrorCode) === 'INTERNAL') return errors.internal(ctx.correlationId, ctx.details?.['reason'] as InternalReason | undefined);
  return buildAppError(code, ctx);
}

/** `PERMISSION_DENIED` `details.reason` values (§11). */
export const PERMISSION_DENIED_REASONS = [
  'outside_root',
  'excluded',
  'provider_not_allowed',
  'inside_project',
  'contains_project',
  'unsafe_root',
  'untrusted_sender',
  'unreadable', // a selected project file exists but cannot be read (EACCES/EPERM/EIO); details.relPath names it
  'suspected_secret', // a selected file's content looks like a credential and was not acknowledged (details.denied)
  'hard_link', // a selected file has more than one hard link, so it may be a file from outside the project
] as const;
/** Schema for {@link PermissionDeniedReason}. */
export const permissionDeniedReasonSchema = z.enum(PERMISSION_DENIED_REASONS);
/** `PERMISSION_DENIED` reason. */
export type PermissionDeniedReason = z.infer<typeof permissionDeniedReasonSchema>;

/**
 * `INTERNAL` `details.reason` values: a closed set, so an internal error says WHICH invariant broke without carrying a
 * message, stack, or path (02 §B0, B13). `aborted` is the provider call our own AbortSignal cancelled (04 §D3 row 1).
 */
export const INTERNAL_REASONS = [
  'aborted',
  'not_implemented',
  'snapshot_hash_mismatch',
  'snapshot_input_hash_mismatch',
  'snapshot_not_utf8',
  'integrity_check_failed',
  'idempotency_result_invalid',
  'artifact_not_json',
  'artifact_invalid',
  'provider_call_failed_before_dispatch',
] as const;
/** Schema for {@link InternalReason}. */
export const internalReasonSchema = z.enum(INTERNAL_REASONS);
/** `INTERNAL` reason. */
export type InternalReason = z.infer<typeof internalReasonSchema>;

/**
 * Curated, static `userMessage`s for the INTERNAL reasons where the generic "Something went wrong" would mislead the
 * user or hide the only recovery. They live here, not at the call site, so `INTERNAL` still never carries a caller's
 * free-form text (02 §B0): the message is a fixed string chosen by the closed reason.
 */
export const INTERNAL_REASON_MESSAGES: Readonly<Partial<Record<InternalReason, string>>> = {
  not_implemented: 'This feature is not available in this build yet.',
  integrity_check_failed: 'The Relay database failed its integrity check. Restore it from a backup in the backups folder.',
};

/**
 * `DATABASE_UNAVAILABLE` `details.reason` values: a closed set, so the fatal runner message and the UI can say what
 * is wrong with the database and offer the right recovery (wait / free disk space / restore a backup / update Relay).
 */
export const DATABASE_UNAVAILABLE_REASONS = [
  'database_busy', // another process held the database lock for the whole boot retry window
  'schema_too_new', // written by a newer Relay version
  'migration_checksum_mismatch', // an applied migration differs from this build's copy
  'disk_full', // SQLITE_FULL
  'db_readonly', // SQLITE_READONLY, or the file / folder is not writable
  'db_corrupt', // SQLITE_CORRUPT / SQLITE_NOTADB at open (before the integrity check)
  'integrity_check_failed', // PRAGMA quick_check did not return ok
  'db_cannot_open', // SQLITE_CANTOPEN / SQLITE_IOERR at open
] as const;
/** Schema for {@link DatabaseUnavailableReason}. */
export const databaseUnavailableReasonSchema = z.enum(DATABASE_UNAVAILABLE_REASONS);
/** `DATABASE_UNAVAILABLE` reason. */
export type DatabaseUnavailableReason = z.infer<typeof databaseUnavailableReasonSchema>;

/** Curated user message per {@link DatabaseUnavailableReason} (static text; never SQLite output or paths). */
export const DATABASE_UNAVAILABLE_MESSAGES: Readonly<Record<DatabaseUnavailableReason, string>> = {
  database_busy: 'The Relay database is busy because another program is using it. Close other copies of Relay and try again.',
  schema_too_new: 'This database was created by a newer version of Relay. Update Relay to open it.',
  migration_checksum_mismatch: 'The Relay database does not match this version of Relay. Update Relay or restore a backup.',
  disk_full: 'The disk is full, so Relay cannot write its database. Free some disk space and try again.',
  db_readonly: 'Relay cannot write its database because the file or its folder is read-only. Check the permissions and try again.',
  db_corrupt: 'The Relay database file is damaged. Restore it from a backup.',
  integrity_check_failed: 'The Relay database failed its integrity check. Restore it from a backup.',
  db_cannot_open: 'Relay could not open its database file. Check that the data folder exists and is accessible.',
};

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
   * The database cannot be used (fatal at boot, 03 §C1/§C2). The userMessage is the curated one for `reason`;
   * `database_busy` is retryable (restart the runner), every other reason is not.
   */
  databaseUnavailable: (reason: DatabaseUnavailableReason, ctx?: Omit<ErrorContext, 'userMessage'>): AppError => {
    const e = appError('DATABASE_UNAVAILABLE', { ...ctx, userMessage: DATABASE_UNAVAILABLE_MESSAGES[reason], details: { ...ctx?.details, reason } });
    return reason === 'database_busy' ? { ...e, retryable: true, nextAction: 'restart_runner' } : e;
  },
  /** The project's root folder no longer exists (moved / renamed / deleted). `projects.relocateRoot` re-points it. */
  projectRootMissing: (ctx?: ErrorContext): AppError => appError('PROJECT_ROOT_MISSING', ctx),
  /**
   * `INTERNAL` carries only the correlation id (02 §B0) and, optionally, a closed {@link InternalReason}. It takes no
   * free-form context: a message, details, or ids could leak internals (SQL errors, stacks, paths), so anything else
   * passed at runtime is ignored. `correlationId` is `undefined` only where none exists (providers, tools); the
   * boundary that surfaces the error assigns one. `aborted` also sets `details.aborted: true` (read by callers of 04 §D3).
   * A reason listed in {@link INTERNAL_REASON_MESSAGES} gets that static `userMessage`. This is the ONLY builder of
   * `INTERNAL` ({@link appError} refuses the code).
   */
  internal: (correlationId: CorrelationId | undefined, reason?: InternalReason): AppError => {
    const known = typeof reason === 'string' && (INTERNAL_REASONS as readonly string[]).includes(reason) ? reason : undefined;
    const details = known === undefined ? undefined : { reason: known, ...(known === 'aborted' ? { aborted: true } : {}) };
    const userMessage = known === undefined ? undefined : INTERNAL_REASON_MESSAGES[known];
    return buildAppError('INTERNAL', {
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(details === undefined ? {} : { details }),
      ...(userMessage === undefined ? {} : { userMessage }),
    });
  },
} as const;

/**
 * Internal exception carrying an {@link AppError}. Boundaries (IPC router, runner protocol server) serialize only
 * `.appError` (via {@link toAppError}); the optional `cause` is for in-process debugging and is never serialized,
 * because a provider SDK error can hold request headers or raw bodies.
 */
export class RelayError extends Error {
  /** The boundary-safe error. */
  readonly appError: AppError;

  constructor(appErrorValue: AppError, options?: { readonly cause?: unknown }) {
    super(appErrorValue.userMessage, options === undefined ? undefined : { cause: options.cause });
    this.name = 'RelayError';
    this.appError = appErrorValue;
  }
}

/**
 * The errno code (`'ENOENT'`, `'EACCES'`, …) of a thrown Node fs/system error, else undefined. Only the code: the
 * message and `path` of such errors hold absolute paths and must never reach an {@link AppError} (00b §2.6).
 */
export function errnoOf(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null || !('code' in e)) return undefined;
  return typeof e.code === 'string' && /^E[A-Z0-9]+$/.test(e.code) ? e.code : undefined;
}

/** `{ errno }` for {@link ErrorContext.details} when `e` carries an errno code, else `{}`. */
export function errnoDetails(e: unknown): { readonly errno?: string } {
  const errno = errnoOf(e);
  return errno === undefined ? {} : { errno };
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

/**
 * `{ code, reason?, message }` for the runner's `fatal` message (02 §B7, E2 #3): a {@link RelayError} keeps its code,
 * its closed `details.reason` (when it is a short string), and its userMessage; anything else is INTERNAL with the
 * generic INTERNAL message (never the raw error text, which can hold SQLite output or paths).
 */
export function fatalInfoOf(e: unknown): { readonly code: ErrorCode; readonly reason?: string; readonly message: string } {
  if (!isRelayError(e)) return { code: 'INTERNAL', message: ERROR_DEFINITIONS.INTERNAL.userMessage };
  const reason = e.appError.details?.['reason'];
  const ok = typeof reason === 'string' && /^[a-z_]{1,64}$/.test(reason);
  return { code: e.appError.code, ...(ok ? { reason } : {}), message: e.appError.userMessage };
}

/** True when `e` is the retryable `DATABASE_UNAVAILABLE database_busy` (a lock held by another connection, E2 #2). */
export function isDatabaseBusyError(e: unknown): boolean {
  return isRelayError(e) && e.appError.code === 'DATABASE_UNAVAILABLE' && e.appError.details?.['reason'] === 'database_busy';
}
