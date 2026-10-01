// Error mapping (10 J2): AppError → ErrorView props, and `nextAction` → a route or a page handler.
import { appError } from '@relay/contracts';
import type { AppError, ErrorCode, NextAction } from '@relay/contracts';
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
    case 'restart_runner':
    case 'report_bug':
      return { kind: 'navigate', to: paths.settings('diagnostics') };
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
  return appError('INTERNAL');
}

const ERROR_TITLES: Partial<Readonly<Record<ErrorCode, string>>> = {
  RUNNER_UNAVAILABLE: 'The background runner is not available',
  NOT_FOUND: 'Not found',
  AUTH_REQUIRED: 'Provider sign-in needed',
  BUDGET_BLOCKED: 'Blocked by the allowance',
  CONFLICT: 'This item changed',
};

/** Short title for an error banner, by code. Falls back to the error's own user message. */
export function errorTitle(error: AppError): string {
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
