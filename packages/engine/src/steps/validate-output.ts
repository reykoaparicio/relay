// 06 F8: output validation (§7.7) — observable checks only; model-reported confidence is never used. The Zod parse is
// authoritative for shape; the semantic checks run after it against the run's INPUT SNAPSHOT (never the live disk):
// findings refs exist with in-range lines, plan scope ⊆ input files with 1..12 steps, every patch file ⊆ the approved
// scope and each diff parses AND applies cleanly to the snapshot content, a `revise` review requests changes.
// A failed semantic check is OUTPUT_INVALID with `details.issues` (it counts against schema_repair, F7). A quality
// revision whose patch leaves the approved scope is APPROVAL_STALE(scope_changed) instead (F10 approval reuse rule).
import { applyPatch, parsePatch } from 'diff';
import { errors, toValidationIssues } from '@relay/contracts';
import type { FindingsV1, PatchV1, PlanV1, ReviewV1, SourceRef, ValidationIssue } from '@relay/contracts';
import type { TemplateRegistry } from '@relay/templates';
import type { ModelStepSnapshot } from '../ports.js';
import type { Validation } from '../retry.js';

/**
 * Pre-loaded inputs of the semantic checks (R4-6). `files` maps each input relPath to its snapshot content, or to
 * `null` when only the path is known (a diff-input run names files without providing their bytes).
 */
export interface ValidationInputs {
  readonly files: ReadonlyMap<string, string | null>;
  /** The approved plan's `file_scope_json` for patch steps (null when no approval binds the step). */
  readonly approvedScope: readonly string[] | null;
  /**
   * True for a quality revision under the current approval (`run.revisionCycle > 0`; `resnapshot_and_replan` resets
   * the cycle and binds a new approval): leaving the approved scope invalidates the approval (F10).
   */
  readonly isRevision: boolean;
  /**
   * Input paths whose snapshot bytes exist but could not be read or verified (missing artifact row, unreadable file,
   * sha mismatch). A check that needs their content fails with `snapshot_unavailable` — never accepted unverified.
   */
  readonly unavailable?: ReadonlySet<string>;
}

/** No inputs: Zod only (plus the checks that need no files). */
export const NO_INPUTS: ValidationInputs = { files: new Map(), approvedScope: null, isRevision: false };

/** The plan fixes at most 12 steps (§12.4 / plan.v1). */
const MAX_PLAN_STEPS = 12;

const issue = (path: string, message: string, code: string): ValidationIssue => ({ path, message, code });
/** A path quoted for a message (bounded: issue messages are ≤ 400 chars). */
const q = (p: string): string => `"${p.length > 160 ? `${p.slice(0, 160)}…` : p}"`;

/** The content check of `relPath` cannot run: its snapshot is unreadable or unverifiable (BH-7). */
const unavailableIssue = (path: string, relPath: string): ValidationIssue =>
  issue(path, `The input snapshot of ${q(relPath)} could not be read or verified, so this output cannot be checked against it.`, 'snapshot_unavailable');

function lineCount(content: string): number {
  if (content === '') return 0;
  const lines = content.split('\n').length;
  return content.endsWith('\n') ? lines - 1 : lines;
}

function checkRef(ref: SourceRef, path: string, inputs: ValidationInputs): ValidationIssue[] {
  if (!inputs.files.has(ref.relPath)) return [issue(`${path}.relPath`, `${q(ref.relPath)} is not one of the run's input files.`, 'unknown_file')];
  if (inputs.unavailable?.has(ref.relPath) === true) return [unavailableIssue(`${path}.relPath`, ref.relPath)];
  const content = inputs.files.get(ref.relPath);
  if (content === null || content === undefined) return [];
  const lines = lineCount(content);
  const out: ValidationIssue[] = [];
  if (ref.startLine !== null && ref.startLine > lines) out.push(issue(`${path}.startLine`, `Line ${String(ref.startLine)} is past the end of the file (${String(lines)} lines).`, 'line_out_of_range'));
  if (ref.endLine !== null && ref.endLine > lines) out.push(issue(`${path}.endLine`, `Line ${String(ref.endLine)} is past the end of the file (${String(lines)} lines).`, 'line_out_of_range'));
  if (ref.startLine !== null && ref.endLine !== null && ref.endLine < ref.startLine) {
    out.push(issue(`${path}.endLine`, 'The line range ends before it starts.', 'line_range_inverted'));
  }
  return out;
}

function checkFindings(v: FindingsV1, inputs: ValidationInputs): ValidationIssue[] {
  return [
    ...v.sourceRefs.flatMap((ref, i) => checkRef(ref, `sourceRefs[${String(i)}]`, inputs)),
    ...v.findings.flatMap((f, i) => f.sourceRefs.flatMap((ref, j) => checkRef(ref, `findings[${String(i)}].sourceRefs[${String(j)}]`, inputs))),
  ];
}

function checkPlan(v: PlanV1, inputs: ValidationInputs): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (v.steps.length < 1 || v.steps.length > MAX_PLAN_STEPS) out.push(issue('steps', `A plan has 1 to ${String(MAX_PLAN_STEPS)} steps.`, 'plan_steps_count'));
  v.fileScope.forEach((p, i) => {
    // P0 patches only touch provided files (§11.1), so the plan may only scope input files.
    if (!inputs.files.has(p)) out.push(issue(`fileScope[${String(i)}]`, `${q(p)} is not one of the run's input files.`, 'scope_outside_inputs'));
  });
  return out;
}

const stripPrefix = (name: string | undefined): string | null => {
  if (name === undefined || name === '' || name === '/dev/null') return null;
  return name.replace(/^[ab]\//, '');
};

/** "patch parses" and "applies cleanly" (§7.7) for one file of a patch, against its snapshot content. */
function checkDiff(file: PatchV1['files'][number], path: string, content: string | null): ValidationIssue[] {
  let parsed;
  try {
    parsed = parsePatch(file.unifiedDiff);
  } catch {
    return [issue(`${path}.unifiedDiff`, 'The diff does not parse.', 'diff_unparseable')];
  }
  const [only, ...rest] = parsed;
  if (only === undefined || rest.length > 0 || only.hunks.length === 0) {
    return [issue(`${path}.unifiedDiff`, 'The diff must contain exactly one file with at least one hunk.', 'diff_unparseable')];
  }
  const names = [stripPrefix(only.oldFileName), stripPrefix(only.newFileName)].filter((n): n is string => n !== null);
  if (names.some((n) => n !== file.relPath)) return [issue(`${path}.unifiedDiff`, 'The diff header names a different file.', 'diff_file_mismatch')];
  if (content === null) return [];
  return applyPatch(content, only) === false ? [issue(`${path}.unifiedDiff`, 'The diff does not apply cleanly to the input file.', 'diff_does_not_apply')] : [];
}

function checkPatch(v: PatchV1, inputs: ValidationInputs): { issues: ValidationIssue[]; outsideScope: string[] } {
  const issues: ValidationIssue[] = [];
  const outsideScope: string[] = [];
  const seen = new Set<string>();
  v.files.forEach((f, i) => {
    const path = `files[${String(i)}]`;
    if (!inputs.files.has(f.relPath)) {
      issues.push(issue(`${path}.relPath`, `${q(f.relPath)} is not one of the run's input files.`, 'unknown_file'));
      return;
    }
    // Two diffs for one file would each apply to the snapshot alone, never to each other's result.
    if (seen.has(f.relPath)) {
      issues.push(issue(`${path}.relPath`, `${q(f.relPath)} appears more than once; put all its changes in one diff.`, 'duplicate_file'));
      return;
    }
    seen.add(f.relPath);
    if (inputs.approvedScope !== null && !inputs.approvedScope.includes(f.relPath)) outsideScope.push(f.relPath);
    if (inputs.unavailable?.has(f.relPath) === true) {
      issues.push(unavailableIssue(`${path}.unifiedDiff`, f.relPath));
      return;
    }
    issues.push(...checkDiff(f, path, inputs.files.get(f.relPath) ?? null));
  });
  return { issues, outsideScope };
}

function checkReview(v: ReviewV1): ValidationIssue[] {
  return v.outcome === 'revise' && v.requestedChanges.length < 1
    ? [issue('requestedChanges', 'A "revise" verdict must request at least one change.', 'revise_without_changes')]
    : [];
}

function semanticIssues(schema: ModelStepSnapshot['outputSchema'], value: unknown, inputs: ValidationInputs): Validation | ValidationIssue[] {
  switch (schema) {
    case 'findings.v1':
      return checkFindings(value as FindingsV1, inputs);
    case 'plan.v1':
      return checkPlan(value as PlanV1, inputs);
    case 'review.v1':
      return checkReview(value as ReviewV1);
    case 'patch.v1': {
      const { issues, outsideScope } = checkPatch(value as PatchV1, inputs);
      if (issues.length > 0 || outsideScope.length === 0) return issues;
      // Outside the approved scope: a first implementation violated the approved plan (OUTPUT_INVALID, repairable);
      // a quality revision that widens the scope needs a new approval (§12.4 approval reuse rule).
      if (inputs.isRevision) return { ok: false, error: errors.approvalStale('scope_changed', { details: { outsideScope } }) };
      return outsideScope.map((p) => issue('files', `${q(p)} is outside the approved file scope.`, 'outside_approved_scope'));
    }
  }
}

/**
 * Pure and synchronous: parses `json` with the step's contracts output schema, then runs the semantic checks
 * against the pre-loaded input snapshot (`inputs`).
 */
export function validateOutput(
  stepSnap: Pick<ModelStepSnapshot, 'outputSchema'>,
  json: unknown,
  templates: Pick<TemplateRegistry, 'schema'>,
  inputs: ValidationInputs = NO_INPUTS,
): Validation {
  if (json === undefined) {
    return { ok: false, error: errors.outputInvalid([{ path: '', message: 'The response is not valid JSON.', code: 'invalid_json' }]) };
  }
  const parsed = templates.schema(stepSnap.outputSchema).safeParse(json);
  if (!parsed.success) return { ok: false, error: errors.outputInvalid(toValidationIssues(parsed.error.issues)) };
  const semantic = semanticIssues(stepSnap.outputSchema, parsed.data, inputs);
  if (!Array.isArray(semantic)) return semantic;
  return semantic.length === 0 ? { ok: true, value: parsed.data } : { ok: false, error: errors.outputInvalid(semantic) };
}
