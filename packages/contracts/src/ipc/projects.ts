import { z } from 'zod';
import { RATE_LIMITS } from '../defaults.js';
import {
  exclusionsSchema,
  projectDetailSchema,
  projectSchema,
  providerOptionsSchema,
} from '../domain/project.js';
import { previewResultSchema } from '../domain/views.js';
import { idSchema } from '../ids.js';
import { nonNegativeMicrousdSchema } from '../money.js';
import { epochMsSchema, idempotencyKeySchema } from '../primitives.js';
import { providerIdSchema } from '../status.js';
import { emptyInputSchema, exportResultSchema, op } from './common.js';

/** A directory selection token; main keeps the realpath privately (08 H4). */
export const directorySelectionSchema = z.object({
  selectionId: idSchema('selection'),
  displayPath: z.string(),
  expiresAt: epochMsSchema,
});
/** Directory selection. */
export type DirectorySelection = z.infer<typeof directorySelectionSchema>;

/** `projects.update` patch. A changed allowance re-evaluates `paused(budget_project)` runs (06). */
export const projectPatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  exclusions: exclusionsSchema.optional(),
  allowedProviderIds: z.array(providerIdSchema).optional(),
  providerOptions: providerOptionsSchema.optional(),
  monthlyAllowanceMicrousd: nonNegativeMicrousdSchema.nullable().optional(),
});

/** `projects.*` operations. */
export const projectOps = {
  'projects.pickDirectory': op({
    channel: 'relay/v1/projects.pickDirectory',
    kind: 'command',
    route: 'main',
    input: emptyInputSchema,
    output: z.object({ selection: directorySelectionSchema.nullable() }),
    errors: ['PERMISSION_DENIED'],
    idempotent: false,
  }),
  'projects.previewFiles': op({
    channel: 'relay/v1/projects.previewFiles',
    kind: 'query',
    route: 'main+runner',
    input: z
      .union([z.object({ selectionId: idSchema('selection') }), z.object({ projectId: idSchema('project') })])
      .and(z.object({ extraExclusions: exclusionsSchema.optional() })),
    output: previewResultSchema,
    errors: ['NOT_FOUND', 'PERMISSION_DENIED'],
    idempotent: false,
  }),
  'projects.create': op({
    channel: 'relay/v1/projects.create',
    kind: 'command',
    route: 'main+runner',
    input: z.object({
      idempotencyKey: idempotencyKeySchema,
      selectionId: idSchema('selection'),
      name: z.string().min(1).max(80),
      exclusions: exclusionsSchema.optional(),
      allowedProviderIds: z.array(providerIdSchema),
      monthlyAllowanceMicrousd: nonNegativeMicrousdSchema.nullable().optional(),
    }),
    output: projectSchema,
    errors: ['VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT', 'PERMISSION_DENIED'],
    idempotent: true,
  }),
  'projects.list': op({
    channel: 'relay/v1/projects.list',
    kind: 'query',
    route: 'runner',
    input: z.object({ includeArchived: z.boolean().optional() }),
    output: z.array(projectSchema),
    errors: [],
    idempotent: false,
  }),
  'projects.get': op({
    channel: 'relay/v1/projects.get',
    kind: 'query',
    route: 'runner',
    input: z.object({ projectId: idSchema('project') }),
    output: projectDetailSchema,
    errors: ['NOT_FOUND'],
    idempotent: false,
  }),
  'projects.update': op({
    channel: 'relay/v1/projects.update',
    kind: 'command',
    route: 'runner',
    input: z.object({
      projectId: idSchema('project'),
      expectedUpdatedAt: epochMsSchema,
      patch: projectPatchSchema,
    }),
    output: projectSchema,
    errors: ['CONFLICT', 'VALIDATION_FAILED', 'NOT_FOUND'],
    idempotent: false,
  }),
  'projects.archive': op({
    channel: 'relay/v1/projects.archive',
    kind: 'command',
    route: 'runner',
    input: z.object({ projectId: idSchema('project') }),
    output: projectSchema,
    errors: ['CONFLICT', 'NOT_FOUND'],
    idempotent: false,
  }),
  'projects.export': op({
    channel: 'relay/v1/projects.export',
    kind: 'command',
    route: 'main+runner',
    input: z.object({ projectId: idSchema('project'), runIds: z.array(idSchema('run')).optional() }),
    output: exportResultSchema,
    errors: ['ARTIFACT_WRITE_FAILED', 'PERMISSION_DENIED', 'NOT_FOUND'],
    idempotent: false,
    rateLimit: RATE_LIMITS.dialog,
  }),
  'projects.createSample': op({
    channel: 'relay/v1/projects.createSample',
    kind: 'command',
    route: 'main+runner',
    input: z.object({ idempotencyKey: idempotencyKeySchema }),
    output: projectSchema,
    errors: ['ARTIFACT_WRITE_FAILED', 'CONFLICT', 'PERMISSION_DENIED'],
    idempotent: true,
  }),
} as const;
