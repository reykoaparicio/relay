// Mirror of the 06 F2 `allowedRunActions` truth table, used only by the fake bridge so paused scenarios expose the
// same `availableActions` the engine computes. Pages never call this: they render `RunDetail.availableActions`.
import type { PauseReason, RunAction, RunStatus } from '@relay/contracts';

export interface AllowedActionsContext {
  readonly unknownAttempts: number;
  readonly hasFailedStep: boolean;
  readonly hasPatchArtifact: boolean;
}

function pausedActions(reason: PauseReason, ctx: AllowedActionsContext): RunAction[] {
  switch (reason) {
    case 'budget_run':
      return ['increase_allowance', 'choose_profile', 'stop'];
    case 'budget_project':
      return ['edit_project_allowance', 'choose_profile', 'stop'];
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
      return ctx.hasFailedStep ? ['retry_step', 'choose_profile', 'stop'] : ['stop'];
    case 'auth_required':
      return ['reconnect_provider', 'resume', 'stop'];
    case 'user':
    case 'rate_limited':
      return ['resume', 'stop'];
    case 'approval_stale':
      return ['resnapshot_and_replan', 'use_preserved_snapshot', 'stop'];
  }
}

/** 06 F2 truth table. */
export function allowedRunActions(
  status: RunStatus,
  pauseReason: PauseReason | null,
  ctx: AllowedActionsContext,
): RunAction[] {
  switch (status) {
    case 'queued':
      return ['cancel'];
    case 'running':
      return ['pause', 'cancel'];
    case 'awaiting_approval':
      return ['approve', 'request_revision', 'reject', 'cancel'];
    case 'paused':
      return pauseReason === null ? ['resume', 'stop'] : pausedActions(pauseReason, ctx);
    case 'interrupted':
      return ctx.unknownAttempts > 0 ? ['review_recovery', 'decide_unknown', 'stop'] : ['review_recovery', 'stop'];
    case 'cancelling':
      return [];
    case 'completed':
    case 'incomplete':
    case 'cancelled':
    case 'failed':
      return ctx.hasPatchArtifact ? ['export_report', 'export_patch'] : ['export_report'];
  }
}
