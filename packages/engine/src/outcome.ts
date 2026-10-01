// 06 F4 step 7 + F9b: the ONE post-validation outcome function shared by the live settle (checkpoints.ts) and the
// reconcile path (recovery.ts), so both apply the same F7 plan, the same F10 approval-scope rule, the same revision
// trigger, and the same §9.5 overrun rule (BH-6). Runs inside the caller's settlement transaction.
import type { ArtifactId, AttemptId, AttemptPurpose, EpochMs, Microusd, RetryPolicy } from '@relay/contracts';
import type { Repos, StepRow } from '@relay/storage';
import { invalidateApproval } from './approval-binding.js';
import type { SettleAmount } from './budget.js';
import { isOverrun } from './budget.js';
import type { EngineCtx } from './ports.js';
import type { AttemptPlan, ClassifiedOutcome } from './retry.js';
import { nextAttemptPlan, runEventFor } from './retry.js';
import { planRevision } from './revision.js';
import type { PostCommitEffect, RunMachineEvent } from './run-machine.js';
import { appendRunEvent } from './run-machine.js';
import type { StepEvent } from './step-machine.js';
import { applyStepEvent } from './step-machine.js';

/** The step's `outcome` label of a valid output (e.g. a review verdict), or null. */
export function outcomeLabel(value: unknown): string | null {
  const o = (value as { outcome?: unknown } | null)?.outcome;
  return typeof o === 'string' ? o : null;
}

/** Where the outcome comes from: the live step-7 settle (step `executing`) or F9b reconcile (step `unknown`). */
export type OutcomeSource = 'live' | 'reconcile';

/** Inputs of {@link applyPostValidation}. */
export interface PostValidationInput {
  readonly source: OutcomeSource;
  readonly stepRunId: StepRow['id'];
  readonly runId: StepRow['runId'];
  readonly attemptId: AttemptId;
  readonly outcome: ClassifiedOutcome;
  readonly policy: RetryPolicy;
  /** Purpose of the settled attempt (a rate-limit retry keeps it). */
  readonly purpose: AttemptPurpose;
  readonly output: { readonly id: ArtifactId; readonly value: unknown } | null;
  /** The settled cost X and the amount it is compared with (the reservation N live, the unknown liability on reconcile). */
  readonly cost: SettleAmount;
  readonly N: Microusd;
  readonly now: EpochMs;
}

/** Step events per plan kind for each source (a reconcile never releases or goes unknown again). */
const STEP_EVENTS: Readonly<Record<OutcomeSource, Readonly<Record<AttemptPlan['kind'], StepEvent | null>>>> = {
  live: { succeed: 'SETTLED_VALID', release: 'NOT_SENT', retry: 'SETTLED_RETRY', hold: 'SETTLED_RETRY', fail: 'SETTLED_FAILED', unknown: 'OUTCOME_UNKNOWN' },
  reconcile: { succeed: 'RECONCILED_VALID', release: null, retry: 'RECONCILED_RETRY', hold: 'RECONCILED_RETRY', fail: 'RECONCILED_FAILED', unknown: null },
};

const FROM_STATE: Readonly<Record<OutcomeSource, StepRow['state']>> = { live: 'executing', reconcile: 'unknown' };

/** Moves the step per the F7 plan (only from `executing` live / `unknown` on reconcile; else untouched). */
function moveStep(r: Repos, fx: PostCommitEffect[], s: StepRow, source: OutcomeSource, plan: AttemptPlan, output: PostValidationInput['output']): void {
  const ev = STEP_EVENTS[source][plan.kind];
  if (ev === null || s.state !== FROM_STATE[source]) return;
  switch (plan.kind) {
    case 'succeed':
      applyStepEvent(r, fx, s, ev, { outputArtifactId: output?.id ?? null, outcome: outcomeLabel(output?.value ?? null), error: null, notBeforeAt: null });
      return;
    case 'retry': {
      const counter =
        plan.counter === 'transport'
          ? { transportRetriesUsed: s.transportRetriesUsed + 1 }
          : plan.counter === 'schema_repair'
            ? { schemaRepairsUsed: s.schemaRepairsUsed + 1 }
            : { rateLimitWaitsUsed: s.rateLimitWaitsUsed + 1 };
      applyStepEvent(r, fx, s, ev, { ...counter, notBeforeAt: plan.notBeforeAt });
      return;
    }
    case 'hold':
    case 'fail':
    case 'unknown':
      applyStepEvent(r, fx, s, ev, { error: plan.error });
      return;
    case 'release':
      applyStepEvent(r, fx, s, ev);
      return;
  }
}

/**
 * Applies a validated attempt outcome inside the caller's tx: the F7 step move, the F10 scope rule (APPROVAL_STALE
 * `scope_changed` → the approval is invalidated), the revision trigger on success, and the `ledger.overrun` record.
 * Returns the plan and the run event the outcome causes (BUDGET_OVERRUN takes precedence, §9.5); the CALLER applies
 * it — live from `running`, reconcile through {@link deferPause} / `resumeIfUnknownsResolved`.
 */
export function applyPostValidation(
  r: Repos,
  fx: PostCommitEffect[],
  ctx: Pick<EngineCtx, 'ids'>,
  i: PostValidationInput,
): { readonly plan: AttemptPlan; readonly event: RunMachineEvent | null } {
  const s = r.steps.get(i.stepRunId);
  const plan = nextAttemptPlan(s, i.outcome, i.policy, i.now, i.purpose);
  moveStep(r, fx, s, i.source, plan, i.output);
  if (i.outcome.kind === 'scope_changed') {
    // F10 approval reuse rule: a quality revision outside the approved scope needs a new approval.
    const approval = r.approvals.latestApprovedForRun(i.runId);
    if (approval !== undefined) invalidateApproval(r, fx, i.runId, approval.id, 'scope_changed', i.now);
  }
  if (plan.kind === 'succeed') planRevision(r, fx, ctx, r.steps.get(i.stepRunId), i.now); // F10: verify `revise` → next cycle
  if (isOverrun(i.cost, i.N)) {
    appendRunEvent(r, fx, i.runId, 'ledger.overrun', { attemptId: i.attemptId, stepRunId: i.stepRunId, N: i.N, X: i.cost.kind === 'known' ? i.cost.microusd : i.N });
  }
  return { plan, event: runEventFor(i.outcome, plan, i.cost, i.N, i.attemptId) };
}

/** Event payload marker of the audit event a deferred pause appends (`error.recorded { kind }`). */
export const DEFERRED_PAUSE_MARK = 'deferred_pause';

type DeferrableEvent = Extract<RunMachineEvent, { type: 'BUDGET_OVERRUN' | 'APPROVAL_STALE' }>;

/** Run events a reconciled outcome turns into a pause of its own (never auto-resumed): overrun and scope change. */
export function isDeferrablePause(ev: RunMachineEvent | null): ev is DeferrableEvent {
  return ev?.type === 'BUDGET_OVERRUN' || ev?.type === 'APPROVAL_STALE';
}

/**
 * Records a pause a reconciled outcome requires while the run is not `running` (06 F2 clarification 14): DURABLY on
 * the run row (`runs.deferred_pause`), plus an `error.recorded { kind: deferred_pause }` audit event. An overrun wins
 * over a scope change (§9.5 precedence, as live) and is never replaced by one. `applyRunEvent` applies the stored
 * pause INSTEAD of any event that would let the run continue (RESUME_RESOLVED, RECOVERY_DECIDED, CHECKS_PASSED), so
 * no resume path can bypass it; only the user's resolution of that very pause clears it (BH-2, BH-6).
 */
export function deferPause(r: Repos, fx: PostCommitEffect[], runId: StepRow['runId'], ev: DeferrableEvent): void {
  const reason = ev.type === 'BUDGET_OVERRUN' ? 'budget_overrun' : 'approval_stale';
  const cur = r.runs.get(runId).deferredPause;
  if (cur?.reason !== 'budget_overrun') r.runs.setDeferredPause(runId, { reason, detail: ev.error });
  appendRunEvent(r, fx, runId, 'error.recorded', {
    kind: DEFERRED_PAUSE_MARK, event: ev.type, code: ev.error.code, error: ev.error, ...(ev.type === 'BUDGET_OVERRUN' ? { attemptId: ev.attemptId } : {}),
  });
}
