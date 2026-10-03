// Mirror of the 06 F2 `allowedRunActions` truth table, used only by the fake bridge so paused scenarios expose the
// same `availableActions` the engine computes. Pages never call this: they render `RunDetail.availableActions`.
import type { PauseReason, RunAction, RunStatus } from '@relay/contracts';

export interface AllowedActionsContext {
  readonly unknownAttempts: number;
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
      if (ctx.unknownAttempts > 0) return ['decide_unknown', 'stop'];
      // Every unknown is decided: retry / re-profile a failed step, else resume (06 F2: every pause has a way out).
      return ctx.hasFailedStep ? ['retry_step', 'choose_profile', 'stop'] : ['resume', 'stop'];
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

function actionsFor(status: RunStatus, pauseReason: PauseReason | null, ctx: AllowedActionsContext): RunAction[] {
  // An unresolved unknown attempt is decidable from any pause (06 F2 clarification 15).
  if (status === 'paused' && ctx.unknownAttempts > 0) {
    const base = pauseReason === null ? (['stop'] as RunAction[]) : pausedActions(pauseReason, ctx);
    return base.includes('decide_unknown') ? base : [...base.filter((a) => a !== 'stop'), 'decide_unknown', 'stop'];
  }
  switch (status) {
    case 'queued':
      return ['cancel'];
    case 'running':
      return ['pause', 'cancel'];
    case 'awaiting_approval':
      return ['approve', 'request_revision', 'reject', 'cancel'];
    case 'paused':
      return pauseReason === null ? ['stop'] : pausedActions(pauseReason, ctx);
    case 'interrupted':
      // review_recovery needs every unknown attempt decided first.
      return ctx.unknownAttempts > 0 ? ['decide_unknown', 'stop'] : ['review_recovery', 'stop'];
    case 'cancelling':
      return [];
    case 'completed':
    case 'incomplete':
    case 'cancelled':
    case 'failed': {
      const exports: RunAction[] = ctx.hasPatchArtifact ? ['export_report', 'export_patch'] : ['export_report'];
      // An unknown charge left on a finished run can still be settled.
      return ctx.unknownAttempts > 0 ? ['decide_unknown', ...exports] : exports;
    }
  }
}
