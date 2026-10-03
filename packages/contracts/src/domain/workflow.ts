import { z } from 'zod';
import { idSchema } from '../ids.js';
import { sha256Schema, stepKeySchema } from '../primitives.js';
import { roleSchema } from '../status.js';
import { validationIssueSchema } from '../validation.js';
import { memoryScopeSchema, retryPolicySchema, stepNameSchema, workflowSpecSchema } from '../workflow-spec.js';
import { workflowLimitsSchema } from './run.js';

/** A workflow version selector: a validated version number or the editable draft. */
export const workflowVersionSelectorSchema = z.union([z.number().int().positive(), z.literal('draft')]);

/** `workflows.list` row. */
export const workflowSummarySchema = z.object({
  id: idSchema('workflow'),
  name: z.string(),
  latestValidatedVersion: z.number().int().nullable(),
  draftVersion: z.number().int().nullable(),
});
/** Workflow summary. */
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

/** Capability warning codes (engine checks against catalog + credentials, 06 F10/F14). */
export const CAPABILITY_WARNING_CODES = [
  'structured_output_unsupported',
  'effort_unsupported',
  'output_budget_low',
  'input_budget_low',
  'missing_credential',
  'provider_not_allowed',
  'model_unknown',
] as const;

/** A capability warning for a step or profile. */
export const capabilityWarningSchema = z.object({
  stepKey: stepKeySchema.nullable(),
  profileId: idSchema('profile').nullable(),
  code: z.enum(CAPABILITY_WARNING_CODES),
  message: z.string().max(400),
});
/** Capability warning. */
export type CapabilityWarning = z.infer<typeof capabilityWarningSchema>;

/** One versioned prompt of a workflow version, keyed by instruction version. */
export const workflowPromptSchema = z.object({
  instructionVersion: z.string(),
  role: roleSchema,
  text: z.string(),
});

/** `workflows.get` output. Structural edits are P1 (§5.3), so `editable.structure` is always false. */
export const workflowVersionViewSchema = z.object({
  workflowId: idSchema('workflow'),
  version: workflowVersionSelectorSchema,
  status: z.enum(['draft', 'validated']),
  draftRevision: z.number().int().positive().nullable(),
  spec: workflowSpecSchema,
  contentHash: sha256Schema,
  prompts: z.record(z.string(), workflowPromptSchema),
  editable: z.object({
    prompts: z.boolean(),
    profiles: z.boolean(),
    limits: z.boolean(),
    maxOutputTokens: z.boolean(),
    retryPolicy: z.boolean(),
    memoryScope: z.boolean(),
    structure: z.literal(false),
  }),
});
/** Workflow version view. */
export type WorkflowVersionView = z.infer<typeof workflowVersionViewSchema>;

/** P0-editable draft fields only; any other key is rejected (`structural_edit_p1`, §5.3). */
export const workflowDraftPatchSchema = z
  .object({
    prompts: z.record(z.string(), z.string().min(1).max(20_000)).optional(), // instructionVersion → text
    limits: workflowLimitsSchema.optional(),
    steps: z
      .record(
        stepKeySchema,
        z
          .object({
            name: stepNameSchema.optional(), // any step kind (model or approval)
            profile: z.string().min(1).max(40).optional(),
            maxOutputTokens: z.number().int().positive().optional(),
            retryPolicy: retryPolicySchema.optional(),
            memoryScope: memoryScopeSchema.optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
/** Workflow draft patch. */
export type WorkflowDraftPatch = z.infer<typeof workflowDraftPatchSchema>;

/** `workflows.validate` output (§5.3 field-specific errors and capability warnings). */
export const workflowValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(validationIssueSchema),
  warnings: z.array(capabilityWarningSchema),
});
/** Workflow validation result. */
export type WorkflowValidationResult = z.infer<typeof workflowValidationResultSchema>;
