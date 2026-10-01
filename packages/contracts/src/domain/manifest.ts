import { z } from 'zod';
import { idSchema } from '../ids.js';
import { OUTPUT_SCHEMA_IDS } from '../outputs/common.js';
import { relPathSchema, sha256Schema, stepKeySchema } from '../primitives.js';
import { attemptPurposeSchema, memoryTypeSchema, providerIdSchema } from '../status.js';


/** Where an input-token estimate came from: the provider's token-count endpoint, or the local heuristic. */
export const ESTIMATE_BASES = ['provider_count', 'local_estimate'] as const;
/** Schema for {@link EstimateBasis}. */
export const estimateBasisSchema = z.enum(ESTIMATE_BASES);
/** Estimate basis. */
export type EstimateBasis = z.infer<typeof estimateBasisSchema>;
/** Why a file entered the context. */
export const MANIFEST_FILE_REASONS = ['selected', 'plan_scope', 'referenced_by_findings'] as const;
/** Why an item was omitted from the context. */
export const MANIFEST_OMIT_REASONS = ['token_budget', 'excluded_by_policy', 'stale_source'] as const;

/** §10.2 step 8 / §5.4 "Context used": the context manifest. G4 builds instances; stored per attempt. */
export const contextManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: idSchema('run'),
  stepKey: stepKeySchema,
  revisionIndex: z.number().int(),
  attemptPurpose: attemptPurposeSchema,
  profile: z.object({ name: z.string(), providerId: providerIdSchema, modelId: z.string() }),
  priceCatalogVersion: z.string(),
  instructions: z.object({ version: z.string(), sha256: sha256Schema }),
  files: z.array(
    z.object({
      relPath: relPathSchema,
      sha256: sha256Schema,
      sizeBytes: z.number(),
      tokens: z.number(),
      included: z.boolean(),
      reason: z.enum(MANIFEST_FILE_REASONS),
    }),
  ),
  memory: z.array(
    z.object({
      recordId: idSchema('memory'),
      revision: z.number(),
      type: memoryTypeSchema,
      included: z.boolean(),
      pinned: z.boolean(),
      stale: z.boolean(),
      score: z.number(),
    }),
  ),
  upstream: z.array(
    z.object({
      stepKey: stepKeySchema,
      artifactId: idSchema('artifact'),
      schemaId: z.enum(OUTPUT_SCHEMA_IDS),
      sha256: sha256Schema,
    }),
  ),
  omitted: z.array(
    z.object({ kind: z.enum(['file', 'memory']), ref: z.string(), reason: z.enum(MANIFEST_OMIT_REASONS) }),
  ),
  tokens: z.object({
    estimatedInput: z.number(),
    budget: z.number(),
    basis: estimateBasisSchema,
  }),
  contextHash: sha256Schema, // sha256(system + "\n\0\n" + user)
  providersReceivingContext: z.array(providerIdSchema), // honesty: where data goes (§6.2)
});
/** Context manifest. */
export type ContextManifest = z.infer<typeof contextManifestSchema>;
