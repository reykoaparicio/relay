// Pure view-model helpers of the run inspector (10 J8). Nothing here decides which actions are allowed: buttons come
// only from `RunDetail.availableActions` (06 F2); these helpers only pick what to show.
import { budgetBreakdownSchema, validationIssueSchema } from '@relay/contracts';
import type {
  AppError,
  BudgetBreakdown,
  RunAction,
  RunDetail,
  RunEvent,
  StepView,
  ValidationIssue,
} from '@relay/contracts';
import { stepKeyLabel } from '../../lib/format';

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

/** Workflow step titles as the user knows them (§5.4 mock); unknown keys are humanized. */
const STEP_TITLES: Readonly<Record<string, string>> = {
  intake: 'Read context',
  review: 'Review input',
  plan: 'Plan a fix',
  approve: 'Approve plan',
  implement: 'Produce patch',
  verify: 'Review patch',
  finalize: 'Finalize',
};

export function stepTitle(step: { readonly stepKey: string }): string {
  return STEP_TITLES[step.stepKey] ?? stepKeyLabel(step.stepKey);
}

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
export function eventStepRunIds(e: RunEvent): readonly string[] | null {
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
export function revisionCounts(run: Pick<RunDetail, 'statusDetail' | 'revisionCycle' | 'limits'>): { readonly used: number; readonly max: number } {
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

const ATTENTION_STATES: ReadonlySet<StepView['state']> = new Set([
  'awaiting_approval',
  'executing',
  'validating',
  'reserved',
  'unknown',
  'failed',
]);

/**
 * The step to show when the URL names none (§5.2 "opens the exact pending step"): the pending approval, else the
 * latest step that needs attention or is in flight, else the next step to run, else the last finished one.
 */
export function defaultStep(run: RunDetail): StepView | undefined {
  const latest = run.steps.filter((s) => isLatestRow(s, run.steps));
  const approval = latest.find((s) => s.state === 'awaiting_approval');
  if (approval !== undefined) return approval;
  if (run.status === 'paused' && run.pauseReason === 'approval_stale') {
    const approve = latest.find((s) => s.stepKey === 'approve');
    if (approve !== undefined) return approve;
  }
  const attention = [...latest].reverse().find((s) => ATTENTION_STATES.has(s.state));
  if (attention !== undefined) return attention;
  if (run.status === 'paused' || run.status === 'queued') {
    const next = latest.find((s) => s.state === 'ready' || s.state === 'pending');
    if (next !== undefined) return next;
  }
  const done = [...latest].reverse().find((s) => s.state !== 'pending');
  return done ?? latest[0];
}

/**
 * The step a pause is about (retry / choose profile target): the latest failed row, else the next step that has not
 * run (budget, setup, auth pauses happen before dispatch), else the latest unknown row.
 */
export function blockedStep(run: RunDetail): StepView | undefined {
  const latest = run.steps.filter((s) => isLatestRow(s, run.steps));
  return (
    [...latest].reverse().find((s) => s.state === 'failed') ??
    latest.find((s) => s.profileName !== null && (s.state === 'ready' || s.state === 'pending' || s.state === 'reserved')) ??
    [...latest].reverse().find((s) => s.state === 'unknown')
  );
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

/** The latest `ledger.overrun` event (06 F4 payload `{ attemptId, N, X }`): reserved N vs actual X, in µUSD. */
export function lastOverrun(events: readonly RunEvent[]): { readonly reserved: number; readonly actual: number; readonly attemptId: string | null } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.type !== 'ledger.overrun') continue;
    const n = e.payload['N'];
    const x = e.payload['X'];
    const attemptId = e.payload['attemptId'];
    if (typeof n === 'number' && typeof x === 'number') {
      return { reserved: n, actual: x, attemptId: typeof attemptId === 'string' ? attemptId : null };
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
