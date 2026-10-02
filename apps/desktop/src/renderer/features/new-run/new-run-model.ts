// New-run form model (10 J7): controlled state, client validation bounded by RUN_LIMIT_MAXIMUMS, the mapping of
// server issue paths to field ids (error summary anchors), and the RunStartInput builder.
import type { ReactNode } from 'react';
import { budgetBreakdownSchema, DEFAULT_LIMITS } from '@relay/contracts';
import type { AppError, BudgetBreakdown, InputOf, Microusd, ProfileWithWarnings, RunPreflight, WorkflowLimits } from '@relay/contracts';
import { isAppErrorException } from '../../api/client';
import { toViewError, validationIssuesOf } from '../../api/errors';
import type { FormProblem } from '../common/ErrorSummary';
import { checkAllowance, checkWhole, dollarsText, LIMIT_BOUNDS } from '../run-setup/limits';
import { profileOverridesFor, ROLE_LABELS } from '../run-setup/model-steps';
import type { ModelStepRow } from '../run-setup/model-steps';
import { issueMessage, MISSING_CREDENTIAL, problemIssues, stepKeyOfPath, stepProviderId } from '../run-setup/preflight-issues';

export type InputSource = 'files' | 'diff';

export interface ImportedDiff {
  readonly artifactId: string;
  readonly files: readonly string[];
  readonly parseWarnings: readonly string[];
}

export interface NewRunForm {
  readonly goal: string;
  readonly source: InputSource;
  /** null = the default selection (every eligible file, up to the cap). */
  readonly files: readonly string[] | null;
  readonly diff: ImportedDiff | null;
  readonly profileSelection: Readonly<Record<string, string>>;
  /** null = the workflow default. */
  readonly allowanceText: string | null;
  readonly revisionText: string | null;
  readonly attemptsText: string | null;
  readonly timeoutText: string | null;
  /**
   * The memory selection. `null` = untouched: every approved record is included (the engine default, §4.5) and
   * `memoryRecordIds` is not sent. Once the user changes the selection it is the explicit list of ticked non-pinned
   * records, sent as is (possibly `[]` = pinned rules only; pinned rules are always included and never sent).
   */
  readonly memoryIds: readonly string[] | null;
  /** Set by the first submit: goal/input errors show from then on. */
  readonly submitted: boolean;
}

export const INITIAL_FORM: NewRunForm = {
  goal: '',
  source: 'files',
  files: null,
  diff: null,
  profileSelection: {},
  allowanceText: null,
  revisionText: null,
  attemptsText: null,
  timeoutText: null,
  memoryIds: null,
  submitted: false,
};

export type FormAction =
  | { readonly type: 'patch'; readonly patch: Partial<NewRunForm> }
  | { readonly type: 'select-profile'; readonly stepKey: string; readonly profileId: string }
  /** `defaults`: the non-pinned approved ids ticked while the selection is untouched (the first toggle starts from them). */
  | { readonly type: 'toggle-memory'; readonly id: string; readonly checked: boolean; readonly defaults: readonly string[] };

export function formReducer(s: NewRunForm, a: FormAction): NewRunForm {
  switch (a.type) {
    case 'patch':
      return { ...s, ...a.patch };
    case 'select-profile':
      return { ...s, profileSelection: { ...s.profileSelection, [a.stepKey]: a.profileId } };
    case 'toggle-memory': {
      const current = s.memoryIds ?? a.defaults;
      return {
        ...s,
        memoryIds: a.checked ? [...current.filter((m) => m !== a.id), a.id] : current.filter((m) => m !== a.id),
      };
    }
  }
}

/**
 * Most memory records a run can name explicitly (contracts `runStartInputSchema.memoryRecordIds`, `.max(50)`). An
 * untouched picker sends none (every approved record is included), so only an explicit selection is capped.
 */
export const MAX_MEMORY_RECORD_IDS = 50;

/** The memory-field message for an explicit selection over {@link MAX_MEMORY_RECORD_IDS}, else null. */
export function memorySelectionError(memoryIds: readonly string[] | null): string | null {
  if (memoryIds === null || memoryIds.length <= MAX_MEMORY_RECORD_IDS) return null;
  const over = memoryIds.length - MAX_MEMORY_RECORD_IDS;
  return `Choose at most ${String(MAX_MEMORY_RECORD_IDS)} records (${String(memoryIds.length)} are ticked). Untick ${String(over)} more, or include all approved records.`;
}

/** Field ids: controls use them, and the error summary links to them. */
export const FIELD = {
  goal: 'new-run-goal',
  files: 'new-run-files',
  diff: 'new-run-diff',
  allowance: 'new-run-allowance',
  revisions: 'new-run-revisions',
  attempts: 'new-run-attempts',
  timeout: 'new-run-timeout',
  memory: 'new-run-memory',
  profile: (stepKey: string) => `new-run-profile-${stepKey}`,
} as const;

/** The control that holds the run input for a source: the file picker, or the diff import button. */
export function inputField(source: InputSource): string {
  return source === 'diff' ? FIELD.diff : FIELD.files;
}

/**
 * Server issue path → field id (`profileOverrides.plan` → the plan profile select). `input` issues target the control
 * rendered for the current source (the file picker is not rendered in diff mode).
 */
export function fieldForPath(path: string, source: InputSource = 'files'): string | null {
  if (path === 'goal') return FIELD.goal;
  if (path === 'input' || path.startsWith('input.')) return inputField(source);
  const profile = /^profileOverrides\.([a-z][a-z0-9_-]*)/.exec(path);
  if (profile?.[1] !== undefined) return FIELD.profile(profile[1]);
  if (path.startsWith('limitOverrides.budgetMicrousd')) return FIELD.allowance;
  if (path.startsWith('limitOverrides.maxRevisionCycles')) return FIELD.revisions;
  if (path.startsWith('limitOverrides.maxAttempts')) return FIELD.attempts;
  if (path.startsWith('limitOverrides.executionTimeoutSeconds')) return FIELD.timeout;
  if (path.startsWith('memoryRecordIds')) return FIELD.memory;
  return null;
}

/** Defaults of the editable limits, from the workflow version (else contracts DEFAULT_LIMITS). */
export interface LimitDefaults {
  readonly budget: Microusd;
  readonly revisions: number;
  readonly attempts: number;
  readonly timeoutMinutes: number;
}

export function limitDefaults(limits: WorkflowLimits | undefined): LimitDefaults {
  return {
    budget: (limits?.budgetMicrousd ?? DEFAULT_LIMITS.budgetMicrousd) as Microusd,
    revisions: limits?.maxRevisionCycles ?? DEFAULT_LIMITS.maxRevisionCycles,
    attempts: limits?.maxAttempts ?? DEFAULT_LIMITS.maxAttempts,
    timeoutMinutes: Math.round(
      (limits?.executionTimeoutSeconds ?? DEFAULT_LIMITS.executionTimeoutSeconds) / 60,
    ),
  };
}

export interface LimitTexts {
  readonly allowance: string;
  readonly revisions: string;
  readonly attempts: string;
  readonly timeout: string;
}

export function limitTexts(form: NewRunForm, d: LimitDefaults): LimitTexts {
  return {
    allowance: form.allowanceText ?? dollarsText(d.budget),
    revisions: form.revisionText ?? String(d.revisions),
    attempts: form.attemptsText ?? String(d.attempts),
    timeout: form.timeoutText ?? String(d.timeoutMinutes),
  };
}

export interface ClientCheck {
  /** field id → message. */
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly problems: readonly FormProblem[];
  readonly limitOverrides: InputOf<'relay/v1/runs.start'>['limitOverrides'];
  readonly allowance: Microusd | null;
}

/**
 * Client validation. Limit errors are live (a value above RUN_LIMIT_MAXIMUMS is flagged as typed); goal and input
 * errors appear after the first submit.
 */
export function checkForm(
  form: NewRunForm,
  texts: LimitTexts,
  d: LimitDefaults,
  fileCount: number,
): ClientCheck {
  const errors: Record<string, string> = {};
  const goal = form.goal.trim();
  if (form.submitted && goal === '') errors[FIELD.goal] = 'Enter a goal: describe the outcome you want.';
  if (goal.length > 2000) errors[FIELD.goal] = 'Use at most 2000 characters.';
  if (form.submitted && form.source === 'files' && fileCount === 0)
    errors[FIELD.files] = 'Select at least one file.';
  if (form.submitted && form.source === 'diff' && form.diff === null)
    errors[FIELD.diff] = 'Import a .diff or .patch file first.';
  const allowance = checkAllowance(texts.allowance);
  if ('error' in allowance) errors[FIELD.allowance] = allowance.error;
  const revisions = checkWhole(texts.revisions, LIMIT_BOUNDS.maxRevisionCycles);
  if ('error' in revisions) errors[FIELD.revisions] = revisions.error;
  const attempts = checkWhole(texts.attempts, LIMIT_BOUNDS.maxAttempts);
  if ('error' in attempts) errors[FIELD.attempts] = attempts.error;
  const timeout = checkWhole(texts.timeout, LIMIT_BOUNDS.timeoutMinutes);
  if ('error' in timeout) errors[FIELD.timeout] = timeout.error;
  const memory = memorySelectionError(form.memoryIds);
  if (memory !== null) errors[FIELD.memory] = memory;

  const overrides = {
    ...('value' in allowance && allowance.value !== d.budget ? { budgetMicrousd: allowance.value } : {}),
    ...('value' in revisions && revisions.value !== d.revisions
      ? { maxRevisionCycles: revisions.value }
      : {}),
    ...('value' in attempts && attempts.value !== d.attempts ? { maxAttempts: attempts.value } : {}),
    ...('value' in timeout && timeout.value !== d.timeoutMinutes
      ? { executionTimeoutSeconds: timeout.value * 60 }
      : {}),
  };
  const order = [
    FIELD.goal,
    FIELD.files,
    FIELD.diff,
    FIELD.allowance,
    FIELD.revisions,
    FIELD.attempts,
    FIELD.timeout,
    FIELD.memory,
  ];
  return {
    fieldErrors: errors,
    problems: order.flatMap((id) => (errors[id] === undefined ? [] : [{ fieldId: id, message: errors[id] }])),
    limitOverrides: Object.keys(overrides).length === 0 ? undefined : overrides,
    allowance: 'value' in allowance ? allowance.value : null,
  };
}

export type StartInput = Omit<InputOf<'relay/v1/runs.start'>, 'idempotencyKey'>;

/** The runs.start input (without its key), or null while the form cannot produce one. */
export function buildStartInput(args: {
  readonly form: NewRunForm;
  readonly projectId: string;
  readonly workflow: { readonly id: string; readonly version: number } | null;
  readonly files: readonly string[];
  readonly rows: readonly ModelStepRow[];
  readonly check: ClientCheck;
  readonly goal: string;
}): StartInput | null {
  const { form, workflow, files, rows, check } = args;
  if (workflow === null || args.goal === '' || args.goal.length > 2000) return null;
  if (Object.keys(check.fieldErrors).some((k) => k !== FIELD.goal && k !== FIELD.files && k !== FIELD.diff))
    return null;
  const input =
    form.source === 'files'
      ? files.length === 0
        ? null
        : { kind: 'files' as const, relPaths: [...files] }
      : form.diff === null
        ? null
        : { kind: 'diff' as const, diffArtifactId: form.diff.artifactId };
  if (input === null) return null;
  const profileOverrides = profileOverridesFor(rows, form.profileSelection);
  return {
    projectId: args.projectId,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    goal: args.goal,
    input,
    ...(check.limitOverrides === undefined ? {} : { limitOverrides: check.limitOverrides }),
    ...(profileOverrides === undefined ? {} : { profileOverrides }),
    // Absent = every approved record (untouched picker); otherwise the explicit list, `[]` included.
    ...(form.memoryIds === null ? {} : { memoryRecordIds: [...form.memoryIds] }),
  };
}

/** The admission breakdown carried by a BUDGET_BLOCKED error (`details`), if any. */
export function budgetFromError(e: unknown): BudgetBreakdown | null {
  if (!isAppErrorException(e) || e.appError.code !== 'BUDGET_BLOCKED') return null;
  const parsed = budgetBreakdownSchema.safeParse(e.appError.details);
  return parsed.success ? parsed.data : null;
}

/** Problems (summary entries) from an AppError that blocks the run (preflight or start), excluding budget. */
export function problemsFromError(
  error: AppError,
  issues: ReadonlyArray<{ path: string; message: string; code: string }>,
  source: InputSource = 'files',
): FormProblem[] {
  if (issues.length > 0)
    return issues.map((i) => ({ fieldId: fieldForPath(i.path, source), message: i.message, code: i.code }));
  const stepKey = typeof error.details?.['stepKey'] === 'string' ? error.details['stepKey'] : null;
  const fieldId =
    stepKey !== null
      ? FIELD.profile(stepKey)
      : error.code === 'CONTEXT_TOO_LARGE'
        ? inputField(source)
        : null;
  return [{ fieldId, message: error.userMessage, code: error.code }];
}

// ---------------------------------------------------------------------------------------------------------------
// Derived page state (SPLIT-01): everything the new-run page shows about problems, budget and readiness, as a pure
// function of the form, the preflight query and the last start error.

/** The parts of the `runs.preflight` query the page state depends on. */
export interface PreflightSnapshot {
  readonly data: RunPreflight | undefined;
  readonly error: unknown;
  readonly isFetching: boolean;
  readonly isPlaceholderData: boolean;
  readonly isSuccess: boolean;
}

export interface NewRunStateInput {
  readonly form: NewRunForm;
  readonly rows: readonly ModelStepRow[];
  readonly check: ClientCheck;
  readonly profiles: readonly ProfileWithWarnings[] | undefined;
  readonly goal: string;
  /** `canonicalJson` of the input the preflight checks (placeholder goal while none is typed), or null. */
  readonly draftKey: string | null;
  /** The debounced `draftKey` the preflight query ran for ('' = none yet). */
  readonly settledKey: string;
  /** `canonicalJson` of the input Start would send, or null while the form cannot produce one. */
  readonly submitKey: string | null;
  readonly preflight: PreflightSnapshot;
  /** The last `runs.start` error, and the key of the input it failed for. */
  readonly startError: unknown;
  readonly failedKey: string | null;
  /** The action shown next to a missing-credential problem (a link to Settings → Providers). */
  readonly connectProviderAction?: ReactNode;
}

/** Which sentence the page header shows. */
export type NewRunStatus = 'system_error' | 'budget' | 'problems' | 'ready' | 'checking' | null;

export interface NewRunState {
  readonly budget: BudgetBreakdown | null;
  /** Client and server problems, deduplicated, each anchored to a rendered field or to none. */
  readonly problems: readonly FormProblem[];
  readonly fieldErrors: Readonly<Record<string, string>>;
  /** step key → message, for the profile table. */
  readonly profileErrors: Readonly<Record<string, string>>;
  /** A preflight failure that is not about the form (runner down, internal, conflict): an ErrorView. */
  readonly preflightSystemError: unknown;
  /** A start failure that is neither a form problem nor a budget block. */
  readonly otherStartError: unknown;
  /** A fresh, clean preflight of exactly the submitted input. */
  readonly checked: boolean;
  /** The debounced check has not caught up with the form yet. */
  readonly checking: boolean;
  readonly allPassed: boolean;
  readonly status: NewRunStatus;
  readonly startDisabled: boolean;
  readonly startDisabledReason: string | null;
}

/** System errors (runner down, internal, conflict) are not form problems: they render as an ErrorView. */
function isSystemError(e: unknown): boolean {
  const code = toViewError(e).code;
  return code === 'INTERNAL' || code === 'CONFLICT' || code === 'RUNNER_UNAVAILABLE';
}

function preflightProblems(input: NewRunStateInput, budgetShown: boolean): FormProblem[] {
  const { preflight, rows, form, profiles, connectProviderAction } = input;
  const pf = preflight.data;
  if (pf === undefined || preflight.error !== null) return [];
  // budget_run / budget_project restate `budget.allowed = false`: the budget card already shows that block.
  return problemIssues(pf.issues, budgetShown).map((i) => {
    const stepKey = stepKeyOfPath(i.path);
    const row = stepKey === null ? undefined : rows.find((r) => r.stepKey === stepKey);
    const providerId = stepKey === null ? null : stepProviderId(stepKey, rows, form.profileSelection, profiles);
    return {
      fieldId: fieldForPath(i.path, form.source),
      message: issueMessage(i, providerId, row === undefined ? null : ROLE_LABELS[row.role]),
      code: i.code,
      ...(i.code === MISSING_CREDENTIAL && connectProviderAction !== undefined ? { action: connectProviderAction } : {}),
    };
  });
}

/** Summary links must reach a rendered control: a profile issue for a step not in the table has no anchor. */
function anchorProblems(problems: readonly FormProblem[], form: NewRunForm, rows: readonly ModelStepRow[]): FormProblem[] {
  const knownFields = new Set<string>([
    FIELD.goal,
    form.source === 'files' ? FIELD.files : FIELD.diff,
    FIELD.allowance,
    FIELD.revisions,
    FIELD.attempts,
    FIELD.timeout,
    FIELD.memory,
    ...rows.map((r) => FIELD.profile(r.stepKey)),
  ]);
  return problems.map((p) => (p.fieldId !== null && !knownFields.has(p.fieldId) ? { ...p, fieldId: null } : p));
}

function statusOf(s: Pick<NewRunState, 'preflightSystemError' | 'budget' | 'problems' | 'allPassed' | 'checking'>): NewRunStatus {
  if (s.preflightSystemError !== null) return 'system_error';
  if (s.budget !== null) return 'budget';
  if (s.problems.length > 0) return 'problems';
  if (s.allPassed) return 'ready';
  return s.checking ? 'checking' : null;
}

/** The new-run page state (problems, budget block, readiness, Start) for one render. Pure. */
export function deriveNewRunState(input: NewRunStateInput): NewRunState {
  const { form, rows, check, goal, draftKey, settledKey, submitKey, preflight } = input;
  const pf = preflight.data;
  const preflightError = preflight.error ?? null;
  /** The preflight answer belongs to the settled input, and is not a kept-previous placeholder. */
  const preflightSettled = settledKey !== '' && !preflight.isFetching && !preflight.isPlaceholderData;
  /** A settled preflight for exactly the input Start would send (B3: never start unpreflighted inputs). */
  const freshPreflight = preflightSettled && submitKey === settledKey && preflight.isSuccess ? pf : undefined;
  // The start error belongs to the input that failed; once the form changes, it no longer applies.
  const startError =
    input.startError === null || input.startError === undefined || submitKey === null || input.failedKey !== submitKey
      ? null
      : input.startError;
  const budget =
    (startError === null ? null : budgetFromError(startError)) ??
    (pf !== undefined && !pf.budget.allowed ? pf.budget : null) ??
    budgetFromError(preflightError);

  const server = preflightProblems(input, budget !== null);
  for (const e of [preflightError, startError]) {
    if (e === null || budgetFromError(e) !== null || isSystemError(e)) continue;
    server.push(...problemsFromError(toViewError(e), validationIssuesOf(e), form.source));
  }
  const serverProblems = anchorProblems(server, form, rows);
  const preflightSystemError =
    preflightError !== null && budgetFromError(preflightError) === null && isSystemError(preflightError) ? preflightError : null;
  const problems = [...check.problems, ...serverProblems].filter(
    (p, i, all) => all.findIndex((q) => q.fieldId === p.fieldId && q.message === p.message) === i,
  );
  const fieldErrors: Record<string, string> = { ...check.fieldErrors };
  for (const p of serverProblems) if (p.fieldId !== null && fieldErrors[p.fieldId] === undefined) fieldErrors[p.fieldId] = p.message;
  const profileErrors: Record<string, string> = {};
  for (const r of rows) {
    const msg = fieldErrors[FIELD.profile(r.stepKey)];
    if (msg !== undefined) profileErrors[r.stepKey] = msg;
  }
  const otherStartError = startError !== null && serverProblems.length === 0 && budgetFromError(startError) === null ? startError : null;

  const checked = freshPreflight !== undefined && freshPreflight.issues.length === 0 && freshPreflight.budget.allowed;
  const checking =
    draftKey !== null &&
    (settledKey !== draftKey || !preflightSettled) &&
    preflightSystemError === null &&
    budget === null &&
    problems.length === 0;
  const draftClean = !checking && draftKey !== null && preflight.isSuccess && pf !== undefined && pf.issues.length === 0 && pf.budget.allowed;
  // With no goal yet the check uses a placeholder goal; Start then only reveals what is missing.
  const allPassed = submitKey === null ? goal === '' && draftClean : checked;

  const blocked = budget !== null;
  const startDisabledReason = blocked
    ? `Blocked by the ${budget.scope === 'project' ? 'monthly' : 'run'} allowance. Choose an option above.`
    : preflightSystemError !== null
      ? 'The run check failed. Retry it in Input summary.'
      : submitKey !== null && !checked && problems.length === 0
        ? 'Checking…'
        : null;
  const base = { budget, problems, fieldErrors, profileErrors, preflightSystemError, otherStartError, checked, checking, allPassed };
  return {
    ...base,
    status: statusOf(base),
    // Disabled while blocked, checking, or with problems; with no input yet a submit shows what is missing.
    startDisabled: blocked || preflightSystemError !== null || (submitKey !== null && !checked),
    startDisabledReason,
  };
}
