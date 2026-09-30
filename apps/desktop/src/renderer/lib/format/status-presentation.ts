import {
  Archive,
  Ban,
  Calculator,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CircleQuestionMark,
  CircleX,
  Clock,
  CloudOff,
  AlarmClock,
  FileExclamationPoint,
  FileX,
  Hand,
  KeyRound,
  Lightbulb,
  ListChecks,
  Loader,
  Receipt,
  Repeat,
  Send,
  ShieldX,
  Sigma,
  SkipForward,
  Timer,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Wallet,
  ZapOff,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { assertNever } from '@relay/contracts';
import type {
  AttemptState,
  CostCertainty,
  MemoryStatus,
  PauseReason,
  RunStatus,
  StepState,
} from '@relay/contracts';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'unknown';

export interface StatusPresentation {
  readonly label: string;
  readonly tone: StatusTone;
  readonly icon: LucideIcon;
  /** Short visible sentence (never tooltip-only, §5.7). */
  readonly detail?: string;
  /** The icon spins while the state is in progress; it renders static under reduced motion (I5). */
  readonly animated?: boolean;
}

export interface StatusKindMap {
  run: RunStatus;
  pause: PauseReason;
  step: StepState;
  attempt: AttemptState;
  memory: MemoryStatus;
  certainty: CostCertainty;
}
export type StatusKind = keyof StatusKindMap;

// Each table is a Record over the contracts enum, so adding an enum member is a compile error here.

const RUN: Record<Exclude<RunStatus, 'paused'>, StatusPresentation> = {
  queued: { label: 'Queued', tone: 'neutral', icon: Clock },
  running: { label: 'Running', tone: 'info', icon: Loader, animated: true },
  awaiting_approval: { label: 'Awaiting your approval', tone: 'warning', icon: Hand },
  cancelling: {
    label: 'Cancelling', tone: 'neutral', icon: Loader, animated: true,
    detail: 'Finishing the in-flight request before stopping',
  },
  interrupted: {
    label: 'Interrupted', tone: 'warning', icon: ZapOff,
    detail: 'Relay stopped unexpectedly. Review what happened before continuing',
  },
  completed: { label: 'Completed', tone: 'success', icon: CircleCheck },
  incomplete: {
    label: 'Incomplete', tone: 'warning', icon: CircleDashed,
    detail: 'The run ended before the goal was met. Results are partial',
  },
  failed: {
    label: 'Failed', tone: 'danger', icon: CircleX,
    detail: 'Stopped by an internal error. Completed artifacts are intact',
  },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban, detail: 'Stopped by you. Finished steps are kept' },
};

/** Shown when a run is `paused` but the pause reason is not (yet) known to the view. */
const PAUSED_GENERIC: StatusPresentation = { label: 'Paused', tone: 'warning', icon: CirclePause };

const PAUSE: Record<PauseReason, StatusPresentation> = {
  budget_run: {
    label: 'Paused: run budget', tone: 'warning', icon: CirclePause,
    detail: "The next step would exceed this run's allowance",
  },
  budget_project: {
    label: 'Paused: project budget', tone: 'warning', icon: Wallet,
    detail: "The next step would exceed the project's monthly allowance",
  },
  budget_overrun: {
    label: 'Paused: cost exceeded reservation', tone: 'warning', icon: TrendingUp,
    detail: 'The last request cost more than reserved. Acknowledge to continue',
  },
  user: { label: 'Paused by you', tone: 'neutral', icon: CirclePause },
  auth_required: {
    label: 'Paused: provider sign-in needed', tone: 'warning', icon: KeyRound,
    detail: 'Reconnect the provider to continue',
  },
  rate_limited: {
    label: 'Paused: provider rate limit', tone: 'warning', icon: Timer,
    detail: 'Automatic waits are used up. Resume when ready',
  },
  setup_blocked: {
    label: 'Paused: setup blocked', tone: 'warning', icon: TriangleAlert,
    detail: 'A required check failed before the step could start',
  },
  approval_stale: {
    label: 'Paused: approval out of date', tone: 'warning', icon: FileExclamationPoint,
    detail: 'Project files changed after approval',
  },
  limit_attempts: {
    label: 'Paused: attempt limit reached', tone: 'warning', icon: Repeat, detail: 'Raise the limit or stop',
  },
  deadline: { label: 'Paused: time limit reached', tone: 'warning', icon: AlarmClock, detail: 'Raise the limit or stop' },
  output_invalid: {
    label: "Paused: output didn't match schema", tone: 'warning', icon: FileX,
    detail: 'Repair attempts are used up. Retry the step or choose another profile',
  },
  provider_unavailable: {
    label: 'Paused: provider unavailable', tone: 'warning', icon: CloudOff,
    detail: 'Retries are used up. Retry the step or choose another profile',
  },
  model_refused: {
    label: 'Paused: model declined', tone: 'warning', icon: ShieldX, detail: 'Choose another profile or edit the goal',
  },
  unknown_outcome: {
    label: 'Paused: unknown request outcome', tone: 'unknown', icon: CircleQuestionMark,
    detail: 'Decide how to handle the possible charge',
  },
};

const STEP: Record<StepState, StatusPresentation> = {
  pending: { label: 'Not started', tone: 'neutral', icon: Circle },
  ready: { label: 'Ready', tone: 'neutral', icon: CircleDot },
  reserved: { label: 'Budget reserved', tone: 'info', icon: Wallet },
  executing: { label: 'Running', tone: 'info', icon: Loader, animated: true },
  validating: { label: 'Validating output', tone: 'info', icon: ListChecks },
  awaiting_approval: { label: 'Awaiting your approval', tone: 'warning', icon: Hand },
  succeeded: { label: 'Done', tone: 'success', icon: CircleCheck },
  failed: { label: 'Failed', tone: 'danger', icon: CircleX, detail: 'This step did not produce a valid output' },
  unknown: {
    label: 'Unknown outcome', tone: 'unknown', icon: CircleQuestionMark,
    detail: 'The provider may have processed the request',
  },
  skipped: { label: 'Skipped', tone: 'neutral', icon: SkipForward },
};

const ATTEMPT: Record<AttemptState, StatusPresentation> = {
  created: { label: 'Created', tone: 'neutral', icon: Circle },
  reserved: { label: 'Reserved', tone: 'info', icon: Wallet },
  dispatching: { label: 'Sending', tone: 'info', icon: Send },
  succeeded: { label: 'Succeeded', tone: 'success', icon: CircleCheck },
  failed_before_dispatch: {
    label: 'Not sent', tone: 'neutral', icon: Ban, detail: 'Failed before the request left Relay. No charge',
  },
  failed: { label: 'Failed', tone: 'danger', icon: CircleX },
  unknown: {
    label: 'Unknown outcome', tone: 'unknown', icon: CircleQuestionMark,
    detail: 'The request may have been processed and charged',
  },
  reconciled_succeeded: { label: 'Reconciled: succeeded', tone: 'success', icon: CircleCheck },
  reconciled_failed: { label: 'Reconciled: failed', tone: 'danger', icon: CircleX },
  abandoned: {
    label: 'Abandoned', tone: 'neutral', icon: Ban, detail: 'Marked failed. The possible charge is kept as liability',
  },
};

const MEMORY: Record<MemoryStatus, StatusPresentation> = {
  suggested: { label: 'Suggested', tone: 'info', icon: Lightbulb, detail: 'Not used until you approve it' },
  approved: { label: 'Approved', tone: 'success', icon: CircleCheck },
  archived: { label: 'Archived', tone: 'neutral', icon: Archive },
  rejected: { label: 'Rejected', tone: 'neutral', icon: CircleX },
  deleted: { label: 'Deleted', tone: 'neutral', icon: Trash2 },
};

const CERTAINTY: Record<CostCertainty, StatusPresentation> = {
  reported: { label: 'Reported', tone: 'neutral', icon: Receipt },
  calculated: { label: 'Calculated', tone: 'neutral', icon: Calculator },
  estimated: { label: 'est.', tone: 'neutral', icon: Sigma },
  unknown: { label: 'Unknown charge', tone: 'unknown', icon: CircleQuestionMark },
};

function runPresentation(status: RunStatus, pauseReason: PauseReason | null | undefined): StatusPresentation {
  if (status !== 'paused') return RUN[status];
  return pauseReason ? PAUSE[pauseReason] : PAUSED_GENERIC;
}

/**
 * Label, tone, icon, and optional visible detail for every status enum in contracts (09 I2).
 * For `kind: 'run'` with value `paused`, pass the pause reason to get its specific row.
 */
export function statusPresentation<K extends StatusKind>(
  kind: K,
  value: StatusKindMap[K],
  pauseReason?: PauseReason | null,
): StatusPresentation {
  // The casts are safe: `kind` and `value` are correlated through StatusKindMap.
  const k: StatusKind = kind;
  switch (k) {
    case 'run':
      return runPresentation(value as RunStatus, pauseReason);
    case 'pause':
      return PAUSE[value as PauseReason];
    case 'step':
      return STEP[value as StepState];
    case 'attempt':
      return ATTEMPT[value as AttemptState];
    case 'memory':
      return MEMORY[value as MemoryStatus];
    case 'certainty':
      return CERTAINTY[value as CostCertainty];
    default:
      return assertNever(k);
  }
}
