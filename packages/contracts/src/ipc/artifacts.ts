import { z } from 'zod';
import { ARTIFACT_INLINE_MAX_BYTES, RATE_LIMITS } from '../defaults.js';
import { artifactContentSchema, artifactMetaSchema } from '../domain/artifact.js';
import { idSchema } from '../ids.js';
import { op } from './common.js';

/** What `artifacts.export` writes. */
export const EXPORT_WHAT = ['report', 'patch', 'both'] as const;
/** Schema for {@link ExportWhat}. */
export const exportWhatSchema = z.enum(EXPORT_WHAT);
/** Export selection. */
export type ExportWhat = z.infer<typeof exportWhatSchema>;

/** Result of importing a `.diff` / `.patch` (ADR-015). */
export const diffImportResultSchema = z.object({
  artifactId: idSchema('artifact'),
  files: z.array(z.string()),
  parseWarnings: z.array(z.string()),
});

/** `artifacts.*` operations. */
export const artifactOps = {
  'artifacts.get': op({
    channel: 'relay/v1/artifacts.get',
    kind: 'query',
    route: 'runner',
    input: z.object({
      artifactId: idSchema('artifact'),
      maxBytes: z.number().int().positive().max(ARTIFACT_INLINE_MAX_BYTES).optional(),
    }),
    output: z.object({ meta: artifactMetaSchema, content: artifactContentSchema }),
    errors: ['NOT_FOUND'],
    idempotent: false,
  }),
  'artifacts.importDiff': op({
    channel: 'relay/v1/artifacts.importDiff',
    kind: 'command',
    route: 'main+runner',
    input: z.object({ projectId: idSchema('project') }),
    output: diffImportResultSchema.nullable(), // null = dialog cancelled
    errors: ['VALIDATION_FAILED', 'PERMISSION_DENIED', 'NOT_FOUND', 'ARTIFACT_WRITE_FAILED'],
    idempotent: false,
  }),
  'artifacts.export': op({
    channel: 'relay/v1/artifacts.export',
    kind: 'command',
    route: 'main+runner',
    input: z.object({ runId: idSchema('run'), what: exportWhatSchema }),
    output: z.object({ exported: z.boolean(), displayPaths: z.array(z.string()) }),
    errors: ['ARTIFACT_WRITE_FAILED', 'PERMISSION_DENIED', 'NOT_FOUND'],
    idempotent: false,
    rateLimit: RATE_LIMITS.dialog,
  }),
} as const;
