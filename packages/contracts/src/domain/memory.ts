import { z } from 'zod';
import { MEMORY_LIMITS } from '../defaults.js';
import { idBodyPattern, idSchema } from '../ids.js';
import { sourceRefSchema } from '../outputs/common.js';
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
  .regex(new RegExp(`^(user|run:${idBodyPattern('run')})$`), 'user or run:<runId>');

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
  /**
   * E2 #16: when the user last confirmed the record ("Confirm still accurate" → a `reviewed` event); null = never.
   * Optional (additive): older runners omit it.
   */
  lastReviewedAt: epochMsSchema.nullable().optional(),
  /**
   * E2 #16: review is due — `reviewAt` has passed and no review happened since it was set (based on the last
   * `reviewed` / review-date change, not `updatedAt`, so an unrelated edit no longer hides a due review).
   */
  reviewDue: z.boolean().optional(),
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
      /** E2 #17: runs whose snapshot used exactly this revision (optional, additive). */
      usedByRuns: z.number().int().nonnegative().optional(),
    }),
  ),
  events: z.array(
    z.object({
      event: memoryEventTypeSchema,
      revision: z.number().int().positive(),
      actor: memoryActorSchema,
      createdAt: epochMsSchema,
      /**
       * E2 #17 (audit trail, optional): the event's stored detail, e.g. `{ reason }` (reject), `{ supersededById }`
       * (archive by a resolution), `{ resolution, with }`, `{ runId, status }` (skipped), `{ refs }` (reviewed).
       */
      detail: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
  ),
  usedByRuns: z.number().int().nonnegative(),
  proposal: z
    .object({
      rationale: z.string(),
      suggestedScope: memoryRecordScopeSchema,
      conflictsWith: z.array(idSchema('memory')),
      /** E2 #17: the proposing step's source references (file + lines), so the user can check the evidence. */
      sourceRefs: z.array(sourceRefSchema).max(10).optional(),
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
