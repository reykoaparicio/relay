// The fake bridge's view of the 06 F2 `allowedRunActions` truth table, so paused scenarios expose the same
// `availableActions` the engine computes. U-4: the table itself lives in @relay/contracts and is shared with the
// engine (no mirror to drift); this only maps the fake's facts. Pages never call this: they render
// `RunDetail.availableActions`.
import { allowedRunActions as f2Actions } from '@relay/contracts';
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
  /**
   * Engine `hasRetryableStep`: the latest row of some step is failed or unknown. False → `paused(unknown_outcome)`
   * offers `resume` instead of `retry_step` (nothing is left to retry). Absent = true.
   */
  readonly hasRetryableStep?: boolean;
}

/** 06 F2 truth table (the shared contracts `allowedRunActions`, incl. the E1 #4/#8 changes). */
export function allowedRunActions(
  status: RunStatus,
  pauseReason: PauseReason | null,
  ctx: AllowedActionsContext,
): RunAction[] {
  return f2Actions(
    { status, pauseReason },
    {
      // Uncertain attempts are settled estimates, never open liabilities (decision 1): informational only.
      unknownAttempts: 0,
      hasFailedStep: ctx.hasFailedStep,
      hasPatchArtifact: ctx.hasPatchArtifact,
      missingCredential: ctx.missingCredential,
      preservableSnapshot: ctx.preservableSnapshot,
      hasProfileOptions: ctx.hasProfileOptions,
      hasRetryableStep: ctx.hasRetryableStep,
    },
  );
}
