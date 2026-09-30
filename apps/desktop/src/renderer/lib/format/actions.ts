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
  export_report: 'Export report',
  export_patch: 'Export patch',
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
