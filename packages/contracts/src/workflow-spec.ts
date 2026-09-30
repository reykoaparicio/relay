import { z } from 'zod';
import { MAX_RETRY_POLICY, RETRY_DEFAULTS_PER_STEP } from './defaults.js';
import { workflowLimitsSchema } from './domain/run.js';
import { MODEL_OUTPUT_SCHEMA_IDS } from './outputs/common.js';
import { stepKeySchema } from './primitives.js';
import { MEMORY_TYPES, memoryTypeSchema, roleSchema } from './status.js';

/** §5.3 "retry policy"; §7.6 adjustable within `MAX_RETRY_POLICY`. */
export const retryPolicySchema = z.object({
  transport: z.number().int().min(0).max(MAX_RETRY_POLICY.transport),
  schemaRepair: z.number().int().min(0).max(MAX_RETRY_POLICY.schemaRepair),
  rateLimitWaits: z.number().int().min(0).max(MAX_RETRY_POLICY.rateLimitWaits),
});
/** Retry policy. */
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

/** §5.3 "memory scope": which memory a model step may receive (engine/G1 filter by it). */
export const memoryScopeSchema = z.object({
  roles: z.union([z.literal('step_role'), z.literal('all')]).default('step_role'),
  types: z.array(memoryTypeSchema).default([...MEMORY_TYPES]),
});
/** Memory scope. */
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

/** Synthetic steps the engine inserts around spec steps (06 F15); spec steps may not use these ids. */
export const RESERVED_STEP_KEYS = ['intake', 'finalize'] as const;

/** Approval binding targets (§11.3). */
export const APPROVAL_BIND_TARGETS = ['planHash', 'contextHash'] as const;

/** Model step spec (§12.4). */
export const modelStepSpecSchema = z.object({
  id: stepKeySchema,
  kind: z.literal('model'),
  role: roleSchema,
  profile: z.string(),
  dependsOn: z.array(stepKeySchema).default([]),
  outputSchema: z.enum(MODEL_OUTPUT_SCHEMA_IDS),
  instructionVersion: z.string().regex(/^[a-z-]+\.v\d+$/), // e.g. "reviewer.v1" → templates prompt module
  maxOutputTokens: z.number().int().positive().optional(), // overrides profile.params (§5.3 "output allowance")
  retryPolicy: retryPolicySchema.default({ ...RETRY_DEFAULTS_PER_STEP }),
  memoryScope: memoryScopeSchema.prefault({}),
  allowedTools: z.array(z.never()).max(0).default([]), // §5.3 "allowed tools"; P0 = none (ADR-014)
});

/** Approval step spec (§11.3). */
export const approvalStepSpecSchema = z.object({
  id: stepKeySchema,
  kind: z.literal('approval'),
  dependsOn: z.array(stepKeySchema).min(1),
  bindTo: z.array(z.enum(APPROVAL_BIND_TARGETS)).min(1),
});

/** One workflow step (§12.4). */
export const stepSpecSchema = z.discriminatedUnion('kind', [modelStepSpecSchema, approvalStepSpecSchema]);
/** Step spec. */
export type StepSpec = z.infer<typeof stepSpecSchema>;

/** §12.4 revision policy. */
export const revisionPolicySchema = z.object({
  triggerStep: stepKeySchema,
  triggerOutcome: z.literal('revise'),
  repeatSteps: z.array(stepKeySchema).min(1),
  approvalInvalidation: z.literal('require_new_approval_if_plan_or_scope_changes'),
  onLimit: z.literal('incomplete'),
});

const workflowSpecBaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.number().int().positive(),
  name: z.string().min(1).max(80),
  limits: workflowLimitsSchema,
  steps: z.array(stepSpecSchema).min(1).max(12),
  revisionPolicy: revisionPolicySchema,
});

/** Parsed workflow spec before graph validation (the argument of {@link validateWorkflowGraph}). */
export type WorkflowSpecShape = z.output<typeof workflowSpecBaseSchema>;

/** A graph-level issue with a Zod-style path (e.g. `['steps', 1, 'dependsOn', 0]`). */
export interface WorkflowGraphIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

function stepIndexById(spec: WorkflowSpecShape): Map<string, number> {
  const index = new Map<string, number>();
  spec.steps.forEach((s, i) => {
    if (!index.has(s.id)) index.set(s.id, i);
  });
  return index;
}

function checkIds(spec: WorkflowSpecShape): WorkflowGraphIssue[] {
  const issues: WorkflowGraphIssue[] = [];
  const seen = new Set<string>();
  spec.steps.forEach((s, i) => {
    if ((RESERVED_STEP_KEYS as readonly string[]).includes(s.id)) {
      issues.push({ path: ['steps', i, 'id'], message: `"${s.id}" is reserved for an engine step` });
    }
    if (seen.has(s.id)) {
      issues.push({ path: ['steps', i, 'id'], message: `duplicate step id "${s.id}"` });
    }
    seen.add(s.id);
  });
  return issues;
}

function checkDependencies(spec: WorkflowSpecShape, index: ReadonlyMap<string, number>): WorkflowGraphIssue[] {
  const issues: WorkflowGraphIssue[] = [];
  spec.steps.forEach((s, i) => {
    s.dependsOn.forEach((dep, k) => {
      const j = index.get(dep);
      if (j === undefined) {
        issues.push({ path: ['steps', i, 'dependsOn', k], message: `unknown step "${dep}"` });
      } else if (j > i) {
        issues.push({ path: ['steps', i, 'dependsOn', k], message: `"${dep}" must be an earlier step` });
      }
    });
  });
  return issues;
}

/** Depth-first search reporting each back edge (the dependency that closes a cycle) at its own path. */
function checkCycles(spec: WorkflowSpecShape, index: ReadonlyMap<string, number>): WorkflowGraphIssue[] {
  const issues: WorkflowGraphIssue[] = [];
  const state = new Map<number, 'visiting' | 'done'>();
  const visit = (i: number): void => {
    state.set(i, 'visiting');
    const deps = spec.steps[i]?.dependsOn ?? [];
    deps.forEach((dep, k) => {
      const j = index.get(dep);
      if (j === undefined) return;
      const st = state.get(j);
      if (st === 'visiting') {
        issues.push({ path: ['steps', i, 'dependsOn', k], message: `circular dependency via "${dep}"` });
      } else if (st === undefined) {
        visit(j);
      }
    });
    state.set(i, 'done');
  };
  spec.steps.forEach((_, i) => {
    if (!state.has(i)) visit(i);
  });
  return issues;
}

function checkApprovalBeforeImplementer(spec: WorkflowSpecShape): WorkflowGraphIssue[] {
  const firstImpl = spec.steps.findIndex((s) => s.kind === 'model' && s.role === 'implementer');
  if (firstImpl < 0) return [];
  const hasEarlierApproval = spec.steps.slice(0, firstImpl).some((s) => s.kind === 'approval');
  return hasEarlierApproval
    ? []
    : [{ path: ['steps', firstImpl], message: 'an approval step must precede the first implementer step (FR-08)' }];
}

function checkRevisionPolicy(spec: WorkflowSpecShape, index: ReadonlyMap<string, number>): WorkflowGraphIssue[] {
  const issues: WorkflowGraphIssue[] = [];
  const rp = spec.revisionPolicy;
  const trigger = index.get(rp.triggerStep);
  if (trigger === undefined) {
    issues.push({ path: ['revisionPolicy', 'triggerStep'], message: `unknown step "${rp.triggerStep}"` });
  } else if (spec.steps[trigger]?.kind !== 'model') {
    issues.push({ path: ['revisionPolicy', 'triggerStep'], message: 'the trigger step must be a model step' });
  }
  rp.repeatSteps.forEach((key, k) => {
    const j = index.get(key);
    if (j === undefined) {
      issues.push({ path: ['revisionPolicy', 'repeatSteps', k], message: `unknown step "${key}"` });
    } else if (spec.steps[j]?.kind === 'approval') {
      issues.push({ path: ['revisionPolicy', 'repeatSteps', k], message: 'an approval step cannot be repeated' });
    }
  });
  return issues;
}

/**
 * Pure §5.3 graph checks: unique, non-reserved ids; every `dependsOn` names an existing earlier step; no cycles;
 * an approval precedes the first implementer; the revision policy names existing, non-approval steps.
 * Capability checks need catalog data and live in the engine (06 §F10).
 */
export function collectWorkflowGraphIssues(spec: WorkflowSpecShape): WorkflowGraphIssue[] {
  const index = stepIndexById(spec);
  return [
    ...checkIds(spec),
    ...checkDependencies(spec, index),
    ...checkCycles(spec, index),
    ...checkApprovalBeforeImplementer(spec),
    ...checkRevisionPolicy(spec, index),
  ];
}

/** `superRefine` adapter for {@link collectWorkflowGraphIssues} (field-specific issues, §5.3). */
export function validateWorkflowGraph(spec: WorkflowSpecShape, ctx: z.RefinementCtx): void {
  for (const issue of collectWorkflowGraphIssues(spec)) {
    ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
}

/** §12.4 workflow specification, validated before any import. */
export const workflowSpecSchema = workflowSpecBaseSchema.superRefine(validateWorkflowGraph);
/** Workflow spec. */
export type WorkflowSpec = z.infer<typeof workflowSpecSchema>;
