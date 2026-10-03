import type { NextAction, RunAction, UNKNOWN_OUTCOME_DECISIONS } from '@relay/contracts';

/** Button labels for `AppError.nextAction` (ErrorView). Exhaustive over contracts NEXT_ACTIONS. */
export const NEXT_ACTION_LABELS: Readonly<Record<NextAction, string>> = {
  reconnect_provider: 'Reconnect provider',
  choose_profile: 'Choose another profile',
  wait: 'Try again later',
  increase_allowance: 'Increase allowance',
  stop: 'Stop run',
  narrow_scope: 'Narrow the file selection',
  retry_step: 'Retry step',
  reapprove: 'Review and approve again',
  resnapshot_and_replan: 'Re-snapshot files and re-plan',
  use_preserved_snapshot: 'Use preserved snapshot',
  decide_unknown: 'Decide on unknown charge',
  retry_export: 'Retry export',
  restart_runner: 'Restart runner',
  fix_input: 'Fix the input',
  none: 'Dismiss',
  reload: 'Reload',
  raise_limits: 'Raise limits',
  edit_policy: 'Edit project policy',
  use_session_key: 'Use a key for this session only',
  edit_goal: 'Edit goal',
  report_bug: 'Copy error details',
};

/** Button labels for `RunDetail.availableActions` (RecoveryPanel, run header). Exhaustive over RUN_ACTIONS. */
export const RUN_ACTION_LABELS: Readonly<Record<RunAction, string>> = {
  pause: 'Pause',
  cancel: 'Cancel run',
  stop: 'Stop run',
  resume: 'Resume',
  approve: 'Approve plan',
  request_revision: 'Request revision',
  reject: 'Reject plan',
  increase_allowance: 'Increase allowance',
  edit_project_allowance: 'Edit project allowance',
  choose_profile: 'Choose another profile',
  retry_step: 'Retry step',
  raise_limits: 'Raise limits',
  acknowledge_overrun: 'Acknowledge overrun',
  reconnect_provider: 'Reconnect provider',
  resnapshot_and_replan: 'Re-snapshot files and re-plan',
  use_preserved_snapshot: 'Use preserved snapshot',
  decide_unknown: 'Decide on unknown charge',
  review_recovery: 'Continue from last checkpoint',
  export_report: 'Export report…',
  export_patch: 'Export patch…',
};

/**
 * Confirmation toast titles after an action succeeded: what happened, in the past tense ("Plan approved"), not the
 * button label plus "done". Requests the engine finishes asynchronously say so ("Pause requested"): the call
 * returning does not mean the run has paused, stopped, or finished. Exhaustive over RUN_ACTIONS.
 */
export const RUN_ACTION_DONE_LABELS: Readonly<Record<RunAction, string>> = {
  pause: 'Pause requested',
  cancel: 'Cancellation requested',
  stop: 'Stop requested',
  resume: 'Run resumed',
  approve: 'Plan approved',
  request_revision: 'Revision requested',
  reject: 'Plan rejected',
  increase_allowance: 'Run allowance increased',
  edit_project_allowance: 'Project allowance updated',
  choose_profile: 'Profile changed',
  retry_step: 'Step retry started',
  raise_limits: 'Limits raised',
  acknowledge_overrun: 'Overrun acknowledged',
  reconnect_provider: 'Opening provider settings',
  resnapshot_and_replan: 'Re-snapshot and re-plan started',
  use_preserved_snapshot: 'Continuing with the preserved snapshot',
  decide_unknown: 'Unknown charge decided',
  review_recovery: 'Continuing from the last checkpoint',
  export_report: 'Report exported',
  export_patch: 'Patch exported',
};

/** Actions that stop or discard work and therefore need a ConfirmDialog (§5.7: destructive only). */
export const DESTRUCTIVE_RUN_ACTIONS: ReadonlySet<RunAction> = new Set<RunAction>(['cancel', 'stop', 'reject']);

/** `runs.decideUnknown` decision (contracts UNKNOWN_OUTCOME_DECISIONS). */
export type UnknownOutcomeDecision = (typeof UNKNOWN_OUTCOME_DECISIONS)[number];

/** §4.4 labels for the unknown-outcome decisions. The retry label always says it may incur another charge. */
export const UNKNOWN_OUTCOME_DECISION_LABELS: Readonly<Record<UnknownOutcomeDecision, string>> = {
  retry_acknowledging_charge: 'Retry (may incur another charge)',
  mark_failed_keep_liability: 'Mark as failed without retry',
  accept_estimated_charge: 'Accept the estimated charge',
};

/** One-line consequence of each unknown-outcome decision (RecoveryPanel rows, DecideUnknownDialog hints). */
export const UNKNOWN_OUTCOME_DECISION_HINTS: Readonly<Record<UnknownOutcomeDecision, string>> = {
  retry_acknowledging_charge:
    'Creates a new attempt with a new reservation. The possible charge of the earlier request stays until it is resolved.',
  mark_failed_keep_liability: 'The step is marked failed; the possible charge stays recorded as unknown liability.',
  accept_estimated_charge: 'Records the estimated amount as the charge for this request.',
};

/**
 * Plain wording of a busy database (E2 #2: `DATABASE_UNAVAILABLE database_busy`, next action wait) for a load. Nothing
 * retries a failed load on its own once the query gave up, so it never promises that Relay will.
 */
export const DATABASE_BUSY_MESSAGE = 'The database is in use by another program. Try again in a moment.';

/** The same for a failed command: the change was not made. */
export const DATABASE_BUSY_COMMAND_MESSAGE = 'The database is in use by another program, so nothing was changed. Try again in a moment.';
