// New-run form model (10 J7): controlled state, client validation bounded by RUN_LIMIT_MAXIMUMS, the mapping of
// server issue paths to field ids (error summary anchors), and the RunStartInput builder.
import type { ReactNode } from 'react';
import { budgetBreakdownSchema, DEFAULT_LIMITS, INPUT_CAPS } from '@relay/contracts';
import type {
  AppError,
  BudgetBreakdown,
  InputOf,
  Microusd,
  PreviewResult,
  ProfileWithWarnings,
  RunPreflight,
  WorkflowLimits,
} from '@relay/contracts';
import { isAppErrorException } from '../../api/client';
import { errorReason, toViewError, validationIssuesOf } from '../../api/errors';
import { secretLabelText } from '../../lib/format/labels';
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
  /** null = the default selection (every eligible file not flagged as a suspected secret, up to the cap). */
  readonly files: readonly string[] | null;
  /**
   * E2 #11: selected files the user confirmed sending although they look like they hold a secret. Sent as
   * `input.acknowledgedSuspectedSecrets` (only the ones still selected); unticking a file drops it.
   */
  readonly acknowledgedSecrets: readonly string[];
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
  acknowledgedSecrets: [],
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
  /**
   * The file selection (and, when given, the confirmed suspected secrets). Acknowledgements of files that are no longer
   * selected are dropped, so `acknowledgedSuspectedSecrets` stays a subset of `relPaths`.
   */
  | { readonly type: 'set-files'; readonly files: readonly string[]; readonly acknowledged?: readonly string[] }
  /** `defaults`: the non-pinned approved ids ticked while the selection is untouched (the first toggle starts from them). */
  | { readonly type: 'toggle-memory'; readonly id: string; readonly checked: boolean; readonly defaults: readonly string[] };

export function formReducer(s: NewRunForm, a: FormAction): NewRunForm {
  switch (a.type) {
    case 'patch':
      return { ...s, ...a.patch };
    case 'select-profile':
      return { ...s, profileSelection: { ...s.profileSelection, [a.stepKey]: a.profileId } };
    case 'set-files':
      return { ...s, files: a.files, acknowledgedSecrets: acknowledgedFor(a.files, a.acknowledged ?? s.acknowledgedSecrets) };
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

/** E2 #11: an included file flagged as a suspected secret (never selected by default). */
export function isSuspectedSecret(f: PreviewResult['included'][number]): boolean {
  return f.suspectedSecret === true;
}

/**
 * The default file selection: every included file except suspected secrets, up to the file cap. Suspected secrets are
 * only ever added by an explicit, confirmed tick.
 */
export function defaultFiles(preview: PreviewResult | undefined): readonly string[] {
  return (preview?.included ?? [])
    .filter((f) => !isSuspectedSecret(f))
    .slice(0, INPUT_CAPS.maxFiles)
    .map((f) => f.relPath);
}

/** The acknowledged suspected secrets that are still selected (contracts: a subset of `relPaths`), in selection order. */
export function acknowledgedFor(files: readonly string[], acknowledged: readonly string[]): string[] {
  const acked = new Set(acknowledged);
  return files.filter((p) => acked.has(p));
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

/**
 * The id of the checkbox of the `index`-th included file of the preview. The first one is {@link FIELD.files} (the
 * picker's anchor), so a problem about the input as a whole and one about the first file reach the same control.
 */
export function fileCheckboxId(index: number): string {
  return index === 0 ? FIELD.files : `${FIELD.files}-${String(index)}`;
}

/** relPath → checkbox id, for every included file of a preview. */
export function fileCheckboxIds(preview: PreviewResult | undefined): ReadonlyMap<string, string> {
  return new Map((preview?.included ?? []).map((f, i) => [f.relPath, fileCheckboxId(i)]));
}

/** What a per-file problem needs to link to that file's checkbox. */
export interface FileAnchors {
  /** The `relPaths` the checked input carried, in order (`input.relPaths.<i>`). */
  readonly relPaths: readonly string[];
  /** relPath → its checkbox id ({@link fileCheckboxIds}). */
  readonly ids: ReadonlyMap<string, string>;
}

/** The checkbox of a file, else the picker itself (a file the picker does not list). */
function fileField(relPath: string | undefined, anchors: FileAnchors | undefined): string {
  return (relPath === undefined ? undefined : anchors?.ids.get(relPath)) ?? FIELD.files;
}

/** The control that holds the run input for a source: the file picker, or the diff import button. */
export function inputField(source: InputSource): string {
  return source === 'diff' ? FIELD.diff : FIELD.files;
}

/**
 * Server issue path → field id (`profileOverrides.plan` → the plan profile select). `input` issues target the control
 * rendered for the current source (the file picker is not rendered in diff mode).
 */
export function fieldForPath(path: string, source: InputSource = 'files', anchors?: FileAnchors): string | null {
  if (path === 'goal') return FIELD.goal;
  // `input.relPaths.<i>` (e.g. a suspected secret): the checkbox of that file.
  const file = /^input\.relPaths\.(\d+)/.exec(path);
  if (source === 'files' && file?.[1] !== undefined) return fileField(anchors?.relPaths[Number(file[1])], anchors);
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
        : { kind: 'files' as const, relPaths: [...files], ...acknowledgedInput(files, form.acknowledgedSecrets) }
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

/** `acknowledgedSuspectedSecrets` for a files input: absent when none of the selected files is acknowledged. */
function acknowledgedInput(files: readonly string[], acknowledged: readonly string[]) {
  const acked = acknowledgedFor(files, acknowledged);
  return acked.length === 0 ? {} : { acknowledgedSuspectedSecrets: acked };
}

/** The admission breakdown carried by a BUDGET_BLOCKED error (`details`), if any. */
export function budgetFromError(e: unknown): BudgetBreakdown | null {
  if (!isAppErrorException(e) || e.appError.code !== 'BUDGET_BLOCKED') return null;
  const parsed = budgetBreakdownSchema.safeParse(e.appError.details);
  return parsed.success ? parsed.data : null;
}

/** One file intake refused as a suspected secret (`PERMISSION_DENIED suspected_secret`, `details.denied[]`). */
export interface DeniedSecret {
  readonly relPath: string;
  readonly secretLabel: string | null;
  readonly secretLine: number | null;
}

/** The files a `PERMISSION_DENIED suspected_secret` error names (label and line only; never a value), else []. */
export function deniedSecretsOf(error: AppError | null): DeniedSecret[] {
  if (error?.code !== 'PERMISSION_DENIED' || errorReason(error) !== 'suspected_secret') return [];
  const denied = error.details?.['denied'];
  const fromList = Array.isArray(denied)
    ? denied.flatMap((d): DeniedSecret[] => {
        if (typeof d !== 'object' || d === null) return [];
        const r = d as Record<string, unknown>;
        if (typeof r['relPath'] !== 'string') return [];
        return [
          {
            relPath: r['relPath'],
            secretLabel: typeof r['secretLabel'] === 'string' ? r['secretLabel'] : null,
            secretLine: typeof r['secretLine'] === 'number' ? r['secretLine'] : null,
          },
        ];
      })
    : [];
  const single = error.details?.['relPath'];
  if (fromList.length === 0 && typeof single === 'string') return [{ relPath: single, secretLabel: null, secretLine: null }];
  return fromList;
}

/** The file a `PERMISSION_DENIED unreadable` error names (`details.relPath`), else null. */
export function unreadableFileOf(error: AppError | null): string | null {
  if (error?.code !== 'PERMISSION_DENIED' || errorReason(error) !== 'unreadable') return null;
  const relPath = error.details?.['relPath'];
  return typeof relPath === 'string' ? relPath : null;
}

/** "src/config/keys.ts looks like it contains a secret (Anthropic API key, line 4). …" — never the value. */
export function deniedSecretMessage(d: DeniedSecret): string {
  const where = d.secretLine === null ? '' : `, line ${String(d.secretLine)}`;
  return `${d.relPath} looks like it contains a secret (${secretLabelText(d.secretLabel)}${where}). Untick it, or confirm sending it.`;
}

/** Per-file context for {@link problemsFromError}. */
export interface FileProblemContext {
  readonly anchors?: FileAnchors | undefined;
  /** The actions shown next to an unreadable file ("Exclude this file", "Exclude from project…"). */
  readonly unreadableAction?: ((relPath: string) => ReactNode) | undefined;
}

/** Problems (summary entries) from an AppError that blocks the run (preflight or start), excluding budget. */
export function problemsFromError(
  error: AppError,
  issues: ReadonlyArray<{ path: string; message: string; code: string }>,
  source: InputSource = 'files',
  files: FileProblemContext = {},
): FormProblem[] {
  if (issues.length > 0)
    return issues.map((i) => ({ fieldId: fieldForPath(i.path, source, files.anchors), message: i.message, code: i.code }));
  // E2 #11: each refused file links to its checkbox, so it can be unticked or confirmed.
  const denied = deniedSecretsOf(error);
  if (denied.length > 0)
    return denied.map((d) => ({
      fieldId: source === 'files' ? fileField(d.relPath, files.anchors) : null,
      message: deniedSecretMessage(d),
      code: 'suspected_secret',
    }));
  // E2 #8: a selected file cannot be read: link to it, and offer to leave it out.
  const unreadable = unreadableFileOf(error);
  if (unreadable !== null) {
    const action = files.unreadableAction?.(unreadable);
    return [
      {
        fieldId: source === 'files' ? fileField(unreadable, files.anchors) : null,
        message: error.userMessage,
        code: error.code,
        ...(action === undefined ? {} : { action }),
      },
    ];
  }
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
  /** Per-file anchors: `input.relPaths.<i>` issues and refused files link to that file's checkbox. */
  readonly fileAnchors?: FileAnchors;
  /** The actions shown next to an unreadable selected file. */
  readonly unreadableAction?: (relPath: string) => ReactNode;
}

/** Which sentence the page header shows. */
export type NewRunStatus = 'system_error' | 'budget' | 'problems' | 'needs_goal' | 'ready' | 'checking' | null;

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
      fieldId: fieldForPath(i.path, form.source, input.fileAnchors),
      message: issueMessage(i, providerId, row === undefined ? null : ROLE_LABELS[row.role]),
      code: i.code,
      ...(i.code === MISSING_CREDENTIAL && connectProviderAction !== undefined ? { action: connectProviderAction } : {}),
    };
  });
}

/** Summary links must reach a rendered control: a profile issue for a step not in the table has no anchor. */
function anchorProblems(
  problems: readonly FormProblem[],
  form: NewRunForm,
  rows: readonly ModelStepRow[],
  anchors: FileAnchors | undefined,
): FormProblem[] {
  const knownFields = new Set<string>([
    ...(form.source === 'files' ? (anchors?.ids.values() ?? []) : []),
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

function statusOf(
  s: Pick<NewRunState, 'preflightSystemError' | 'budget' | 'problems' | 'allPassed' | 'checking'> & { readonly needsGoal: boolean },
): NewRunStatus {
  if (s.preflightSystemError !== null) return 'system_error';
  if (s.budget !== null) return 'budget';
  if (s.problems.length > 0) return 'problems';
  if (s.needsGoal) return 'needs_goal';
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
    server.push(
      ...problemsFromError(toViewError(e), validationIssuesOf(e), form.source, {
        anchors: input.fileAnchors,
        unreadableAction: input.unreadableAction,
      }),
    );
  }
  const serverProblems = anchorProblems(server, form, rows, input.fileAnchors);
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
  // With no goal yet the check uses a placeholder goal: everything else passed, but the run cannot start without one
  // ("Enter a goal to start", Start disabled), never "All checks passed. Ready to start." on an empty goal.
  const needsGoal = submitKey === null && goal === '' && draftClean;
  const allPassed = submitKey !== null && checked;

  const blocked = budget !== null;
  const startDisabledReason = blocked
    ? `Blocked by the ${budget.scope === 'project' ? 'monthly' : 'run'} allowance. Choose an option above.`
    : preflightSystemError !== null
      ? 'The run check failed. Retry it in Input summary.'
      : needsGoal
        ? 'Enter a goal to start.'
        : submitKey !== null && !checked && problems.length === 0
          ? 'Checking…'
          : null;
  const base = { budget, problems, fieldErrors, profileErrors, preflightSystemError, otherStartError, checked, checking, allPassed };
  return {
    ...base,
    status: statusOf({ ...base, needsGoal }),
    // Disabled while blocked, checking, with problems, or with only the goal missing; with other input missing too, a
    // submit shows everything that is missing.
    startDisabled: blocked || preflightSystemError !== null || needsGoal || (submitKey !== null && !checked),
    startDisabledReason,
  };
}
