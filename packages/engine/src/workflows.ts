// 06 F14: workflow drafts, validation, and publishing (§5.3 "Save creates a draft revision. Running snapshots a
// validated revision"). The P0 draft patch edits prompts, profile names, limits, maxOutputTokens, retry policy, and
// memory scope only; structure is P1 (`structural_edit_p1`). Validation = the contracts graph checks + the catalog /
// credential / budget checks that need engine data, each issue carrying a field path (`steps[3].maxOutputTokens`).
import { MAX_RETRY_POLICY, err, errors, ok, toValidationIssues, upperBound, workflowSpecSchema } from '@relay/contracts';
import type {
  CapabilityWarning,
  EpochMs,
  Result,
  StepSpec,
  ValidationIssue,
  WorkflowDraftPatch,
  WorkflowId,
  WorkflowSpec,
  WorkflowValidationResult,
  WorkflowVersionView,
} from '@relay/contracts';
import type { Repos, WorkflowVersionRow } from '@relay/storage';
import { requestHash } from './hash.js';
import type { EngineCtx } from './ports.js';
import { checkProfile, findProfileByName, profileWarningMessage } from './profiles.js';
import { workflowContentHash } from './seed.js';

const issue = (path: string, message: string, code: string): ValidationIssue => ({ path, message, code });
const reasonOf = (v: unknown): string => (typeof v === 'string' ? v : 'model_unsupported');

/** `workflows.get` view of a version row. */
export function toWorkflowView(version: WorkflowVersionRow): WorkflowVersionView {
  const prompts: WorkflowVersionView['prompts'] = {};
  for (const s of version.spec.steps) {
    const text = s.kind === 'model' ? version.prompts[s.instructionVersion] : undefined;
    if (s.kind === 'model' && text !== undefined) prompts[s.instructionVersion] = { instructionVersion: s.instructionVersion, role: s.role, text };
  }
  return {
    workflowId: version.workflowId,
    version: version.status === 'draft' ? 'draft' : version.version,
    status: version.status,
    draftRevision: version.status === 'draft' ? version.draftRevision : null,
    spec: version.spec,
    contentHash: version.contentHash,
    prompts,
    editable: { prompts: true, profiles: true, limits: true, maxOutputTokens: true, retryPolicy: true, memoryScope: true, structure: false },
  };
}

// ---------------------------------------------------------------- saveDraft

/** Applies a P0 patch to `base` (pure). Unknown / approval step keys and unused prompt keys are `structural_edit_p1`. */
export function applyDraftPatch(
  base: { readonly spec: WorkflowSpec; readonly prompts: Readonly<Record<string, string>> },
  patch: WorkflowDraftPatch,
): Result<{ spec: WorkflowSpec; prompts: Record<string, string> }> {
  const issues: ValidationIssue[] = [];
  const modelVersions = new Set(base.spec.steps.flatMap((s) => (s.kind === 'model' ? [s.instructionVersion] : [])));
  for (const key of Object.keys(patch.prompts ?? {})) {
    if (!modelVersions.has(key)) issues.push(issue(`prompts.${key}`, 'No step uses this instruction version.', 'structural_edit_p1'));
  }
  const edits = patch.steps ?? {};
  for (const key of Object.keys(edits)) {
    const step = base.spec.steps.find((s) => s.id === key);
    if (step?.kind !== 'model') issues.push(issue(`steps.${key}`, 'Only existing model steps can be edited (structure is P1).', 'structural_edit_p1'));
  }
  if (issues.length > 0) return err(errors.validationFailed(issues));
  const steps = base.spec.steps.map((s): StepSpec => {
    const e = edits[s.id];
    if (s.kind !== 'model' || e === undefined) return s;
    return { ...s, ...(e.profile === undefined ? {} : { profile: e.profile }), ...(e.maxOutputTokens === undefined ? {} : { maxOutputTokens: e.maxOutputTokens }),
      ...(e.retryPolicy === undefined ? {} : { retryPolicy: e.retryPolicy }), ...(e.memoryScope === undefined ? {} : { memoryScope: e.memoryScope }) };
  });
  const candidate = { ...base.spec, limits: { ...base.spec.limits, ...(patch.limits ?? {}) }, steps };
  const parsed = workflowSpecSchema.safeParse(candidate);
  if (!parsed.success) return err(errors.validationFailed(toValidationIssues(parsed.error.issues)));
  return ok({ spec: parsed.data, prompts: { ...base.prompts, ...(patch.prompts ?? {}) } });
}

/** Parsed `workflows.saveDraft` input. */
export interface SaveDraftInput {
  readonly workflowId: WorkflowId;
  readonly expectedDraftRevision: number;
  readonly patch: WorkflowDraftPatch;
}

/** `workflows.saveDraft`: creates the draft from the latest validated version (revision 0 → 1) or updates it (CAS). */
export function saveDraft(ctx: EngineCtx, input: SaveDraftInput): Result<WorkflowVersionView> {
  return ctx.db.tx('immediate', (r): Result<WorkflowVersionView> => {
    if (r.workflows.getWorkflow(input.workflowId) === undefined) return err(errors.notFound('workflow'));
    const draft = r.workflows.getVersion(input.workflowId, 'draft');
    if (input.expectedDraftRevision === 0 && draft !== undefined) return err(errors.conflict({ reason: 'draft_exists', draftRevision: draft.draftRevision }));
    if (input.expectedDraftRevision > 0 && draft === undefined) return err(errors.notFound('workflow_draft'));
    const base = draft ?? r.workflows.latestValidated(input.workflowId);
    if (base === undefined) return err(errors.notFound('workflow_version'));
    const applied = applyDraftPatch(base, input.patch);
    if (!applied.ok) return applied;
    const { spec, prompts } = applied.value;
    const contentHash = workflowContentHash(spec, prompts);
    if (draft !== undefined) {
      const updated = r.workflows.updateDraft(input.workflowId, { spec, prompts, contentHash }, input.expectedDraftRevision);
      return updated.ok ? ok(toWorkflowView(updated.value)) : updated;
    }
    const inserted = r.workflows.insertVersion({
      id: ctx.ids.next('workflowVersion'), workflowId: input.workflowId, version: base.version + 1, status: 'draft',
      schemaVersion: spec.schemaVersion, spec, prompts, contentHash, basedOnVersion: base.version, createdAt: ctx.clock.now(),
    });
    return ok(toWorkflowView(inserted));
  });
}

// ---------------------------------------------------------------- validate

function stepWarnings(r: Repos, stepKey: StepSpec['id'], providerId: Parameters<Repos['credentials']['get']>[0]): CapabilityWarning[] {
  return r.credentials.get(providerId) === undefined
    ? [{ stepKey, profileId: null, code: 'missing_credential', message: profileWarningMessage('missing_credential') }]
    : [];
}

async function modelStepIssues(ctx: EngineCtx, s: StepSpec & { kind: 'model' }, i: number, prompts: Readonly<Record<string, string>>) {
  const r = ctx.db.repos;
  const path = `steps[${String(i)}]`;
  const issues: ValidationIssue[] = [];
  const warnings: CapabilityWarning[] = [];
  if (prompts[s.instructionVersion] === undefined) issues.push(issue(`${path}.instructionVersion`, 'No prompt text for this instruction version.', 'prompt_missing'));
  for (const k of ['transport', 'schemaRepair', 'rateLimitWaits'] as const) {
    if (s.retryPolicy[k] > MAX_RETRY_POLICY[k]) issues.push(issue(`${path}.retryPolicy.${k}`, `At most ${String(MAX_RETRY_POLICY[k])}.`, 'retry_policy_too_high'));
  }
  const row = findProfileByName(r, s.profile);
  if (row === undefined) return { issues: [...issues, issue(`${path}.profile`, `No profile named "${s.profile.slice(0, 40)}".`, 'unknown_profile')], warnings, upper: null };
  const entry = r.catalog.get(row.providerId, row.modelId);
  let caps = entry?.capabilities;
  try {
    caps = await ctx.providers.get(row.providerId).capabilities(row.modelId);
  } catch {
    // no adapter: the catalog snapshot decides (fail closed below when the catalog does not know the model)
  }
  const checked = checkProfile(row, entry, caps);
  if (!checked.ok) issues.push(issue(`${path}.profile`, checked.error.userMessage, reasonOf(checked.error.details?.['reason'])));
  const maxOut = s.maxOutputTokens ?? row.params.maxOutputTokens;
  if (caps?.maxOutputTokens !== undefined && maxOut > caps.maxOutputTokens) {
    issues.push(issue(`${path}.maxOutputTokens`, `This model returns at most ${String(caps.maxOutputTokens)} output tokens.`, 'output_budget_low'));
  }
  warnings.push(...stepWarnings(r, s.id, row.providerId));
  const upper = entry === undefined ? null : upperBound(0, maxOut, entry.prices);
  return { issues, warnings, upper };
}

/** F14 validation of a spec + prompts (graph, catalog, credentials as warnings, budget vs the first step). */
export async function validateSpec(ctx: EngineCtx, spec: WorkflowSpec, prompts: Readonly<Record<string, string>>): Promise<WorkflowValidationResult> {
  const parsed = workflowSpecSchema.safeParse(spec);
  if (!parsed.success) return { valid: false, issues: toValidationIssues(parsed.error.issues), warnings: [] };
  const issues: ValidationIssue[] = [];
  const warnings: CapabilityWarning[] = [];
  let firstUpper: number | null = null;
  for (const [i, s] of parsed.data.steps.entries()) {
    if (s.kind !== 'model') continue;
    const res = await modelStepIssues(ctx, s, i, prompts);
    issues.push(...res.issues);
    warnings.push(...res.warnings);
    firstUpper ??= res.upper;
  }
  const budget = parsed.data.limits.budgetMicrousd;
  if (budget !== undefined && firstUpper !== null && firstUpper > budget) {
    // §5.3 "impossible token budgets": the allowance cannot even reserve the first step's output.
    issues.push(issue('limits.budgetMicrousd', 'The run allowance cannot cover the first step.', 'budget_too_small'));
  }
  return { valid: issues.length === 0, issues, warnings };
}

/** `workflows.validate`. */
export async function validateWorkflow(ctx: EngineCtx, input: { readonly workflowId: WorkflowId; readonly version: number | 'draft' }): Promise<Result<WorkflowValidationResult>> {
  const version = ctx.db.repos.workflows.getVersion(input.workflowId, input.version);
  if (version === undefined) return err(errors.notFound('workflow_version'));
  return ok(await validateSpec(ctx, version.spec, version.prompts));
}

/** `workflows.publish`: the draft → an immutable validated version (only when validation passes). */
export async function publishWorkflow(ctx: EngineCtx, input: { readonly idempotencyKey: string; readonly workflowId: WorkflowId }): Promise<Result<WorkflowVersionView>> {
  const OP = 'workflows.publish';
  const hash = requestHash({ ...input });
  const replay = (r: Repos): Result<WorkflowVersionView> | null => {
    const stored = r.idempotency.get(OP, input.idempotencyKey);
    if (stored === undefined) return null;
    if (stored.requestHash !== hash) return err(errors.conflict({ reason: 'idempotency_key_reused', op: OP }));
    const v = r.workflows.getVersionById(stored.result.ids['workflowVersionId'] as WorkflowVersionRow['id']);
    return v === undefined ? err(errors.notFound('workflow_version')) : ok(toWorkflowView(v));
  };
  const early = replay(ctx.db.repos);
  if (early !== null) return early;
  const draft = ctx.db.repos.workflows.getVersion(input.workflowId, 'draft');
  if (draft === undefined) return err(errors.notFound('workflow_draft'));
  const result = await validateSpec(ctx, draft.spec, draft.prompts);
  if (!result.valid) return err(errors.validationFailed(result.issues));
  return ctx.db.tx('immediate', (r): Result<WorkflowVersionView> => {
    const again = replay(r);
    if (again !== null) return again;
    const now: EpochMs = ctx.clock.now();
    const cur = r.workflows.getVersionById(draft.id);
    if (cur?.status !== 'draft' || cur.draftRevision !== draft.draftRevision || !r.workflows.markValidated(draft.id, now)) {
      return err(errors.conflict({ reason: 'draft_changed' }));
    }
    r.idempotency.put(OP, input.idempotencyKey, hash, { ids: { workflowVersionId: draft.id }, status: 'validated' });
    const published = r.workflows.getVersionById(draft.id);
    return published === undefined ? err(errors.notFound('workflow_version')) : ok(toWorkflowView(published));
  });
}
