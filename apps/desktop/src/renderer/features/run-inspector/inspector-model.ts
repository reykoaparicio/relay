// Pure view-model helpers of the run inspector (10 J8). Nothing here decides which actions are allowed: buttons come
// only from `RunDetail.availableActions` (06 F2); these helpers only pick what to show.
import { budgetBreakdownSchema, UNKNOWN_OUTCOME_DECISIONS, validationIssueSchema } from '@relay/contracts';
import type {
  AppError,
  BudgetBreakdown,
  LastShutdown,
  PauseReason,
  ProviderStatus,
  RunAction,
  RunDetail,
  RunEvent,
  RunStatus,
  StepView,
  ValidationIssue,
} from '@relay/contracts';
import { statusPresentation, stepName } from '../../lib/format';
import type { StatusPresentation, UnknownOutcomeDecision } from '../../lib/format';

/** Tabs of the selected step panel (`?tab=`). `budget` / `summary` exist as tabs only below 1280 px. */
export const PRIMARY_TABS = ['output', 'context', 'attempts', 'events', 'ledger'] as const;
export const SECONDARY_TABS = ['budget', 'summary'] as const;
export type PrimaryTab = (typeof PRIMARY_TABS)[number];
export type SecondaryTab = (typeof SECONDARY_TABS)[number];
export type InspectorPanel = PrimaryTab | SecondaryTab;

export function parseInspectorTab(value: string | null): InspectorPanel {
  return (PRIMARY_TABS as readonly string[]).includes(value ?? '') || (SECONDARY_TABS as readonly string[]).includes(value ?? '')
    ? (value as InspectorPanel)
    : 'output';
}

/**
 * A step's title: its display name from the workflow spec (`RunDetail.stepMeta[].name`, E1) when the run carries one,
 * else the shared label source ({@link stepName}), so every view names a step the same way.
 */
export function stepTitle(step: { readonly stepKey: string }, stepMeta?: RunDetail['stepMeta']): string {
  return stepName(step.stepKey, stepMeta);
}

/** The instruction version a model step ran with (`RunDetail.stepMeta`, e.g. "reviewer.v2"); null when not known. */
export function instructionVersionOf(run: Pick<RunDetail, 'stepMeta'>, stepKey: string): string | null {
  return run.stepMeta?.find((m) => m.stepKey === stepKey)?.instructionVersion ?? null;
}

/**
 * The step that was in flight when an interrupted (or unknown-outcome) run stopped: the step of its first unresolved
 * attempt, else the first step left executing / unknown / failed.
 */
export function interruptedStep(run: Pick<RunDetail, 'steps' | 'unresolvedAttempts'>): StepView | undefined {
  const unresolved = run.unresolvedAttempts[0];
  const byAttempt = unresolved === undefined ? undefined : run.steps.find((s) => s.id === unresolved.stepRunId);
  return byAttempt ?? run.steps.find((s) => s.state === 'unknown' || s.state === 'executing' || s.state === 'failed');
}

/**
 * Why an interrupted run stopped, from `AppInfo.lastShutdown` (E2): a clean quit, the runner stopped responding, or
 * not known (no record, older main). The interrupted banners word their cause by it.
 */
export type InterruptionCause = 'quit' | 'runner_stopped' | 'unknown';

export function interruptionCauseOf(
  lastShutdown: LastShutdown | null | undefined,
  interruptedAt: number | null | undefined,
): InterruptionCause {
  if (lastShutdown === null || lastShutdown === undefined) return 'unknown';
  // `lastShutdown` describes only the previous session. AppInfo carries no launch time, so the run's interruption is
  // tied to that session by time: the run became interrupted (recovery after that session) after the session's
  // record. A run interrupted earlier (an older session), or with no interruption event to compare, gets the neutral
  // wording rather than a cause that may belong to another session.
  if (interruptedAt === null || interruptedAt === undefined || interruptedAt <= lastShutdown.at) return 'unknown';
  return lastShutdown.clean ? 'quit' : 'runner_stopped';
}

/** When the run last changed to `status` (its `run.status_changed` event), if the events show it. */
export function statusChangedAtOf(events: readonly RunEvent[], status: RunStatus): number | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type === 'run.status_changed' && (e.payload['to'] ?? e.payload['status']) === status) return e.at;
  }
  return null;
}

/** When the run last changed to `interrupted`, if the events show it. */
export function interruptedAtOf(events: readonly RunEvent[]): number | null {
  return statusChangedAtOf(events, 'interrupted');
}

/** The lead of the cause sentence, to be followed by the step name and " was running". */
export const INTERRUPTION_LEAD: Readonly<Record<InterruptionCause, string>> = {
  quit: 'Relay was closed while ',
  runner_stopped: 'The background runner stopped responding while ',
  unknown: 'Relay stopped while ',
};

/** Only the latest `(revision, retry)` row of each step key is the "live" row (06 F3); older rows are history. */
export function isLatestRow(step: StepView, steps: readonly StepView[]): boolean {
  return !steps.some(
    (s) =>
      s.stepKey === step.stepKey &&
      s.id !== step.id &&
      (s.revisionIndex > step.revisionIndex || (s.revisionIndex === step.revisionIndex && s.retryIndex > step.retryIndex)),
  );
}

/** The latest `(revision, retry)` row of `stepKey` (the one a retry, profile switch, or revision just created). */
export function latestRowOf(steps: readonly StepView[], stepKey: string): StepView | undefined {
  let best: StepView | undefined;
  for (const s of steps) {
    if (s.stepKey !== stepKey) continue;
    if (
      best === undefined ||
      s.revisionIndex > best.revisionIndex ||
      (s.revisionIndex === best.revisionIndex && s.retryIndex > best.retryIndex)
    ) {
      best = s;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Events of one step row

/** The step rows an event names: `payload.stepRunId`, `payload.stepRunIds[]` (revision events), or legacy `stepId`. */
function eventStepRunIds(e: RunEvent): readonly string[] | null {
  const p = e.payload;
  const ids: string[] = [];
  if (typeof p['stepRunId'] === 'string') ids.push(p['stepRunId']);
  if (Array.isArray(p['stepRunIds'])) for (const id of p['stepRunIds']) if (typeof id === 'string') ids.push(id);
  if (typeof p['stepId'] === 'string') ids.push(p['stepId']);
  return ids.length === 0 ? null : ids;
}

export interface StepEvents {
  /** Events whose payload names this exact row (`stepRunId` / `stepRunIds[]`). */
  readonly events: RunEvent[];
  /**
   * Legacy events that name only the step key (no row id): they cannot be attributed to one attempt row, so they
   * are listed apart as run-level events, never mixed into the row's own list.
   */
  readonly runLevel: RunEvent[];
}

/**
 * Events of the selected step row, oldest first. Matching is by row id only (two rows of the same step key — a
 * retry, a profile switch, a revision — never share events); `stepKey` is a fallback only for legacy events that
 * carry no row id at all, and those go to `runLevel`.
 */
export function stepEventsOf(sources: ReadonlyArray<readonly RunEvent[] | undefined>, step: StepView): StepEvents {
  const own = new Map<number, RunEvent>();
  const legacy = new Map<number, RunEvent>();
  for (const list of sources) {
    for (const e of list ?? []) {
      const ids = eventStepRunIds(e);
      if (ids !== null) {
        if (ids.includes(step.id)) own.set(e.seq, e);
      } else if (e.payload['stepKey'] === step.stepKey) {
        legacy.set(e.seq, e);
      }
    }
  }
  const sorted = (m: Map<number, RunEvent>) => [...m.values()].sort((a, b) => a.seq - b.seq);
  return { events: sorted(own), runLevel: sorted(legacy) };
}

// ---------------------------------------------------------------------------------------------------------------
// Why a run ended incomplete

export type IncompleteCause = 'revision_limit' | 'verifier_incomplete';

/**
 * `statusDetail.incompleteCause` (06: `details.incompleteCause`; a top-level field is accepted too). Null when the
 * engine did not say, so the UI never claims "revision limit reached" for a verifier verdict.
 */
export function incompleteCauseOf(run: Pick<RunDetail, 'statusDetail'>): IncompleteCause | null {
  const d = run.statusDetail;
  if (d === null) return null;
  const raw = (d as Readonly<Record<string, unknown>>)['incompleteCause'] ?? d.details?.['incompleteCause'];
  return raw === 'revision_limit' || raw === 'verifier_incomplete' ? raw : null;
}

/** "n of m" revision cycles for the revision-limit case: from the detail when present, else the run. */
function revisionCounts(run: Pick<RunDetail, 'statusDetail' | 'revisionCycle' | 'limits'>): { readonly used: number; readonly max: number } {
  return {
    used: numberDetail(run.statusDetail, 'revisionCycle') ?? run.revisionCycle,
    max: numberDetail(run.statusDetail, 'maxRevisionCycles') ?? run.limits.maxRevisionCycles,
  };
}

/** The headline of an incomplete run, by cause (B4): never a revision-limit claim without the engine saying so. */
export function incompleteTitle(run: Pick<RunDetail, 'statusDetail' | 'revisionCycle' | 'limits'>): string {
  switch (incompleteCauseOf(run)) {
    case 'revision_limit': {
      const { used, max } = revisionCounts(run);
      return `Revision limit reached (${String(used)} of ${String(max)})`;
    }
    case 'verifier_incomplete':
      return 'The workflow reviewer marked the result incomplete';
    case null:
      return 'Incomplete';
  }
}

const TERMINAL_RUN_STATUSES: ReadonlySet<RunDetail['status']> = new Set(['completed', 'incomplete', 'cancelled', 'failed']);

/** A finished run (completed / incomplete / cancelled / failed): nothing runs again, so nothing can be retried. */
export function isFinishedRun(run: Pick<RunDetail, 'status'>): boolean {
  return TERMINAL_RUN_STATUSES.has(run.status);
}

/** Decisions of an unknown request on a finished run (no retry). */
const FINISHED_RUN_DECISIONS: readonly UnknownOutcomeDecision[] = ['accept_estimated_charge', 'mark_failed_keep_liability'];

/**
 * The unknown-outcome decisions offered for `run` (§4.4): all of them while the run can continue; on a finished run
 * only settling the left-over charge (accept the estimate, or mark failed and keep the liability), never a retry.
 */
export function unknownDecisionsFor(run: Pick<RunDetail, 'status'>): readonly UnknownOutcomeDecision[] {
  return isFinishedRun(run) ? FINISHED_RUN_DECISIONS : UNKNOWN_OUTCOME_DECISIONS;
}

const ATTENTION_STATES: ReadonlySet<StepView['state']> = new Set([
  'awaiting_approval',
  'executing',
  'validating',
  'reserved',
  'unknown',
  'failed',
]);

/**
 * The step to show when the URL names none (§5.2 "opens the exact pending step"): the pending approval, else (for a
 * cost overrun) the step that overran, else the latest step that needs attention or is in flight, else the step a
 * pause blocks / the next step to run; for a finished run the last step with an output; else the last finished one.
 */
export function defaultStep(run: RunDetail, events: readonly RunEvent[] = []): StepView | undefined {
  const latest = run.steps.filter((s) => isLatestRow(s, run.steps));
  const approval = latest.find((s) => s.state === 'awaiting_approval');
  if (approval !== undefined) return approval;
  if (run.status === 'paused' && run.pauseReason === 'approval_stale') {
    const approve = latest.find((s) => s.stepKey === 'approve');
    if (approve !== undefined) return approve;
  }
  // A cost overrun is about the step whose request cost more than reserved, not the step that waits.
  if (run.status === 'paused' && run.pauseReason === 'budget_overrun') {
    const overran = overrunStep(run, events);
    if (overran !== undefined) return overran;
  }
  const attention = [...latest].reverse().find((s) => ATTENTION_STATES.has(s.state));
  if (attention !== undefined) return attention;
  if (run.status === 'paused' || run.status === 'queued') {
    const named = pauseStepOf(run, latest);
    if (named !== undefined) return named;
    const next = latest.find((s) => s.state === 'ready' || s.state === 'pending');
    if (next !== undefined) return next;
  }
  // A finished run opens on its most informative step: the last one that stored an output (Finalize's report, else
  // the last model step's output), never a decided approval gate with nothing to show ("Approve plan: no output").
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    const withOutput = [...latest].reverse().find((s) => s.outputArtifactId !== null);
    if (withOutput !== undefined) return withOutput;
  }
  const done = [...latest].reverse().find((s) => s.state !== 'pending');
  return done ?? latest[0];
}

/**
 * The not-yet-run step a readiness pause names (`statusDetail.details.stepKey`: a queued run paused auth_required /
 * setup_blocked for one step's profile, 06 F13), when that step's latest row has not run.
 */
function pauseStepOf(run: RunDetail, latest: readonly StepView[]): StepView | undefined {
  const key = run.statusDetail?.details?.['stepKey'];
  if (typeof key !== 'string') return undefined;
  return latest.find((s) => s.stepKey === key && (s.state === 'ready' || s.state === 'pending' || s.state === 'reserved'));
}

/**
 * The step a pause is about (retry / choose profile target): the latest failed row, else the next step that has not
 * run (budget, setup, auth pauses happen before dispatch), else the latest unknown row.
 */
export function blockedStep(run: RunDetail): StepView | undefined {
  const latest = run.steps.filter((s) => isLatestRow(s, run.steps));
  return (
    [...latest].reverse().find((s) => s.state === 'failed') ??
    (run.status === 'paused' ? pauseStepOf(run, latest) : undefined) ??
    latest.find((s) => s.profileName !== null && (s.state === 'ready' || s.state === 'pending' || s.state === 'reserved')) ??
    [...latest].reverse().find((s) => s.state === 'unknown')
  );
}

/**
 * Attempt number per attempt id (`#seq` in the ledger), from `attempt.created` events: the payload's `seq` (engine),
 * else the order of creation within the step row.
 */
export function attemptSeqsOf(events: readonly RunEvent[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  const perRow = new Map<string, number>();
  for (const e of events) {
    if (e.type !== 'attempt.created') continue;
    const attemptId = e.payload['attemptId'];
    if (typeof attemptId !== 'string' || out.has(attemptId)) continue;
    const row = typeof e.payload['stepRunId'] === 'string' ? e.payload['stepRunId'] : '';
    const n = (perRow.get(row) ?? 0) + 1;
    perRow.set(row, n);
    const seq = e.payload['seq'];
    out.set(attemptId, typeof seq === 'number' && Number.isInteger(seq) ? seq : n);
  }
  return out;
}


/**
 * Why Resume cannot help yet for a run paused `auth_required`: its provider has no key, or the key that was rejected
 * has not passed a connection test since the pause. Null when Resume may proceed (or the run is not paused for
 * sign-in, or the provider is not known).
 */
export function signInResumeBlockedReason(
  run: RunDetail,
  providers: readonly ProviderStatus[] | undefined,
  events: readonly RunEvent[],
): string | null {
  return signInBlockedSince(run, providers, statusChangedAtOf(events, 'paused'));
}

/**
 * {@link signInResumeBlockedReason} with the pause time given directly (`pausedAt`: when the run became paused; null
 * when not known, then any successful test counts). Shared by the inspector and the shell's provider status line, so
 * both agree on when a provider is healthy again.
 */
export function signInBlockedSince(
  run: RunDetail,
  providers: readonly ProviderStatus[] | undefined,
  pausedAt: number | null,
): string | null {
  if (run.status !== 'paused' || run.pauseReason !== 'auth_required' || providers === undefined) return null;
  const providerId = stringDetail(run.statusDetail, 'providerId');
  if (providerId === null) return null;
  const p = providers.find((x) => x.providerId === providerId);
  const name = p?.displayName ?? providerId;
  if (p === undefined || !p.connected) return `connect ${name} in Settings → Providers first.`;
  // Queued run paused for a missing key: a connected key is all it needed.
  if (run.startedAt === null) return null;
  const since = pausedAt ?? 0;
  if (p.lastTest !== null && p.lastTest.ok && p.lastTest.at >= since) return null;
  return `reconnect ${name} first: its stored key was rejected. Resume becomes available after a successful connection test.`;
}

/** Short cause of a pause, for "Blocked: …" on the step it blocks. */
const BLOCKED_BY: Readonly<Record<PauseReason, string>> = {
  budget_run: 'run budget',
  budget_project: 'monthly budget',
  budget_overrun: 'cost overrun',
  user: 'paused by you',
  auth_required: 'provider sign-in',
  rate_limited: 'rate limit',
  setup_blocked: 'setup check',
  approval_stale: 'approval out of date',
  limit_attempts: 'attempt limit',
  deadline: 'time limit',
  output_invalid: 'invalid output',
  provider_unavailable: 'provider unavailable',
  model_refused: 'model declined',
  unknown_outcome: 'unknown outcome',
};

/**
 * The step a pause holds back (the one the run continues with once the cause is fixed): the approval gate of a stale
 * approval, else {@link blockedStep}, else the next step to run. Undefined unless the run is paused for a cause.
 */
export function pauseBlockedStep(run: RunDetail): StepView | undefined {
  // A user pause blocks nothing; an unknown outcome is about the unknown row itself (it already says so), and the
  // recovery choices decide what runs next.
  if (run.status !== 'paused' || run.pauseReason === null || run.pauseReason === 'user' || run.pauseReason === 'unknown_outcome') {
    return undefined;
  }
  const latest = run.steps.filter((s) => isLatestRow(s, run.steps));
  if (run.pauseReason === 'approval_stale') return latest.find((s) => s.stepKey === 'approve');
  return blockedStep(run) ?? latest.find((s) => s.state === 'ready' || s.state === 'pending');
}

/** States that read wrong on a blocked step ("Ready", "Not started"): shown as "Blocked: …" instead. */
const BLOCKABLE_STATES: ReadonlySet<StepView['state']> = new Set(['pending', 'ready', 'reserved', 'failed']);

/**
 * The status a step shows in the timeline and the step header: "Blocked: run budget" (etc.) for the step a pause
 * holds back, never "Ready" or "Not started"; else its own state.
 */
export function stepPresentation(run: RunDetail, step: StepView, blocked: StepView | undefined = pauseBlockedStep(run)): StatusPresentation {
  const own = statusPresentation('step', step.state);
  if (blocked?.id !== step.id || run.pauseReason === null || !BLOCKABLE_STATES.has(step.state)) return own;
  const pause = statusPresentation('pause', run.pauseReason);
  return { label: `Blocked: ${BLOCKED_BY[run.pauseReason]}`, tone: 'warning', icon: pause.icon, ...(pause.detail === undefined ? {} : { detail: pause.detail }) };
}

/** The step row whose request cost more than reserved (the latest `ledger.overrun` names it), if known. */
export function overrunStep(run: RunDetail, events: readonly RunEvent[]): StepView | undefined {
  const o = lastOverrun(events);
  if (o === null) return undefined;
  if (o.stepRunId !== null) return run.steps.find((s) => s.id === o.stepRunId);
  return o.stepKey === null ? undefined : latestRowOf(run.steps, o.stepKey);
}

/** `details.issues` of an OUTPUT_INVALID / VALIDATION_FAILED error (schema-checked; malformed entries dropped). */
export function issuesOf(error: AppError | null | undefined): ValidationIssue[] {
  const raw = error?.details?.['issues'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((i: unknown) => {
    const parsed = validationIssueSchema.safeParse({ code: 'invalid', ...(typeof i === 'object' && i !== null ? i : {}) });
    return parsed.success ? [parsed.data] : [];
  });
}

/** §9.3 admission breakdown carried by a BUDGET_BLOCKED error, when present. */
export function breakdownOf(error: AppError | null | undefined): BudgetBreakdown | null {
  if (error?.details === undefined) return null;
  const parsed = budgetBreakdownSchema.safeParse(error.details);
  return parsed.success ? parsed.data : null;
}

export function numberDetail(error: AppError | null | undefined, key: string): number | null {
  const v = error?.details?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function stringDetail(error: AppError | null | undefined, key: string): string | null {
  const v = error?.details?.[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

export function stringListDetail(error: AppError | null | undefined, key: string): string[] {
  const v = error?.details?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * A `{ relPath: sha256 }` map from PROJECT_CHANGED `details.before` / `details.after` (engine `projectChangedError`,
 * context stale check). A `null` hash means the file is now missing or unreadable. Entries with any other value shape
 * are dropped; a detail that is not a plain object yields an empty map.
 */
export function hashMapDetail(error: AppError | null | undefined, key: string): ReadonlyMap<string, string | null> {
  const v = error?.details?.[key];
  const out = new Map<string, string | null>();
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  for (const [path, hash] of Object.entries(v as Record<string, unknown>)) {
    if (path === '') continue;
    if (hash === null || (typeof hash === 'string' && hash !== '')) out.set(path, hash);
  }
  return out;
}

export interface OverrunFact {
  /** Reserved N, µUSD. */
  readonly reserved: number;
  /** Actual X, µUSD. */
  readonly actual: number;
  readonly attemptId: string | null;
  /** The step row of the attempt (`payload.stepRunId`), when the event names it. */
  readonly stepRunId: string | null;
  readonly stepKey: string | null;
}

/**
 * The latest `ledger.overrun` event (06 F4 payload `{ attemptId, stepRunId, N, X }`): reserved N vs actual X, in µUSD.
 */
export function lastOverrun(events: readonly RunEvent[]): OverrunFact | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type !== 'ledger.overrun') continue;
    const n = e.payload['N'];
    const x = e.payload['X'];
    const attemptId = e.payload['attemptId'];
    const stepRunId = e.payload['stepRunId'];
    const stepKey = e.payload['stepKey'];
    if (typeof n === 'number' && typeof x === 'number') {
      return {
        reserved: n,
        actual: x,
        attemptId: typeof attemptId === 'string' ? attemptId : null,
        stepRunId: typeof stepRunId === 'string' ? stepRunId : null,
        stepKey: typeof stepKey === 'string' ? stepKey : null,
      };
    }
  }
  return null;
}

/** Actions rendered in the page header (every other available action lives in the status banner or approval card). */
export const HEADER_ACTIONS: ReadonlySet<RunAction> = new Set<RunAction>(['pause', 'cancel', 'export_report', 'export_patch']);
/** Actions owned by the approval card. */
export const APPROVAL_ACTIONS: ReadonlySet<RunAction> = new Set<RunAction>(['approve', 'request_revision', 'reject']);

/** Available actions the status banner renders, in the server's order. */
export function bannerActions(run: RunDetail): RunAction[] {
  return run.availableActions.filter((a) => !HEADER_ACTIONS.has(a) && !APPROVAL_ACTIONS.has(a));
}

/**
 * The mock state name (10 J5) a run is shown in. Used by tests and the dev scenario switcher; the UI itself renders
 * from status / pause reason directly.
 */
export function inspectorStateName(run: RunDetail, selected: StepView | undefined): string {
  switch (run.status) {
    case 'awaiting_approval':
      return 'awaiting-approval';
    case 'running':
    case 'queued':
      if (selected !== undefined && (selected.state === 'validating' || (selected.state === 'failed' && selected.error?.code === 'OUTPUT_INVALID'))) {
        return 'schema-invalid';
      }
      return 'running-streaming';
    case 'interrupted':
      return 'interrupted';
    case 'cancelling':
      return 'cancelling';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    case 'completed':
      return 'completed';
    case 'incomplete':
      return 'incomplete';
    case 'paused':
      switch (run.pauseReason) {
        case 'budget_run':
        case 'budget_project':
          return 'budget-paused';
        case 'budget_overrun':
          return 'budget-overrun';
        case 'unknown_outcome':
          return 'unknown-outcome';
        case 'output_invalid':
          return 'output-invalid';
        case 'provider_unavailable':
        case 'setup_blocked':
          return 'provider-unavailable';
        case 'model_refused':
          return 'refused';
        case 'rate_limited':
          return 'rate-limited';
        case 'user':
        case null:
          return 'paused-user';
        case 'limit_attempts':
        case 'deadline':
          return 'paused-limit';
        case 'auth_required':
          return 'auth-failed';
        case 'approval_stale':
          return 'approval-stale';
      }
  }
}

/** Steps whose output is still useful after the run stopped (listed on failed / cancelled / incomplete runs). */
export function usefulArtifactSteps(run: RunDetail): StepView[] {
  return run.steps.filter((s) => s.outputArtifactId !== null);
}
