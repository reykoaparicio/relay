// 06 F3: step state machine — pure transition table + a repo-bound applier (CAS + step.state_changed event).
// `validating` is in-memory only (R4-25): no transition targets it, so no DB row is ever in `validating`.
import { invariant } from '@relay/contracts';
import type { StepState } from '@relay/contracts';
import type { Repos, StepRow, StepTransitionFields } from '@relay/storage';
import type { PostCommitEffect } from './run-machine.js';
import { appendRunEvent } from './run-machine.js';

/** Every event that can move a step (F3 table). */
export const STEP_EVENTS = [
  'DEPS_MET',
  'RESERVED',
  'APPROVAL_OPENED',
  'LOCAL_STEP_DONE',
  'DISPATCHING',
  'RESERVATION_RELEASED',
  'SETTLED_VALID',
  'NOT_SENT',
  'SETTLED_RETRY',
  'SETTLED_FAILED',
  'OUTCOME_UNKNOWN',
  'USER_RETRY',
  'USER_ABANDON',
  'RECONCILED_VALID',
  'RECONCILED_RETRY',
  'RECONCILED_FAILED',
  'DECIDED_APPROVED',
  'DECIDED_REVISION',
  'DECIDED_REJECTED',
  'RUN_CANCELLED',
] as const;
/** Step event. */
export type StepEvent = (typeof STEP_EVENTS)[number];

/** Terminal step states are immutable; a retry is always a new row (R4-20). */
const TERMINAL_STEP_STATES: readonly StepState[] = ['succeeded', 'failed', 'skipped'];

/** True for succeeded / failed / skipped. */
export function isTerminalStep(s: StepState): boolean {
  return TERMINAL_STEP_STATES.includes(s);
}

const TABLE: Readonly<Partial<Record<StepState, Partial<Record<StepEvent, StepState>>>>> = {
  pending: { DEPS_MET: 'ready' },
  ready: { RESERVED: 'reserved', APPROVAL_OPENED: 'awaiting_approval', LOCAL_STEP_DONE: 'succeeded' },
  reserved: { DISPATCHING: 'executing', RESERVATION_RELEASED: 'ready' },
  executing: {
    SETTLED_VALID: 'succeeded',
    NOT_SENT: 'ready',
    SETTLED_RETRY: 'ready',
    SETTLED_FAILED: 'failed',
    OUTCOME_UNKNOWN: 'unknown',
  },
  unknown: {
    USER_RETRY: 'ready',
    USER_ABANDON: 'failed',
    RECONCILED_VALID: 'succeeded',
    RECONCILED_RETRY: 'ready',
    RECONCILED_FAILED: 'failed',
  },
  awaiting_approval: { DECIDED_APPROVED: 'succeeded', DECIDED_REVISION: 'failed', DECIDED_REJECTED: 'failed' },
};

/** Pure F3 transition. `RUN_CANCELLED` moves any non-terminal step to `skipped`. */
export function transitionStep(state: StepState, ev: StepEvent): { readonly to: StepState } | { readonly error: 'ILLEGAL' } {
  if (ev === 'RUN_CANCELLED') return isTerminalStep(state) ? { error: 'ILLEGAL' } : { to: 'skipped' };
  const next = TABLE[state]?.[ev];
  return next === undefined ? { error: 'ILLEGAL' } : { to: next };
}

/**
 * Applies a step event inside the caller's tx: CAS from `step.state`, then `step.state_changed`.
 * Returns false when the CAS lost (a concurrent path moved the step).
 * @throws Error (invariant) on an ILLEGAL transition — a caller bug.
 */
export function applyStepEvent(
  r: Repos,
  fx: PostCommitEffect[],
  step: StepRow,
  ev: StepEvent,
  fields: StepTransitionFields = {},
): boolean {
  const t = transitionStep(step.state, ev);
  invariant(!('error' in t), `illegal step transition ${step.state} + ${ev}`);
  if (!r.steps.transition(step.id, [step.state], t.to, fields)) return false;
  appendRunEvent(r, fx, step.runId, 'step.state_changed', {
    stepRunId: step.id,
    stepKey: step.stepKey,
    from: step.state,
    to: t.to,
    trigger: ev,
  });
  return true;
}

/** Moves every non-terminal step row of the run to `skipped` (cancel / stop, F11). Returns how many moved. */
export function skipOpenSteps(r: Repos, fx: PostCommitEffect[], runId: StepRow['runId']): number {
  let n = 0;
  for (const s of r.steps.listForRun(runId)) {
    if (!isTerminalStep(s.state) && applyStepEvent(r, fx, s, 'RUN_CANCELLED')) n += 1;
  }
  return n;
}
