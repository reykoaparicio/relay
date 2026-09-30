// New-run form model (10 J7): controlled state, client validation bounded by RUN_LIMIT_MAXIMUMS, the mapping of
// server issue paths to field ids (error summary anchors), and the RunStartInput builder.
import { budgetBreakdownSchema, DEFAULT_LIMITS } from '@relay/contracts';
import type { AppError, BudgetBreakdown, InputOf, Microusd, WorkflowLimits } from '@relay/contracts';
import { isAppErrorException } from '../../api/client';
import type { FormProblem } from '../common/ErrorSummary';
import { checkAllowance, checkWhole, dollarsText, LIMIT_BOUNDS } from '../run-setup/limits';
import { profileOverridesFor } from '../run-setup/model-steps';
import type { ModelStepRow } from '../run-setup/model-steps';

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
  /** Checked approved, non-pinned records (pinned rules are always included by the engine and never sent). */
  readonly memoryIds: readonly string[];
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
  memoryIds: [],
  submitted: false,
};

export type FormAction =
  | { readonly type: 'patch'; readonly patch: Partial<NewRunForm> }
  | { readonly type: 'select-profile'; readonly stepKey: string; readonly profileId: string }
  | { readonly type: 'toggle-memory'; readonly id: string; readonly checked: boolean };

export function formReducer(s: NewRunForm, a: FormAction): NewRunForm {
  switch (a.type) {
    case 'patch':
      return { ...s, ...a.patch };
    case 'select-profile':
      return { ...s, profileSelection: { ...s.profileSelection, [a.stepKey]: a.profileId } };
    case 'toggle-memory':
      return {
        ...s,
        memoryIds: a.checked
          ? [...s.memoryIds.filter((m) => m !== a.id), a.id]
          : s.memoryIds.filter((m) => m !== a.id),
      };
  }
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

/** Server issue path → field id (`profileOverrides.plan` → the plan profile select). */
export function fieldForPath(path: string): string | null {
  if (path === 'goal') return FIELD.goal;
  if (path === 'input' || path.startsWith('input.')) return FIELD.files;
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
    ...(form.memoryIds.length === 0 ? {} : { memoryRecordIds: [...form.memoryIds] }),
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
): FormProblem[] {
  if (issues.length > 0)
    return issues.map((i) => ({ fieldId: fieldForPath(i.path), message: i.message, code: i.code }));
  const stepKey = typeof error.details?.['stepKey'] === 'string' ? error.details['stepKey'] : null;
  const fieldId =
    stepKey !== null ? FIELD.profile(stepKey) : error.code === 'CONTEXT_TOO_LARGE' ? FIELD.files : null;
  return [{ fieldId, message: error.userMessage, code: error.code }];
}
