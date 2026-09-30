import { z } from 'zod';

// Model output schema rules (02 §B11): every property required (optional = nullable), no transforms, no branded ids,
// no defaults — they must convert with z.toJSONSchema. Cross-field rules use superRefine; the Zod parse is authoritative.

/** Every step output schema id. */
export const OUTPUT_SCHEMA_IDS = ['findings.v1', 'plan.v1', 'patch.v1', 'review.v1', 'report.v1'] as const;
/** Schema for {@link OutputSchemaId}. */
export const outputSchemaIdSchema = z.enum(OUTPUT_SCHEMA_IDS);
/** Output schema id. */
export type OutputSchemaId = z.infer<typeof outputSchemaIdSchema>;

/** Output schemas a model step may request (`report.v1` is engine-generated, never requested from a model). */
export const MODEL_OUTPUT_SCHEMA_IDS = ['findings.v1', 'plan.v1', 'patch.v1', 'review.v1'] as const;
/** Schema for {@link ModelOutputSchemaId}. */
export const modelOutputSchemaIdSchema = z.enum(MODEL_OUTPUT_SCHEMA_IDS);
/** Model output schema id. */
export type ModelOutputSchemaId = z.infer<typeof modelOutputSchemaIdSchema>;

/** A file/line reference in model output. Paths are plain strings; F8 checks them against the input snapshot. */
export const sourceRefSchema = z.object({
  relPath: z.string(),
  startLine: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
});
/** Source reference. */
export type SourceRef = z.infer<typeof sourceRefSchema>;

/** §7.7 structured handoff base: every model output extends this. */
export const handoffBase = z.object({
  summary: z.string().min(1).max(1200),
  sourceRefs: z.array(sourceRefSchema).max(50),
  unresolvedQuestions: z.array(z.string().max(400)).max(10),
});
