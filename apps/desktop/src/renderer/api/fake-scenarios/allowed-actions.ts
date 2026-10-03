// Mirror of the 06 F2 `allowedRunActions` truth table, used only by the fake bridge so paused scenarios expose the
// same `availableActions` the engine computes. Pages never call this: they render `RunDetail.availableActions`.
import type { PauseReason, RunAction, RunStatus } from '@relay/contracts';

export interface AllowedActionsContext {
  /** Requests that may not have completed (counted as estimates; nothing to decide). */
  readonly uncertainAttempts: number;
  readonly hasFailedStep: boolean;
  readonly hasPatchArtifact: boolean;
  /** A provider of an open model step has no key: resume from auth_required would fail, so it is not offered. */
  readonly missingCredential?: boolean;
  /** False when an approval_stale pause is not a project change: no `use_preserved_snapshot`. */
  readonly preservableSnapshot?: boolean;
  /** False when no profile can be chosen for the blocked step: no `choose_profile`. */
  readonly hasProfileOptions?: boolean;
}

/** A budget pause: with a failed step, retry_step sits next to choose_profile (engine E1 #8). */
function budgetActions(raise: 'increase_allowance' | 'edit_project_allowance', ctx: AllowedActionsContext): RunAction[] {
  return ctx.hasFailedStep ? [raise, 'retry_step', 'choose_profile', 'stop'] : [raise, 'choose_profile', 'stop'];
}

function pausedActions(reason: PauseReason, ctx: AllowedActionsContext): RunAction[] {
  switch (reason) {
    case 'budget_run':
      return budgetActions('increase_allowance', ctx);
    case 'budget_project':
      return budgetActions('edit_project_allowance', ctx);
    case 'budget_overrun':
      return ['acknowledge_overrun', 'increase_allowance', 'stop'];
    case 'limit_attempts':
    case 'deadline':
      return ['raise_limits', 'stop'];
    case 'output_invalid':
    case 'provider_unavailable':
    case 'model_refused':
      return ['retry_step', 'choose_profile', 'stop'];
    case 'setup_blocked':
      return ['resume', 'choose_profile', 'stop'];
    case 'unknown_outcome':
      // The last request may or may not have completed; its cost is counted as an estimate. Retry (may charge again) or stop.
      return ['retry_step', 'stop'];
    case 'auth_required':
      return ctx.missingCredential === true ? ['reconnect_provider', 'stop'] : ['reconnect_provider', 'resume', 'stop'];
    case 'user':
    case 'rate_limited':
      return ['resume', 'stop'];
    case 'approval_stale':
      return ctx.preservableSnapshot === false
        ? ['resnapshot_and_replan', 'stop']
        : ['resnapshot_and_replan', 'use_preserved_snapshot', 'stop'];
  }
}

/** 06 F2 truth table (engine `allowedRunActions`, incl. the E1 #4/#8 changes). */
export function allowedRunActions(
  status: RunStatus,
  pauseReason: PauseReason | null,
  ctx: AllowedActionsContext,
): RunAction[] {
  const actions = actionsFor(status, pauseReason, ctx);
  return ctx.hasProfileOptions === false ? actions.filter((a) => a !== 'choose_profile') : actions;
}

/** Exports of a run that has not finished: an interim report (and the latest patch, when one exists). */
function interimExports(ctx: AllowedActionsContext): RunAction[] {
  return ctx.hasPatchArtifact ? ['export_report', 'export_patch'] : ['export_report'];
}

function actionsFor(status: RunStatus, pauseReason: PauseReason | null, ctx: AllowedActionsContext): RunAction[] {
  switch (status) {
    case 'queued':
      return ['pause', 'cancel', ...interimExports(ctx)];
    case 'running':
      return ['pause', 'cancel', ...interimExports(ctx)];
    case 'awaiting_approval':
      return ['approve', 'request_revision', 'reject', 'pause', 'cancel', ...interimExports(ctx)];
    case 'paused':
      return [...(pauseReason === null ? (['stop'] as RunAction[]) : pausedActions(pauseReason, ctx)), ...interimExports(ctx)];
    case 'interrupted':
      return ['review_recovery', 'stop', ...interimExports(ctx)];
    case 'cancelling':
      return interimExports(ctx);
    case 'completed':
    case 'incomplete':
    case 'cancelled':
    case 'failed':
      return ctx.hasPatchArtifact ? ['export_report', 'export_patch'] : ['export_report'];
  }
}
