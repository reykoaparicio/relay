// 06 F2: run state machine — pure core (transitionRun, allowedRunActions) + the ONLY writer of runs.status
// (applyRunEvent), plus post-commit effects that run only after the transaction commits.
import { invariant, isTerminalRunStatus, redactDeep } from '@relay/contracts';
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
import type { Repos, RunRow } from '@relay/storage';
import { logSafe } from './log-safe.js';
import type { EngineCtx } from './ports.js';

/** Every event that can move a run (F2). */
export type RunMachineEvent =
  | { readonly type: 'CHECKS_PASSED' }
  | {
      readonly type: 'SETUP_BLOCKED';
      readonly reason: 'setup_blocked' | 'auth_required' | 'budget_run' | 'budget_project';
      readonly error: AppError;
    }
  | { readonly type: 'PLAN_READY'; readonly approvalId: ApprovalId }
  | { readonly type: 'APPROVED_MATCHING' }
  | { readonly type: 'REJECTED' }
  | { readonly type: 'REVISION_REQUESTED' }
  | { readonly type: 'BUDGET_BLOCKED'; readonly scope: 'run' | 'project'; readonly error: AppError }
  | { readonly type: 'BUDGET_OVERRUN'; readonly attemptId: AttemptId; readonly error: AppError }
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
  | { readonly type: 'REVISION_LIMIT'; readonly cause: 'revision_limit' | 'verifier_incomplete' }
  | { readonly type: 'CANCEL_REQUESTED' }
  | { readonly type: 'STOP_REQUESTED' }
  | { readonly type: 'WORK_STOPPED' }
  | { readonly type: 'RESUME_RESOLVED' }
  | { readonly type: 'RECOVERY_DECIDED' };

/** Event type names (for generated test matrices). */
export type RunMachineEventType = RunMachineEvent['type'];

/** A legal transition, or ILLEGAL. */
export type RunTransition = { readonly to: RunStatus; readonly pauseReason: PauseReason | null } | { readonly error: 'ILLEGAL' };

const ILLEGAL = { error: 'ILLEGAL' } as const;
const to = (status: RunStatus): RunTransition => ({ to: status, pauseReason: null });
const paused = (reason: PauseReason): RunTransition => ({ to: 'paused', pauseReason: reason });

/** True for completed / incomplete / cancelled / failed. */
export const isTerminal = (s: RunStatus): boolean => isTerminalRunStatus(s);

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
    SETUP_BLOCKED: (ev) => (ev.type === 'SETUP_BLOCKED' ? paused(ev.reason) : ILLEGAL), // clarification 9
    CANCEL_REQUESTED: always(to('cancelled')), // clarification 1: nothing in flight
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
  },
  paused: { ...STOP_RULES, RESUME_RESOLVED: always(to('queued')) }, // clarification 12
  interrupted: { ...STOP_RULES, RECOVERY_DECIDED: always(to('queued')) }, // clarification 13
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
  readonly unknownAttempts: number;
  readonly hasFailedStep: boolean;
  readonly hasPatchArtifact: boolean;
}

function pausedActions(reason: PauseReason, f: RunActionFacts): RunAction[] {
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
      if (f.unknownAttempts > 0) return ['decide_unknown', 'stop'];
      return f.hasFailedStep ? ['retry_step', 'choose_profile', 'stop'] : ['stop'];
    case 'auth_required':
      return ['reconnect_provider', 'resume', 'stop'];
    case 'user':
    case 'rate_limited':
      return ['resume', 'stop'];
    case 'approval_stale':
      return ['resnapshot_and_replan', 'use_preserved_snapshot', 'stop'];
  }
}

/** Server-computed actions (`RunDetail.availableActions`); the UI renders only these (F2 truth table). */
export function allowedRunActions(run: Pick<RunRow, 'status' | 'pauseReason'>, f: RunActionFacts): RunAction[] {
  switch (run.status) {
    case 'queued':
      return ['cancel'];
    case 'running':
      return ['pause', 'cancel'];
    case 'awaiting_approval':
      return ['approve', 'request_revision', 'reject', 'cancel'];
    case 'paused':
      return run.pauseReason === null ? ['stop'] : pausedActions(run.pauseReason, f);
    case 'interrupted':
      return f.unknownAttempts > 0 ? ['review_recovery', 'decide_unknown', 'stop'] : ['review_recovery', 'stop'];
    case 'cancelling':
      return [];
    case 'completed':
    case 'incomplete':
    case 'cancelled':
    case 'failed':
      return f.hasPatchArtifact ? ['export_report', 'export_patch'] : ['export_report'];
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
export type EffectsCtx = Pick<EngineCtx, 'emit' | 'wake' | 'deadlines' | 'onTerminal' | 'logger'>;

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

/** F12/B1: where a running segment closes — the last sign of life for RUNNER_LOST (downtime never counts), else now. */
function leaveRunningAt(ev: RunMachineEvent, now: EpochMs): EpochMs {
  return ev.type === 'RUNNER_LOST' && ev.lastAliveAt !== undefined && ev.lastAliveAt < now ? ev.lastAliveAt : now;
}

function statusDetailOf(ev: RunMachineEvent): AppError | null {
  return 'error' in ev ? ev.error : null;
}

/**
 * The ONLY code that writes `runs.status` (call inside a db.tx). CAS from `run.status`; returns false when the CAS
 * lost (the caller re-reads). Also accrues execution time (F12), clears `pause_requested`, appends
 * `run.status_changed`, and queues post-commit effects.
 * @throws Error (invariant) when the transition is ILLEGAL — a caller bug.
 */
export function applyRunEvent(r: Repos, run: RunRow, ev: RunMachineEvent, now: EpochMs, fx: PostCommitEffect[]): boolean {
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
  if (t.to === 'running') r.runs.enterRunning(run.id, now);
  if (run.status === 'running' && t.to !== 'running') r.runs.leaveRunning(run.id, leaveRunningAt(ev, now));
  const terminal = isTerminal(t.to);
  if (ev.type === 'USER_PAUSE' || ev.type === 'RESUME_RESOLVED' || terminal) r.runs.setPauseRequested(run.id, false);
  const detail = statusDetailOf(ev);
  const event = appendRunEvent(r, fx, run.id, 'run.status_changed', {
    from: run.status,
    to: t.to,
    pauseReason: t.pauseReason,
    trigger: ev.type,
    ...(detail === null ? {} : { code: detail.code }),
  });
  fx.push({ kind: 'emit', event: { type: 'run.status', runId: run.id, status: t.to, pauseReason: t.pauseReason, seq: event.seq } });
  if (t.to === 'running') fx.push({ kind: 'arm_deadline', runId: run.id });
  if (run.status === 'running' && t.to !== 'running') fx.push({ kind: 'disarm_deadline', runId: run.id });
  if (terminal) fx.push({ kind: 'terminal', runId: run.id });
  fx.push({ kind: 'wake' });
  return true;
}
