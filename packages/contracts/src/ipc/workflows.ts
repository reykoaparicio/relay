import { z } from 'zod';
import {
  workflowDraftPatchSchema,
  workflowSummarySchema,
  workflowValidationResultSchema,
  workflowVersionSelectorSchema,
  workflowVersionViewSchema,
} from '../domain/workflow.js';
import { idSchema } from '../ids.js';
import { idempotencyKeySchema } from '../primitives.js';
import { emptyInputSchema, op } from './common.js';

/** `workflows.*` operations. */
export const workflowOps = {
  'workflows.list': op({
    channel: 'relay/v1/workflows.list',
    kind: 'query',
    route: 'runner',
    input: emptyInputSchema,
    output: z.array(workflowSummarySchema),
    errors: [],
    idempotent: false,
  }),
  'workflows.get': op({
    channel: 'relay/v1/workflows.get',
    kind: 'query',
    route: 'runner',
    input: z.object({ workflowId: idSchema('workflow'), version: workflowVersionSelectorSchema.optional() }),
    output: workflowVersionViewSchema,
    errors: ['NOT_FOUND'],
    idempotent: false,
  }),
  'workflows.saveDraft': op({
    channel: 'relay/v1/workflows.saveDraft',
    kind: 'command',
    route: 'runner',
    input: z.object({
      workflowId: idSchema('workflow'),
      expectedDraftRevision: z.number().int().nonnegative(), // 0 = no draft exists yet
      patch: workflowDraftPatchSchema,
    }),
    output: workflowVersionViewSchema,
    errors: ['VALIDATION_FAILED', 'CONFLICT', 'NOT_FOUND'],
    idempotent: false,
  }),
  'workflows.validate': op({
    channel: 'relay/v1/workflows.validate',
    kind: 'query',
    route: 'runner',
    input: z.object({ workflowId: idSchema('workflow'), version: workflowVersionSelectorSchema }),
    output: workflowValidationResultSchema,
    errors: ['NOT_FOUND'],
    idempotent: false,
  }),
  'workflows.publish': op({
    channel: 'relay/v1/workflows.publish',
    kind: 'command',
    route: 'runner',
    input: z.object({ idempotencyKey: idempotencyKeySchema, workflowId: idSchema('workflow') }),
    output: workflowVersionViewSchema,
    errors: ['VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT'],
    idempotent: true,
  }),
} as const;
