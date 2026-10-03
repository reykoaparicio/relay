// 06 F2: run state machine — pure core (transitionRun, allowedRunActions) + the ONLY writer of runs.status
// (applyRunEvent), plus post-commit effects that run only after the transaction commits.
import { appError, invariant, isTerminalRunStatus, redactDeep } from '@relay/contracts';
import type {
  AppError,
  ApprovalId,
  AttemptId,
  EpochMs,
  PauseReason,
  PushEvent,
  RunAction,
  RunEvent,
  RunEventType,
  RunId,
  RunStatus,
} from '@relay/contracts';
import type { DeferredPause, Repos, RunRow } from '@relay/storage';
import { logSafe } from './log-safe.js';
import type { EngineCtx } from './ports.js';
import { closeSegment, segmentEndAt } from './segments.js';

/** Every event that can move a run (F2). */
export type RunMachineEvent =
  | { readonly type: 'CHECKS_PASSED' }
  | {
      readonly type: 'SETUP_BLOCKED';
      readonly reason: 'setup_blocked' | 'auth_required' | 'budget_run' | 'budget_project';
      readonly error: AppError;
    }
  | { readonly type: 'PLAN_READY'; readonly approvalId: ApprovalId }
  /** Decision 2: `resume` of a run the user paused while it waited for approval: back to awaiting_approval. */
  | { readonly type: 'APPROVAL_RESUMED' }
  | { readonly type: 'APPROVED_MATCHING' }
  | { readonly type: 'REJECTED' }
  | { readonly type: 'REVISION_REQUESTED' }
  | { readonly type: 'BUDGET_BLOCKED'; readonly scope: 'run' | 'project'; readonly error: AppError }
  /** `attemptId` is the overrunning attempt (absent only for a deferred pause whose stored detail lacks it). */
  | { readonly type: 'BUDGET_OVERRUN'; readonly attemptId?: AttemptId | undefined; readonly error: AppError }
  | { readonly type: 'USER_PAUSE' }
  | { readonly type: 'AUTH_FAILED'; readonly error: AppError }
  | { readonly type: 'RATE_LIMIT_EXHAUSTED'; readonly error: AppError }
  | { readonly type: 'APPROVAL_STALE'; readonly error: AppError }
  | { readonly type: 'LIMIT_REACHED'; readonly reason: 'limit_attempts' | 'deadline'; readonly error: AppError }
  | { readonly type: 'OUTPUT_INVALID_EXHAUSTED'; readonly error: AppError }
  | { readonly type: 'TRANSPORT_EXHAUSTED'; readonly error: AppError }
  | { readonly type: 'MODEL_REFUSED'; readonly error: AppError }
  | { readonly type: 'UNKNOWN_OUTCOME'; readonly attemptId: AttemptId; readonly error: AppError }
  /** `lastAliveAt`: the runner's last sign of life (B1); the open running segment is closed there, never at `now`. */
  | { readonly type: 'RUNNER_LOST'; readonly lastAliveAt?: EpochMs | undefined }
  | { readonly type: 'UNRECOVERABLE'; readonly error: AppError }
  | { readonly type: 'ACCEPTED' }
  | {
      readonly type: 'REVISION_LIMIT';
      readonly cause: 'revision_limit' | 'verifier_incomplete';
      readonly revisionCycle?: number | undefined;
      readonly maxRevisionCycles?: number | undefined;
    }
  | { readonly type: 'CANCEL_REQUESTED' }
  | { readonly type: 'STOP_REQUESTED' }
  | { readonly type: 'WORK_STOPPED' }
  | { readonly type: 'RESUME_RESOLVED' }
  | { readonly type: 'RECOVERY_DECIDED' };

/** Event type names (for generated test matrices). */
export type RunMachineEventType = RunMachineEvent['type'];

/** A legal transition, or ILLEGAL. */
type RunTransition = { readonly to: RunStatus; readonly pauseReason: PauseReason | null } | { readonly error: 'ILLEGAL' };

const ILLEGAL = { error: 'ILLEGAL' } as const;
const to = (status: RunStatus): RunTransition => ({ to: status, pauseReason: null });
const paused = (reason: PauseReason): RunTransition => ({ to: 'paused', pauseReason: reason });

type Rule = (ev: RunMachineEvent) => RunTransition;
type Rules = Readonly<Partial<Record<RunMachineEventType, Rule>>>;

const always = (t: RunTransition): Rule => () => t;

/** running → paused reasons caused by an attempt outcome or a policy check (clarification 8). */
const RUNNING_PAUSES: Rules = {
  SETUP_BLOCKED: (ev) =>
    ev.type === 'SETUP_BLOCKED' && (ev.reason === 'setup_blocked' || ev.reason === 'auth_required') ? paused(ev.reason) : ILLEGAL,
  BUDGET_BLOCKED: (ev) => paused(ev.type === 'BUDGET_BLOCKED' && ev.scope === 'project' ? 'budget_project' : 'budget_run'),
  BUDGET_OVERRUN: always(paused('budget_overrun')),
  USER_PAUSE: always(paused('user')), // takes effect before the next dispatch; the in-flight call completes
  AUTH_FAILED: always(paused('auth_required')),
  RATE_LIMIT_EXHAUSTED: always(paused('rate_limited')),
  APPROVAL_STALE: always(paused('approval_stale')),
  LIMIT_REACHED: (ev) => paused(ev.type === 'LIMIT_REACHED' && ev.reason === 'deadline' ? 'deadline' : 'limit_attempts'),
  OUTPUT_INVALID_EXHAUSTED: always(paused('output_invalid')),
  TRANSPORT_EXHAUSTED: always(paused('provider_unavailable')),
  MODEL_REFUSED: always(paused('model_refused')),
  UNKNOWN_OUTCOME: always(paused('unknown_outcome')),
};

const STOP_RULES: Rules = { CANCEL_REQUESTED: always(to('cancelled')), STOP_REQUESTED: always(to('cancelled')) }; // clarifications 5, 6

/** The F2 transition table. Every (status, event) pair not listed is ILLEGAL. */
const TABLE: Readonly<Record<RunStatus, Rules>> = {
  queued: {
    CHECKS_PASSED: always(to('running')),
    USER_PAUSE: always(paused('user')), // decision 2: nothing in flight, pauses at once
    SETUP_BLOCKED: (ev) => (ev.type === 'SETUP_BLOCKED' ? paused(ev.reason) : ILLEGAL), // clarification 9
    CANCEL_REQUESTED: always(to('cancelled')), // clarification 1: nothing in flight
    // Clarification 14: a pause deferred while the run waited in the queue is applied instead of CHECKS_PASSED.
    BUDGET_OVERRUN: always(paused('budget_overrun')),
    APPROVAL_STALE: always(paused('approval_stale')),
  },
  running: {
    ...RUNNING_PAUSES,
    PLAN_READY: always(to('awaiting_approval')),
    RUNNER_LOST: always(to('interrupted')),
    UNRECOVERABLE: always(to('failed')), // clarification 10: the ONLY way to `failed` (R3-1)
    ACCEPTED: always(to('completed')),
    REVISION_LIMIT: always(to('incomplete')), // clarification 11 (revision_limit | verifier_incomplete)
    CANCEL_REQUESTED: always(to('cancelling')),
  },
  awaiting_approval: {
    // Ruling B2: a decision re-queues the run; the loop's CHECKS_PASSED moves it to running once it is the next
    // eligible run, so a decision can never create a second running run (§9.1 concurrency 1). Clarification 2.
    APPROVED_MATCHING: always(to('queued')),
    REVISION_REQUESTED: always(to('queued')),
    REJECTED: always(to('cancelled')),
    APPROVAL_STALE: always(paused('approval_stale')), // clarification 3
    CANCEL_REQUESTED: always(to('cancelled')), // clarification 4
    USER_PAUSE: always(paused('user')), // decision 2: the pending approval stays pending
  },
  paused: {
    ...STOP_RULES,
    RESUME_RESOLVED: always(to('queued')), // clarification 12
    APPROVAL_RESUMED: always(to('awaiting_approval')), // decision 2: resume of paused(user) with an approval pending
    // E1 #1: a budget re-check (allowance increase, project allowance edit) that now fails at the OTHER scope moves the
    // run to the pause of the scope that failed, so the offered action is the one that can unblock it.
    BUDGET_BLOCKED: (ev) => paused(ev.type === 'BUDGET_BLOCKED' && ev.scope === 'project' ? 'budget_project' : 'budget_run'),
    // Clarification 14 (BH-2/BH-6): once the last unknown attempt of a paused(unknown_outcome) run is resolved, a
    // reconciled overrun or scope change re-pauses it with that reason instead of resuming (never auto-resumed).
    BUDGET_OVERRUN: always(paused('budget_overrun')),
    APPROVAL_STALE: always(paused('approval_stale')),
  },
  interrupted: {
    ...STOP_RULES,
    RECOVERY_DECIDED: always(to('queued')), // clarification 13
    // Clarification 14 for interrupted runs: review_recovery applies a pause a reconciled outcome deferred (overrun,
    // scope change) instead of RECOVERY_DECIDED — an overrun still needs acknowledge_overrun, exactly like a live run.
    BUDGET_OVERRUN: always(paused('budget_overrun')),
    APPROVAL_STALE: always(paused('approval_stale')),
  },
  cancelling: { WORK_STOPPED: always(to('cancelled')), RUNNER_LOST: always(to('cancelled')) }, // clarification 7
  cancelled: {},
  completed: {},
  incomplete: {},
  failed: {},
};

/** Pure §7.2 transition function (with the F2 clarifications). Every pair not in the F2 table is ILLEGAL. */
export function transitionRun(status: RunStatus, ev: RunMachineEvent): RunTransition {
  const rule = TABLE[status][ev.type];
  return rule === undefined ? ILLEGAL : rule(ev);
}

/** Facts `allowedRunActions` needs beyond the run row. */
export interface RunActionFacts {
  /** Legacy unknown liabilities still open (0 for data since decision 1); informational, never offers an action. */
  readonly unknownAttempts: number;
  readonly hasFailedStep: boolean;
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

/**
 * Server-computed actions (`RunDetail.availableActions`); the UI renders only these (F2 truth table), and every
 * decision op (`runs.resume`, `runs.retryStep`, …) refuses an action not listed here for the run's current state
 * (CONFLICT `decision_not_applicable`), so the UI and the server can never disagree. Decision 1: `decide_unknown` is
 * never offered (an uncertain outcome is settled as an estimate at once). Decision 2: `pause` is offered while the run
 * is queued, running or awaiting approval, and `export_report` (+ `export_patch` once a patch exists) in EVERY state —
 * a non-terminal run exports an interim report of what finished so far.
 */
export function allowedRunActions(run: Pick<RunRow, 'status' | 'pauseReason'>, f: RunActionFacts): RunAction[] {
  const actions = actionsFor(run, f);
  const exports: RunAction[] = f.hasPatchArtifact ? ['export_report', 'export_patch'] : ['export_report'];
  return [...(f.hasProfileOptions === false ? actions.filter((a) => a !== 'choose_profile') : actions), ...exports];
}

function actionsFor(run: Pick<RunRow, 'status' | 'pauseReason'>, f: RunActionFacts): RunAction[] {
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

// ---------------------------------------------------------------- effects

/** Work that must run only after the surrounding transaction commits. */
export type PostCommitEffect =
  | { readonly kind: 'emit'; readonly event: PushEvent }
  | { readonly kind: 'wake' }
  | { readonly kind: 'arm_deadline'; readonly runId: RunId }
  | { readonly kind: 'disarm_deadline'; readonly runId: RunId }
  | { readonly kind: 'terminal'; readonly runId: RunId };

/** The slice of the engine context effects need. */
type EffectsCtx = Pick<EngineCtx, 'emit' | 'wake' | 'deadlines' | 'onTerminal' | 'logger'>;

/** Runs post-commit effects in order. A failing effect is logged and never undoes the committed state. */
export async function runEffects(ctx: EffectsCtx, fx: readonly PostCommitEffect[]): Promise<void> {
  for (const e of fx) {
    try {
      switch (e.kind) {
        case 'emit':
          ctx.emit(e.event);
          break;
        case 'wake':
          ctx.wake.signal();
          break;
        case 'arm_deadline':
          ctx.deadlines.arm(e.runId);
          break;
        case 'disarm_deadline':
          ctx.deadlines.disarm(e.runId);
          break;
        case 'terminal':
          await ctx.onTerminal(e.runId);
          break;
      }
    } catch (err) {
      ctx.logger.error('effect.failed', { kind: e.kind, err: logSafe(err) });
    }
  }
}

/** Appends a redacted run event inside the caller's tx and queues its push (post-commit). */
export function appendRunEvent(
  r: Repos,
  fx: PostCommitEffect[],
  runId: RunId,
  type: RunEventType,
  payload: Readonly<Record<string, unknown>>,
): RunEvent {
  const event = r.events.append(runId, type, redactDeep({ ...payload }));
  fx.push({ kind: 'emit', event: { type: 'run.event', event } });
  return event;
}

/**
 * F12/B1: where a running segment closes — the last sign of life for RUNNER_LOST (downtime never counts), else the
 * segment's monotonic end (E1: a sleep or a wall-clock jump is never charged), which is `now` without a monotonic clock.
 */
function leaveRunningAt(run: RunRow, ev: RunMachineEvent, now: EpochMs): EpochMs {
  return ev.type === 'RUNNER_LOST' && ev.lastAliveAt !== undefined && ev.lastAliveAt < now ? ev.lastAliveAt : segmentEndAt(run, now);
}

/**
 * Why a run ended `incomplete` (the inspector must not claim "revision limit reached" for a verifier verdict):
 * `details.incompleteCause` (+ the cycle counts for the limit case).
 */
function incompleteDetail(ev: Extract<RunMachineEvent, { type: 'REVISION_LIMIT' }>): AppError {
  const cycles = ev.cause === 'revision_limit' ? { revisionCycle: ev.revisionCycle ?? null, maxRevisionCycles: ev.maxRevisionCycles ?? null } : {};
  return appError('LIMIT_REACHED', {
    userMessage: ev.cause === 'revision_limit'
      ? 'The reviewer still requested changes when the revision limit was reached.'
      : 'The verifier marked the work incomplete.',
    details: { limit: 'revisions', incompleteCause: ev.cause, ...cycles },
  });
}

function statusDetailOf(ev: RunMachineEvent): AppError | null {
  if (ev.type === 'REVISION_LIMIT') return incompleteDetail(ev);
  return 'error' in ev ? ev.error : null;
}

/** The run event that applies a stored deferred pause (clarification 14). */
export function deferredPauseEvent(p: DeferredPause): RunMachineEvent {
  return p.reason === 'budget_overrun' ? { type: 'BUDGET_OVERRUN', attemptId: p.detail.attemptId, error: p.detail } : { type: 'APPROVAL_STALE', error: p.detail };
}

/** Events that let a blocked or queued run continue toward `running`. */
const CONTINUES: ReadonlySet<RunMachineEventType> = new Set(['RESUME_RESOLVED', 'RECOVERY_DECIDED', 'CHECKS_PASSED']);

/**
 * Clarification 14 guard: while the run carries a durable deferred pause, an event that would let it continue is
 * replaced by that pause, whichever path emitted it (a resume decision, retryStep, review_recovery, the auto-resume
 * once unknowns resolve, the loop's CHECKS_PASSED). The user resolving THAT pause (e.g. acknowledge_overrun or an
 * allowance increase from `paused(budget_overrun)`) is the only way it is cleared.
 */
function effectiveEvent(run: RunRow, ev: RunMachineEvent): { readonly ev: RunMachineEvent; readonly clearDeferred: boolean } {
  const deferred = run.deferredPause;
  if (deferred === null || !CONTINUES.has(ev.type)) return { ev, clearDeferred: false };
  // The user resolved exactly this pause: it is cleared together with the transition.
  if (run.status === 'paused' && run.pauseReason === deferred.reason) return { ev, clearDeferred: true };
  return { ev: deferredPauseEvent(deferred), clearDeferred: false };
}

/**
 * The ONLY code that writes `runs.status` (call inside a db.tx). CAS from `run.status`; returns false when the CAS
 * lost (the caller re-reads). Also accrues execution time (F12), clears `pause_requested`, appends
 * `run.status_changed`, and queues post-commit effects. A durable deferred pause replaces any continuing event
 * ({@link effectiveEvent}, clarification 14).
 * @throws Error (invariant) when the transition is ILLEGAL — a caller bug.
 */
export function applyRunEvent(r: Repos, run: RunRow, requested: RunMachineEvent, now: EpochMs, fx: PostCommitEffect[]): boolean {
  const { ev, clearDeferred } = effectiveEvent(run, requested);
  const t = transitionRun(run.status, ev);
  invariant(!('error' in t), `illegal run transition ${run.status} + ${ev.type}`);
  if (t.to === 'running') {
    // §9.1 concurrency 1 (B2 guard): nothing moves a run to running while another run is running or cancelling.
    const other = r.runs.listActive().find((x) => x.id !== run.id && (x.status === 'running' || x.status === 'cancelling'));
    invariant(other === undefined, `run ${run.id} cannot enter running while ${other?.id ?? ''} is ${other?.status ?? ''}`);
  }
  const changed = r.runs.updateStatus(run.id, [run.status], t.to, {
    pauseReason: t.pauseReason,
    statusDetail: statusDetailOf(ev),
    ...(t.to === 'running' && run.startedAt === null ? { startedAt: now } : {}),
  });
  if (!changed) return false;
  if (clearDeferred) r.runs.setDeferredPause(run.id, null);
  if (t.to === 'running') r.runs.enterRunning(run.id, now);
  if (run.status === 'running' && t.to !== 'running') {
    r.runs.leaveRunning(run.id, leaveRunningAt(run, ev, now));
    closeSegment(run.id);
  }
  const terminal = isTerminalRunStatus(t.to);
  if (ev.type === 'USER_PAUSE' || ev.type === 'RESUME_RESOLVED' || ev.type === 'APPROVAL_RESUMED' || terminal) r.runs.setPauseRequested(run.id, false);
  const detail = statusDetailOf(ev);
  const event = appendRunEvent(r, fx, run.id, 'run.status_changed', {
    from: run.status,
    to: t.to,
    pauseReason: t.pauseReason,
    trigger: ev.type,
    ...(detail === null ? {} : { code: detail.code }),
    ...(ev.type === 'REVISION_LIMIT' ? { ...incompleteDetail(ev).details } : {}),
  });
  fx.push({ kind: 'emit', event: { type: 'run.status', runId: run.id, status: t.to, pauseReason: t.pauseReason, seq: event.seq } });
  if (t.to === 'running') fx.push({ kind: 'arm_deadline', runId: run.id });
  if (run.status === 'running' && t.to !== 'running') fx.push({ kind: 'disarm_deadline', runId: run.id });
  if (terminal) fx.push({ kind: 'terminal', runId: run.id });
  fx.push({ kind: 'wake' });
  return true;
}
