// 06 F2: the server-computed run actions (`RunDetail.availableActions`) — the ONE truth table, shared by the engine
// (which also gates every decision op with it) and the renderer's fake bridge (so the two can never drift, U-4).
// Pure: no I/O, no clock.
import type { PauseReason, RunAction, RunStatus } from './status.js';

/** Facts `allowedRunActions` needs beyond the run's status and pause reason. */
export interface RunActionFacts {
  /** Legacy unknown liabilities still open (0 for data since decision 1); informational, never offers an action. */
  readonly unknownAttempts: number;
  readonly hasFailedStep: boolean;
  /** A patch can be exported (a finished run's patch; the CURRENT patch of a run in progress). */
  readonly hasPatchArtifact: boolean;
  /**
   * E1 #8: a provider of an open model step has no credential ref. `resume` from `paused(auth_required)` then always
   * fails (AUTH_REQUIRED), so only `reconnect_provider` is offered until the key is back. Absent = false.
   */
  readonly missingCredential?: boolean | undefined;
  /**
   * E1 #8: false when an `approval_stale` pause is NOT a project change (plan / scope / provider changed):
   * `use_preserved_snapshot` only answers PROJECT_CHANGED, so it is not offered then. Absent = offered.
   */
  readonly preservableSnapshot?: boolean | undefined;
  /**
   * E1 #8: false when no profile can be chosen for the blocked step (no allowed provider with a credential ref and a
   * supported catalog model): `choose_profile` is then not offered. Absent = offered.
   */
  readonly hasProfileOptions?: boolean | undefined;
  /**
   * Decision 1: the latest row of some model step is `failed` or `unknown` (an uncertain outcome): `retry_step` can act
   * on it. Absent = true (the gate re-checks the step when the action is taken).
   */
  readonly hasRetryableStep?: boolean | undefined;
}

/**
 * The non-stop way out of a budget pause. With a FAILED step the blocking step changes profile through
 * `runs.retryStep` (a new row), so `retry_step` is offered next to `choose_profile` (both accepted there, E1 #8).
 */
function budgetActions(raise: 'increase_allowance' | 'edit_project_allowance', f: RunActionFacts): RunAction[] {
  return f.hasFailedStep ? [raise, 'retry_step', 'choose_profile', 'stop'] : [raise, 'choose_profile', 'stop'];
}

function pausedActions(reason: PauseReason, f: RunActionFacts): RunAction[] {
  switch (reason) {
    case 'budget_run':
      return budgetActions('increase_allowance', f);
    case 'budget_project':
      return budgetActions('edit_project_allowance', f);
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
      // Decision 1: the uncertain attempt is already settled as an estimate; the only choices are "retry (may incur
      // another charge)" and stop. Never retried automatically. With no step left to retry (e.g. reconciliation
      // settled it meanwhile) `resume` continues, so this pause, like every other, has a non-stop way out.
      return f.hasRetryableStep === false ? ['resume', 'stop'] : ['retry_step', 'stop'];
    case 'auth_required':
      return f.missingCredential === true ? ['reconnect_provider', 'stop'] : ['reconnect_provider', 'resume', 'stop'];
    case 'user':
    case 'rate_limited':
      return ['resume', 'stop'];
    case 'approval_stale':
      return f.preservableSnapshot === false ? ['resnapshot_and_replan', 'stop'] : ['resnapshot_and_replan', 'use_preserved_snapshot', 'stop'];
  }
}

function actionsFor(run: { readonly status: RunStatus; readonly pauseReason: PauseReason | null }, f: RunActionFacts): RunAction[] {
  switch (run.status) {
    case 'queued':
      return ['pause', 'cancel'];
    case 'running':
      return ['pause', 'cancel'];
    case 'awaiting_approval':
      return ['approve', 'request_revision', 'reject', 'pause', 'cancel'];
    case 'paused':
      return run.pauseReason === null ? ['stop'] : pausedActions(run.pauseReason, f);
    case 'interrupted':
      return ['review_recovery', 'stop'];
    case 'cancelling':
    case 'completed':
    case 'incomplete':
    case 'cancelled':
    case 'failed':
      return [];
  }
}

/**
 * Server-computed actions (`RunDetail.availableActions`); the UI renders only these (F2 truth table), and every
 * decision op (`runs.resume`, `runs.retryStep`, …) refuses an action not listed here for the run's current state
 * (CONFLICT `decision_not_applicable`), so the UI and the server can never disagree. Decision 1: `decide_unknown` is
 * never offered (an uncertain outcome is settled as an estimate at once). Decision 2: `pause` is offered while the run
 * is queued, running or awaiting approval, and `export_report` (+ `export_patch` once a patch can be exported) in EVERY
 * state — a non-terminal run exports an interim report of what finished so far.
 */
export function allowedRunActions(run: { readonly status: RunStatus; readonly pauseReason: PauseReason | null }, f: RunActionFacts): RunAction[] {
  const actions = actionsFor(run, f);
  const exports: RunAction[] = f.hasPatchArtifact ? ['export_report', 'export_patch'] : ['export_report'];
  return [...(f.hasProfileOptions === false ? actions.filter((a) => a !== 'choose_profile') : actions), ...exports];
}
