// Error mapping (10 J2): AppError → ErrorView props, and `nextAction` → a route or a page handler.
import { DATABASE_UNAVAILABLE_MESSAGES, errors } from '@relay/contracts';
import type { AppError, DatabaseUnavailableReason, ErrorCode, NextAction, RunnerFatal } from '@relay/contracts';
import { DATABASE_BUSY_MESSAGE } from '../lib/format/actions';
import { paths } from '../features/shell/paths';
import { isAppErrorException } from './client';

/** Where a chosen next action leads. */
export type NextActionTarget =
  | { readonly kind: 'navigate'; readonly to: string }
  /** The page owns the behavior (open a dialog, focus a field, refetch, retry the step, …). */
  | { readonly kind: 'handler'; readonly action: NextAction }
  | { readonly kind: 'dismiss' };

/** Context for route-based targets. */
export interface NextActionContext {
  readonly projectId?: string | null;
  readonly runId?: string | null;
}

/**
 * Maps a next action to its target. Navigation targets are fixed here; everything else (for example
 * `increase_allowance` → the allowance dialog, `narrow_scope` → focus the file picker) is a page handler.
 */
export function nextActionTarget(action: NextAction, ctx: NextActionContext = {}): NextActionTarget {
  switch (action) {
    case 'reconnect_provider':
    case 'use_session_key':
      return { kind: 'navigate', to: paths.settings('providers') };
    case 'report_bug':
      return { kind: 'navigate', to: paths.settings('diagnostics') };
    // `useNextAction` restarts the runner in place (`app.restartRunner`); a page may still own it.
    case 'restart_runner':
      return { kind: 'handler', action };
    case 'edit_policy':
      return { kind: 'navigate', to: paths.settings('projects', { project: ctx.projectId ?? undefined }) };
    case 'decide_unknown':
      return ctx.projectId && ctx.runId
        ? { kind: 'navigate', to: paths.run(ctx.projectId, ctx.runId) }
        : { kind: 'handler', action };
    case 'none':
      return { kind: 'dismiss' };
    case 'choose_profile':
    case 'wait':
    case 'increase_allowance':
    case 'stop':
    case 'narrow_scope':
    case 'retry_step':
    case 'reapprove':
    case 'resnapshot_and_replan':
    case 'use_preserved_snapshot':
    case 'retry_export':
    case 'fix_input':
    case 'reload':
    case 'raise_limits':
    case 'edit_goal':
      return { kind: 'handler', action };
  }
}

/**
 * Any thrown value → the AppError that ErrorView renders. Non-AppError throws (a bug in the renderer or a
 * broken bridge) become `INTERNAL` without leaking the message.
 */
export function toViewError(e: unknown): AppError {
  if (isAppErrorException(e)) return e.appError;
  return errors.internal(undefined);
}

const ERROR_TITLES: Partial<Readonly<Record<ErrorCode, string>>> = {
  PROJECT_ROOT_MISSING: 'Project folder not found',
  RUNNER_UNAVAILABLE: 'The background runner is not available',
  NOT_FOUND: 'Not found',
  AUTH_REQUIRED: 'Provider sign-in needed',
  BUDGET_BLOCKED: 'Blocked by the allowance',
  CONFLICT: 'This item changed',
};

/** Short title for an error banner, by code. Falls back to the error's own user message. */
export function errorTitle(error: AppError): string {
  if (isDatabaseBusy(error)) return DATABASE_BUSY_TEXT;
  return ERROR_TITLES[error.code] ?? error.userMessage;
}

/** Validation issues carried by a `VALIDATION_FAILED` error (`details.issues`), else []. */
export function validationIssuesOf(e: unknown): ReadonlyArray<{ readonly path: string; readonly message: string; readonly code: string }> {
  if (!isAppErrorException(e) || e.appError.code !== 'VALIDATION_FAILED') return [];
  const issues = e.appError.details?.['issues'];
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (i): i is { path: string; message: string; code: string } =>
      typeof i === 'object' && i !== null && typeof (i as { path?: unknown }).path === 'string' && typeof (i as { message?: unknown }).message === 'string',
  );
}

/** The AppError of a thrown value, else null. */
export function appErrorOf(e: unknown): AppError | null {
  return isAppErrorException(e) ? e.appError : null;
}

/** `details.reason` of an AppError (a short string), else null. */
export function errorReason(e: AppError | null | undefined): string | null {
  const reason = e?.details?.['reason'];
  return typeof reason === 'string' ? reason : null;
}

/**
 * E2 #2: `DATABASE_UNAVAILABLE database_busy` — another program holds the database lock. Retryable (next action
 * `wait`); queries retry it with a short backoff, and it is never shown as a crash.
 */
export function isDatabaseBusy(e: unknown): boolean {
  const error = isAppErrorException(e) ? e.appError : (e as AppError | null | undefined);
  return error?.code === 'DATABASE_UNAVAILABLE' && errorReason(error) === 'database_busy';
}

/** Plain wording of a busy database (E2 #2). */
export const DATABASE_BUSY_TEXT = DATABASE_BUSY_MESSAGE;

/** E2 #7: the project's folder was moved, renamed, or deleted. */
export function isProjectRootMissing(e: unknown): boolean {
  return appErrorOf(e)?.code === 'PROJECT_ROOT_MISSING';
}

/** Fatal reasons a backup restore can fix (the database file itself is damaged or from a newer Relay). */
export const RESTORABLE_FATAL_REASONS: readonly string[] = ['db_corrupt', 'integrity_check_failed', 'schema_too_new'];

/** True when restoring the latest backup is a sensible recovery for this runner fatal. */
export function fatalOffersRestore(fatal: RunnerFatal | null | undefined): boolean {
  return fatal?.reason !== undefined && fatal.reason !== null && RESTORABLE_FATAL_REASONS.includes(fatal.reason);
}

/**
 * `Diagnostics.runner.lastFatal` in plain words: the curated DATABASE_UNAVAILABLE message for its reason, a fixed
 * sentence for a crash loop, else the (redacted, user-presentable) message main recorded.
 */
export function runnerFatalText(fatal: RunnerFatal): string {
  const reason = fatal.reason;
  if (reason !== null && reason in DATABASE_UNAVAILABLE_MESSAGES) {
    return DATABASE_UNAVAILABLE_MESSAGES[reason as DatabaseUnavailableReason];
  }
  if (reason === 'restart_limit') {
    return 'The background runner stopped several times in a row, so Relay stopped restarting it automatically.';
  }
  return fatal.message;
}
