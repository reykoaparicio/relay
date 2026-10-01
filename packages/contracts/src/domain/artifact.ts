import { z } from 'zod';
import { idSchema } from '../ids.js';
import { epochMsSchema, sha256Schema } from '../primitives.js';
import { artifactKindSchema } from '../status.js';

/** Artifact metadata. `purged` = file removed by retention/purge; the row and hash are kept. */
export const artifactMetaSchema = z.object({
  id: idSchema('artifact'),
  kind: artifactKindSchema,
  schemaId: z.string().nullable(),
  runId: idSchema('run').nullable(),
  stepRunId: idSchema('stepRun').nullable(),
  attemptId: idSchema('attempt').nullable(),
  sha256: sha256Schema,
  sizeBytes: z.number().int().nonnegative(),
  mediaType: z.string(),
  createdAt: epochMsSchema,
  purged: z.boolean(),
});
/** Artifact metadata. */
export type ArtifactMeta = z.infer<typeof artifactMetaSchema>;

/** Artifact content returned inline by `artifacts.get`. */
export const artifactContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('json'), value: z.unknown() }),
  z.object({ kind: z.literal('text'), text: z.string(), truncated: z.boolean() }),
]);
/** Artifact content. */
export type ArtifactContent = z.infer<typeof artifactContentSchema>;

/** The `<artifact>.purged` tombstone file of the artifact store (05 E6, B11): when the file was purged. */
export const artifactTombstoneSchema = z.object({ purgedAt: epochMsSchema });
