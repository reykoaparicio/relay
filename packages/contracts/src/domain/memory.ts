import { z } from 'zod';
import { MEMORY_LIMITS } from '../defaults.js';
import { idSchema } from '../ids.js';
import { epochMsSchema, relPathSchema, sha256Schema } from '../primitives.js';
import { memoryEventTypeSchema, memoryStatusSchema, memoryTypeSchema, roleSchema } from '../status.js';

/** Memory title (07 G5: ≤ 120 chars). */
export const memoryTitleSchema = z.string().min(1).max(MEMORY_LIMITS.titleMax);
/** Memory content (07 G5: ≤ 4000 chars; longer knowledge belongs in a `source_reference`). */
export const memoryContentSchema = z.string().min(1).max(MEMORY_LIMITS.contentMax);

/** Which roles a memory record applies to (03 `memory_records.scope_json`). */
export const memoryRecordScopeSchema = z.object({
  roles: z.union([z.array(roleSchema).min(1), z.literal('all')]),
});
/** Memory record scope. */
export type MemoryRecordScope = z.infer<typeof memoryRecordScopeSchema>;

/** Actor/author of a memory revision or event: `user` or `run:<runId>`. */
export const memoryActorSchema = z
  .string()
  .regex(/^(user|run:run_[0-9A-HJKMNP-TV-Z]{26})$/, 'user or run:<runId>');

/** Where a memory record came from. */
export const memorySourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('run'), runId: idSchema('run'), artifactId: idSchema('artifact').optional() }),
  z.object({ kind: z.literal('file'), relPath: relPathSchema }),
]);
/** Memory source. */
export type MemorySource = z.infer<typeof memorySourceSchema>;

/** A revision's source reference (03 `memory_revisions.source_refs_json`). */
export const memorySourceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), relPath: relPathSchema, sha256: sha256Schema }),
  z.object({ kind: z.literal('run'), runId: idSchema('run'), artifactId: idSchema('artifact').nullable() }),
]);
/** Memory source reference. */
export type MemorySourceRef = z.infer<typeof memorySourceRefSchema>;

/** §5.5 memory list row. `superseded` is `status='archived'` + `supersededById` (§10.4). */
export const memoryRecordViewSchema = z.object({
  id: idSchema('memory'),
  projectId: idSchema('project'),
  type: memoryTypeSchema,
  status: memoryStatusSchema,
  title: z.string(),
  excerpt: z.string(),
  scope: memoryRecordScopeSchema,
  pinned: z.boolean(),
  currentRevision: z.number().int().positive(),
  source: memorySourceSchema,
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
  expiresAt: epochMsSchema.nullable(),
  reviewAt: epochMsSchema.nullable(),
  supersededById: idSchema('memory').nullable(),
  stale: z.boolean(),
  conflictsWith: z.array(idSchema('memory')),
});
/** Memory record view. */
export type MemoryRecordView = z.infer<typeof memoryRecordViewSchema>;

/** §5.5 memory detail: all revisions, events, usage, and the proposal of a suggestion. */
export const memoryRecordDetailSchema = memoryRecordViewSchema.extend({
  content: z.string(),
  revisions: z.array(
    z.object({
      revision: z.number().int().positive(),
      title: z.string(),
      content: z.string(),
      author: memoryActorSchema,
      createdAt: epochMsSchema,
      sourceRefs: z.array(memorySourceRefSchema),
    }),
  ),
  events: z.array(
    z.object({
      event: memoryEventTypeSchema,
      revision: z.number().int().positive(),
      actor: memoryActorSchema,
      createdAt: epochMsSchema,
    }),
  ),
  usedByRuns: z.number().int().nonnegative(),
  proposal: z
    .object({
      rationale: z.string(),
      suggestedScope: memoryRecordScopeSchema,
      conflictsWith: z.array(idSchema('memory')),
    })
    .optional(),
});
/** Memory record detail. */
export type MemoryRecordDetail = z.infer<typeof memoryRecordDetailSchema>;

/** Compact memory reference (run preflight summary). */
export const memoryRefSchema = z.object({
  id: idSchema('memory'),
  revision: z.number().int().positive(),
  type: memoryTypeSchema,
  title: z.string(),
  pinned: z.boolean(),
});
/** Memory reference. */
export type MemoryRef = z.infer<typeof memoryRefSchema>;
