import { z } from 'zod';
import { MEMORY_LIMITS } from '../defaults.js';
import {
  memoryContentSchema,
  memoryRecordDetailSchema,
  memoryRecordScopeSchema,
  memoryRecordViewSchema,
  memoryTitleSchema,
} from '../domain/memory.js';
import { idSchema } from '../ids.js';
import { epochMsSchema, idempotencyKeySchema, relPathSchema } from '../primitives.js';
import { memoryStatusSchema, memoryTypeSchema } from '../status.js';
import { op } from './common.js';

/** `memory.create` input: user-authored → approved immediately (§10.1). `run_summary` is engine-only (07 G5). */
export const memoryCreateInputSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    projectId: idSchema('project'),
    type: z.enum(['user_rule', 'project_decision', 'source_reference']),
    title: memoryTitleSchema,
    content: memoryContentSchema,
    scope: memoryRecordScopeSchema,
    expiresAt: epochMsSchema.optional(),
    reviewAt: epochMsSchema.optional(),
    pinned: z.boolean().optional(),
    sourceFile: z.object({ relPath: relPathSchema }).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'source_reference' && v.sourceFile === undefined) {
      ctx.addIssue({ code: 'custom', path: ['sourceFile'], message: 'source_reference requires sourceFile' });
    }
  });

/** New content for `memory.resolveConflict` `rewrite` (the UI's "Combine"). */
const rewriteSchema = z.object({
  title: memoryTitleSchema,
  content: memoryContentSchema,
  scope: memoryRecordScopeSchema,
  pinned: z.boolean().optional(),
});

/** `memory.resolveConflict` resolution; the service never auto-merges (§5.5). */
export const memoryResolutionSchema = z.union([
  z.object({ keep: idSchema('memory') }),
  z.object({ rewrite: rewriteSchema }),
  z.object({
    keepBothWithScopes: z.tuple([
      z.object({ recordId: idSchema('memory'), scope: memoryRecordScopeSchema }),
      z.object({ recordId: idSchema('memory'), scope: memoryRecordScopeSchema }),
    ]),
  }),
]);

/** `memory.resolveConflict` input (structural checks here; state rules in 07 G5). */
export const memoryResolveConflictInputSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    recordIds: z.tuple([idSchema('memory'), idSchema('memory')]),
    resolution: memoryResolutionSchema,
  })
  .superRefine((v, ctx) => {
    const [a, b] = v.recordIds;
    if (a === b) {
      ctx.addIssue({ code: 'custom', path: ['recordIds'], message: 'two different records are required' });
    }
    const r = v.resolution;
    if ('keep' in r && r.keep !== a && r.keep !== b) {
      ctx.addIssue({ code: 'custom', path: ['resolution', 'keep'], message: 'must be one of recordIds' });
    }
    if ('keepBothWithScopes' in r) {
      const ids = r.keepBothWithScopes.map((x) => x.recordId);
      if (!ids.includes(a) || !ids.includes(b)) {
        ctx.addIssue({
          code: 'custom',
          path: ['resolution', 'keepBothWithScopes'],
          message: 'must list both recordIds',
        });
      }
    }
  });

/** `memory.*` operations. */
export const memoryOps = {
  'memory.list': op({
    channel: 'relay/v1/memory.list',
    kind: 'query',
    route: 'runner',
    input: z.object({
      projectId: idSchema('project'),
      status: z.array(memoryStatusSchema).optional(),
      type: z.array(memoryTypeSchema).optional(),
      query: z.string().max(MEMORY_LIMITS.queryMax).optional(),
    }),
    output: z.array(memoryRecordViewSchema),
    errors: [],
    idempotent: false,
  }),
  'memory.get': op({
    channel: 'relay/v1/memory.get',
    kind: 'query',
    route: 'runner',
    input: z.object({ recordId: idSchema('memory') }),
    output: memoryRecordDetailSchema,
    errors: ['NOT_FOUND'],
    idempotent: false,
  }),
  'memory.create': op({
    channel: 'relay/v1/memory.create',
    kind: 'command',
    route: 'runner',
    input: memoryCreateInputSchema,
    output: memoryRecordDetailSchema,
    errors: ['VALIDATION_FAILED', 'PERMISSION_DENIED', 'NOT_FOUND'],
    idempotent: true,
  }),
  'memory.update': op({
    channel: 'relay/v1/memory.update',
    kind: 'command',
    route: 'runner',
    input: z.object({
      recordId: idSchema('memory'),
      expectedRevision: z.number().int().positive(),
      title: memoryTitleSchema.optional(),
      content: memoryContentSchema.optional(),
      scope: memoryRecordScopeSchema.optional(),
      expiresAt: epochMsSchema.nullable().optional(),
      reviewAt: epochMsSchema.nullable().optional(),
      pinned: z.boolean().optional(),
      unarchive: z.literal(true).optional(),
    }),
    output: memoryRecordDetailSchema,
    errors: ['CONFLICT', 'VALIDATION_FAILED', 'NOT_FOUND'],
    idempotent: false,
  }),
  'memory.approve': op({
    channel: 'relay/v1/memory.approve',
    kind: 'command',
    route: 'runner',
    input: z.object({
      suggestionId: idSchema('memory'),
      expectedRevision: z.number().int().positive(),
      finalContent: memoryContentSchema.optional(),
      finalTitle: memoryTitleSchema.optional(),
      scope: memoryRecordScopeSchema.optional(),
      pinned: z.boolean().optional(),
    }),
    output: memoryRecordDetailSchema,
    errors: ['CONFLICT', 'VALIDATION_FAILED', 'NOT_FOUND'],
    idempotent: false,
  }),
  'memory.reject': op({
    channel: 'relay/v1/memory.reject',
    kind: 'command',
    route: 'runner',
    input: z.object({ suggestionId: idSchema('memory'), reason: z.string().max(400).optional() }),
    output: z.object({ status: z.literal('rejected') }),
    errors: ['CONFLICT', 'NOT_FOUND'],
    idempotent: false,
  }),
  'memory.archive': op({
    channel: 'relay/v1/memory.archive',
    kind: 'command',
    route: 'runner',
    input: z.object({ recordId: idSchema('memory') }),
    output: memoryRecordDetailSchema,
    errors: ['CONFLICT', 'NOT_FOUND'],
    idempotent: false,
  }),
  'memory.delete': op({
    channel: 'relay/v1/memory.delete',
    kind: 'command',
    route: 'runner',
    input: z.object({ recordId: idSchema('memory'), confirm: z.literal(true) }),
    output: z.object({ deleted: z.literal(true), retainedInRunSnapshots: z.number().int().nonnegative() }),
    errors: ['NOT_FOUND'],
    idempotent: false,
  }),
  'memory.resolveConflict': op({
    channel: 'relay/v1/memory.resolveConflict',
    kind: 'command',
    route: 'runner',
    input: memoryResolveConflictInputSchema,
    output: z.array(memoryRecordViewSchema),
    errors: ['CONFLICT', 'VALIDATION_FAILED', 'NOT_FOUND'],
    idempotent: true,
  }),
  'memory.purgeProjectHistory': op({
    channel: 'relay/v1/memory.purgeProjectHistory',
    kind: 'command',
    route: 'runner',
    input: z.object({ projectId: idSchema('project'), confirmPhrase: z.literal('purge') }),
    output: z.object({
      purgedSnapshots: z.number().int().nonnegative(),
      /** Raw-response / context-manifest files purged (optional: additive in wave 4; the engine always sends it). */
      purgedArtifacts: z.number().int().nonnegative().optional(),
      /** Files whose purge failed; they stay unpurged and the next retention sweep retries them. */
      failed: z.number().int().nonnegative().optional(),
    }),
    errors: ['NOT_FOUND'],
    idempotent: false,
  }),
} as const;
