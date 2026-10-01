// Workflow editor model (10 J10, §5.3): the P0-editable fields of a workflow version as form text, the
// `WorkflowDraftPatch` of what changed, client-side bounds, and the mapping of validation issue paths
// (`steps[3].maxOutputTokens`, `limits.maxAttempts`, `prompts.reviewer.v1`) to editor field ids.
import { DEFAULT_LIMITS, MAX_OUTPUT_TOKENS_CEILING, MAX_RETRY_POLICY, MEMORY_TYPES } from '@relay/contracts';
import type { MemoryType, Microusd, StepKey, StepSpec, WorkflowDraftPatch, WorkflowVersionView } from '@relay/contracts';
import { stepKeyLabel } from '../../lib/format';
import { checkAllowance, checkWhole, dollarsText, LIMIT_BOUNDS } from '../run-setup/limits';

export type ModelStep = Extract<StepSpec, { kind: 'model' }>;

export interface StepForm {
  /** The spec's profile name (e.g. "economy"). */
  readonly profile: string;
  /** '' = no step override (the profile's output allowance applies). */
  readonly maxOutputTokens: string;
  readonly transport: string;
  readonly schemaRepair: string;
  readonly rateLimitWaits: string;
  readonly memoryRoles: 'step_role' | 'all';
  readonly memoryTypes: readonly MemoryType[];
}

export interface WorkflowForm {
  readonly allowance: string;
  readonly revisions: string;
  readonly attempts: string;
  readonly timeoutMinutes: string;
  readonly steps: Readonly<Record<string, StepForm>>;
  /** instructionVersion → prompt text. */
  readonly prompts: Readonly<Record<string, string>>;
}

/** Field ids (error-summary anchors and `aria-describedby` targets). */
export const WF_FIELD = {
  allowance: 'wf-limits-budgetMicrousd',
  revisions: 'wf-limits-maxRevisionCycles',
  attempts: 'wf-limits-maxAttempts',
  timeout: 'wf-limits-executionTimeoutSeconds',
  step: (key: string) => `wf-step-${key}`,
  profile: (key: string) => `wf-step-${key}-profile`,
  maxOutputTokens: (key: string) => `wf-step-${key}-maxOutputTokens`,
  transport: (key: string) => `wf-step-${key}-retry-transport`,
  schemaRepair: (key: string) => `wf-step-${key}-retry-schemaRepair`,
  rateLimitWaits: (key: string) => `wf-step-${key}-retry-rateLimitWaits`,
  memoryScope: (key: string) => `wf-step-${key}-memoryScope`,
  prompt: (key: string) => `wf-step-${key}-prompt`,
} as const;

export const RETRY_BOUNDS = {
  transport: { min: 0, max: MAX_RETRY_POLICY.transport },
  schemaRepair: { min: 0, max: MAX_RETRY_POLICY.schemaRepair },
  rateLimitWaits: { min: 0, max: MAX_RETRY_POLICY.rateLimitWaits },
} as const;

export const OUTPUT_TOKENS_BOUNDS = { min: 1, max: MAX_OUTPUT_TOKENS_CEILING } as const;

export function modelSteps(view: WorkflowVersionView): ModelStep[] {
  return view.spec.steps.filter((s): s is ModelStep => s.kind === 'model');
}

export function initialForm(view: WorkflowVersionView): WorkflowForm {
  const l = view.spec.limits;
  const limits = {
    budgetMicrousd: l.budgetMicrousd ?? (DEFAULT_LIMITS.budgetMicrousd as Microusd),
    maxRevisionCycles: l.maxRevisionCycles ?? DEFAULT_LIMITS.maxRevisionCycles,
    maxAttempts: l.maxAttempts ?? DEFAULT_LIMITS.maxAttempts,
    executionTimeoutSeconds: l.executionTimeoutSeconds ?? DEFAULT_LIMITS.executionTimeoutSeconds,
  };
  const steps: Record<string, StepForm> = {};
  for (const s of modelSteps(view)) {
    steps[s.id] = {
      profile: s.profile,
      maxOutputTokens: s.maxOutputTokens === undefined ? '' : String(s.maxOutputTokens),
      transport: String(s.retryPolicy.transport),
      schemaRepair: String(s.retryPolicy.schemaRepair),
      rateLimitWaits: String(s.retryPolicy.rateLimitWaits),
      memoryRoles: s.memoryScope.roles,
      memoryTypes: [...s.memoryScope.types],
    };
  }
  return {
    allowance: dollarsText(limits.budgetMicrousd),
    revisions: String(limits.maxRevisionCycles),
    attempts: String(limits.maxAttempts),
    timeoutMinutes: String(Math.round(limits.executionTimeoutSeconds / 60)),
    steps,
    prompts: Object.fromEntries(Object.entries(view.prompts).map(([iv, p]) => [iv, p.text])),
  };
}

export interface PatchResult {
  /** The draft patch of changed fields, or null when nothing changed. */
  readonly patch: WorkflowDraftPatch | null;
  /** fieldId → plain-language problem (client bounds); the patch must not be sent while non-empty. */
  readonly errors: Readonly<Record<string, string>>;
}

function sameTypes(a: readonly MemoryType[], b: readonly MemoryType[]): boolean {
  return a.length === b.length && MEMORY_TYPES.every((t) => a.includes(t) === b.includes(t));
}

/**
 * Diffs the form against the version the user started editing (the *base*, not whatever loaded since): only the
 * P0-editable fields the user changed are sent (02 `saveDraft`), so a field changed in another session is never
 * reverted by an untouched field of this form.
 */
export function buildPatch(view: WorkflowVersionView, form: WorkflowForm): PatchResult {
  const errors: Record<string, string> = {};
  const base = initialForm(view);
  const limits: NonNullable<WorkflowDraftPatch['limits']> = {};
  if (form.allowance !== base.allowance) {
    const r = checkAllowance(form.allowance);
    if ('error' in r) errors[WF_FIELD.allowance] = r.error;
    else limits.budgetMicrousd = r.value;
  }
  const whole = (text: string, baseText: string, bounds: { min: number; max: number }, field: string, apply: (n: number) => void) => {
    if (text === baseText) return;
    const r = checkWhole(text, bounds);
    if ('error' in r) errors[field] = r.error;
    else apply(r.value);
  };
  whole(form.revisions, base.revisions, LIMIT_BOUNDS.maxRevisionCycles, WF_FIELD.revisions, (n) => {
    limits.maxRevisionCycles = n;
  });
  whole(form.attempts, base.attempts, LIMIT_BOUNDS.maxAttempts, WF_FIELD.attempts, (n) => {
    limits.maxAttempts = n;
  });
  whole(form.timeoutMinutes, base.timeoutMinutes, LIMIT_BOUNDS.timeoutMinutes, WF_FIELD.timeout, (n) => {
    limits.executionTimeoutSeconds = n * 60;
  });

  type StepEdit = NonNullable<WorkflowDraftPatch['steps']>[StepKey];
  const steps: Record<string, StepEdit> = {};
  for (const s of modelSteps(view)) {
    const f = form.steps[s.id];
    const b = base.steps[s.id];
    if (f === undefined || b === undefined) continue;
    const edit: StepEdit = {};
    if (f.profile !== b.profile) edit.profile = f.profile;
    if (f.maxOutputTokens !== b.maxOutputTokens) {
      if (f.maxOutputTokens.trim() === '') errors[WF_FIELD.maxOutputTokens(s.id)] = 'Enter an output token maximum.';
      else
        whole(f.maxOutputTokens, b.maxOutputTokens, OUTPUT_TOKENS_BOUNDS, WF_FIELD.maxOutputTokens(s.id), (n) => {
          edit.maxOutputTokens = n;
        });
    }
    const retry = { transport: 0, schemaRepair: 0, rateLimitWaits: 0 };
    let retryChanged = false;
    let retryValid = true;
    for (const k of ['transport', 'schemaRepair', 'rateLimitWaits'] as const) {
      if (f[k] !== b[k]) retryChanged = true;
      const r = checkWhole(f[k], RETRY_BOUNDS[k]);
      if ('error' in r) {
        retryValid = false;
        if (f[k] !== b[k]) errors[WF_FIELD[k](s.id)] = r.error;
      } else retry[k] = r.value;
    }
    if (retryChanged && retryValid) edit.retryPolicy = retry;
    if (f.memoryRoles !== b.memoryRoles || !sameTypes(f.memoryTypes, b.memoryTypes)) {
      if (f.memoryTypes.length === 0) errors[WF_FIELD.memoryScope(s.id)] = 'Choose at least one record type.';
      else edit.memoryScope = { roles: f.memoryRoles, types: MEMORY_TYPES.filter((t) => f.memoryTypes.includes(t)) };
    }
    if (Object.keys(edit).length > 0) steps[s.id] = edit;
  }

  const prompts: Record<string, string> = {};
  for (const [iv, text] of Object.entries(form.prompts)) {
    if (text === base.prompts[iv]) continue;
    const owner = modelSteps(view).find((s) => s.instructionVersion === iv);
    if (text.trim() === '') errors[WF_FIELD.prompt(owner?.id ?? iv)] = 'The prompt cannot be empty.';
    else if (text.length > 20_000) errors[WF_FIELD.prompt(owner?.id ?? iv)] = 'Use at most 20,000 characters.';
    else prompts[iv] = text;
  }

  const patch: WorkflowDraftPatch = {
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
    ...(Object.keys(steps).length > 0 ? { steps } : {}),
    ...(Object.keys(prompts).length > 0 ? { prompts } : {}),
  };
  return { patch: Object.keys(patch).length > 0 ? patch : null, errors };
}

const STEP_FIELD_LABELS: Readonly<Record<keyof StepForm, string>> = {
  profile: 'profile',
  maxOutputTokens: 'output token maximum',
  transport: 'transport retries',
  schemaRepair: 'schema repair attempts',
  rateLimitWaits: 'rate-limit waits',
  memoryRoles: 'memory scope',
  memoryTypes: 'memory record types',
};

const LIMIT_FIELD_LABELS = {
  allowance: 'Run allowance',
  revisions: 'Revision cycles',
  attempts: 'Maximum attempts',
  timeoutMinutes: 'Timeout (minutes)',
} as const;

/** One editable field of the form, as text (for field-by-field comparison of two forms). */
export interface FormField {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** Every P0-editable field of a form, in display order. */
function formFields(view: WorkflowVersionView, form: WorkflowForm): FormField[] {
  const out: FormField[] = [];
  for (const k of Object.keys(LIMIT_FIELD_LABELS) as Array<keyof typeof LIMIT_FIELD_LABELS>) {
    out.push({ key: `limits.${k}`, label: LIMIT_FIELD_LABELS[k], value: form[k] });
  }
  for (const s of modelSteps(view)) {
    const f = form.steps[s.id];
    if (f === undefined) continue;
    for (const k of Object.keys(STEP_FIELD_LABELS) as Array<keyof StepForm>) {
      const v = f[k];
      out.push({
        key: `steps.${s.id}.${k}`,
        label: `${stepKeyLabel(s.id)} step: ${STEP_FIELD_LABELS[k]}`,
        value: typeof v === 'string' ? v : MEMORY_TYPES.filter((t) => v.includes(t)).join(', '),
      });
    }
    const prompt = form.prompts[s.instructionVersion];
    if (prompt !== undefined) out.push({ key: `prompts.${s.instructionVersion}`, label: `${stepKeyLabel(s.id)} step: prompt`, value: prompt });
  }
  return out;
}

/** Fields whose values differ between two forms of the same workflow. */
export function changedFields(view: WorkflowVersionView, a: WorkflowForm, b: WorkflowForm): FormField[] {
  const bv = new Map(formFields(view, b).map((f) => [f.key, f.value]));
  return formFields(view, a).filter((f) => bv.get(f.key) !== f.value);
}

/**
 * Re-bases the user's edits onto a newer saved version: a field the user changed (mine ≠ base) keeps the user's
 * value; every other field takes the newer saved value (theirs). Nothing the other session changed is reverted.
 */
export function rebaseForm(base: WorkflowForm, mine: WorkflowForm, theirs: WorkflowForm): WorkflowForm {
  const pick = <T>(b: T, m: T, t: T, same: (x: T, y: T) => boolean = (x, y) => x === y): T => (same(m, b) ? t : m);
  const steps: Record<string, StepForm> = {};
  for (const [id, t] of Object.entries(theirs.steps)) {
    const b = base.steps[id];
    const m = mine.steps[id];
    if (b === undefined || m === undefined) {
      steps[id] = t;
      continue;
    }
    steps[id] = {
      profile: pick(b.profile, m.profile, t.profile),
      maxOutputTokens: pick(b.maxOutputTokens, m.maxOutputTokens, t.maxOutputTokens),
      transport: pick(b.transport, m.transport, t.transport),
      schemaRepair: pick(b.schemaRepair, m.schemaRepair, t.schemaRepair),
      rateLimitWaits: pick(b.rateLimitWaits, m.rateLimitWaits, t.rateLimitWaits),
      memoryRoles: pick(b.memoryRoles, m.memoryRoles, t.memoryRoles),
      memoryTypes: pick(b.memoryTypes, m.memoryTypes, t.memoryTypes, sameTypes),
    };
  }
  const prompts: Record<string, string> = {};
  for (const [iv, t] of Object.entries(theirs.prompts)) {
    const b = base.prompts[iv];
    const m = mine.prompts[iv];
    prompts[iv] = b === undefined || m === undefined ? t : pick(b, m, t);
  }
  return {
    allowance: pick(base.allowance, mine.allowance, theirs.allowance),
    revisions: pick(base.revisions, mine.revisions, theirs.revisions),
    attempts: pick(base.attempts, mine.attempts, theirs.attempts),
    timeoutMinutes: pick(base.timeoutMinutes, mine.timeoutMinutes, theirs.timeoutMinutes),
    steps,
    prompts,
  };
}

/** Where a validation issue points: an editor field and the step it belongs to (both may be null). */
export interface IssueTarget {
  readonly fieldId: string | null;
  readonly stepKey: string | null;
}

/**
 * Maps a validation issue path to its field. Understands spec paths (`steps[3].maxOutputTokens`), draft-patch paths
 * (`steps.implement.retryPolicy.transport`), limits (`limits.maxAttempts`) and prompts (`prompts.reviewer.v1`).
 */
export function issueTarget(view: WorkflowVersionView, path: string): IssueTarget {
  const specStep = /^(?:spec\.)?steps\[(\d+)\](?:\.([A-Za-z]+)(?:\.([A-Za-z]+))?)?/.exec(path);
  const patchStep = /^steps\.([a-z][a-z0-9_-]*)(?:\.([A-Za-z]+)(?:\.([A-Za-z]+))?)?/.exec(path);
  const m = specStep ?? patchStep;
  if (m !== null) {
    const stepKey = specStep === null ? (m[1] ?? null) : (view.spec.steps[Number(m[1])]?.id ?? null);
    if (stepKey === null) return { fieldId: null, stepKey: null };
    const field = m[2];
    const sub = m[3];
    const step = view.spec.steps.find((s) => s.id === stepKey);
    if (step?.kind !== 'model' || field === undefined) return { fieldId: WF_FIELD.step(stepKey), stepKey };
    switch (field) {
      case 'profile':
        return { fieldId: WF_FIELD.profile(stepKey), stepKey };
      case 'maxOutputTokens':
        return { fieldId: WF_FIELD.maxOutputTokens(stepKey), stepKey };
      case 'retryPolicy':
        return {
          fieldId: sub === 'schemaRepair' || sub === 'rateLimitWaits' ? WF_FIELD[sub](stepKey) : WF_FIELD.transport(stepKey),
          stepKey,
        };
      case 'memoryScope':
        return { fieldId: WF_FIELD.memoryScope(stepKey), stepKey };
      case 'instructionVersion':
        return { fieldId: WF_FIELD.prompt(stepKey), stepKey };
      default:
        return { fieldId: WF_FIELD.step(stepKey), stepKey };
    }
  }
  const limit = /^(?:spec\.)?limits\.([A-Za-z]+)/.exec(path);
  if (limit !== null) {
    switch (limit[1] ?? '') {
      case 'budgetMicrousd':
        return { fieldId: WF_FIELD.allowance, stepKey: null };
      case 'maxRevisionCycles':
        return { fieldId: WF_FIELD.revisions, stepKey: null };
      case 'maxAttempts':
        return { fieldId: WF_FIELD.attempts, stepKey: null };
      case 'executionTimeoutSeconds':
        return { fieldId: WF_FIELD.timeout, stepKey: null };
      default:
        return { fieldId: null, stepKey: null };
    }
  }
  const prompt = /^prompts(?:\.|\[")(.+?)(?:"\])?$/.exec(path);
  if (prompt !== null) {
    const owner = modelSteps(view).find((s) => s.instructionVersion === prompt[1]);
    return owner === undefined ? { fieldId: null, stepKey: null } : { fieldId: WF_FIELD.prompt(owner.id), stepKey: owner.id };
  }
  return { fieldId: null, stepKey: null };
}
