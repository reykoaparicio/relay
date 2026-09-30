import { z } from 'zod';
import { MAX_OUTPUT_TOKENS_CEILING } from '../defaults.js';
import { idSchema } from '../ids.js';
import { epochMsSchema } from '../primitives.js';
import { effortSchema, providerIdSchema } from '../status.js';
import { modelCapabilitiesSchema, modelPricesSchema } from './catalog.js';

/** Anthropic refusal fallback: off by default (ADR-016). */
export const REFUSAL_FALLBACK_MODES = ['off', 'default'] as const;

/** Model request parameters of a profile (§8.2). */
export const modelParamsSchema = z.object({
  maxOutputTokens: z.number().int().positive().max(MAX_OUTPUT_TOKENS_CEILING),
  maxInputTokens: z.number().int().positive().optional(), // §9.1 input context allowance
  effort: effortSchema.optional(), // mapped per adapter (04 §D4/§D5)
  refusalFallback: z.enum(REFUSAL_FALLBACK_MODES).default('off'), // ADR-016
});
/** Model params. */
export type ModelParams = z.infer<typeof modelParamsSchema>;

/** §8.2 model profile: a user alias ("Economy", "Balanced", "Capable") for a provider model + params. */
export const modelProfileSchema = z.object({
  id: idSchema('profile'),
  name: z.string().min(1).max(40),
  providerId: providerIdSchema,
  modelId: z.string().min(1).max(120),
  params: modelParamsSchema,
  revision: z.number().int().positive(),
  updatedAt: epochMsSchema,
});
/** Model profile. */
export type ModelProfile = z.infer<typeof modelProfileSchema>;

/** FR-03 snapshot copied into every run: profile + resolved capabilities + prices + price catalog version. */
export const profileSnapshotSchema = modelProfileSchema.extend({
  capabilities: modelCapabilitiesSchema,
  prices: modelPricesSchema,
  priceCatalogVersion: z.string(),
});
/** Profile snapshot. */
export type ProfileSnapshot = z.infer<typeof profileSnapshotSchema>;

/** `profiles.upsert` input profile; an absent id means create. */
export const modelProfileInputSchema = modelProfileSchema
  .omit({ id: true, revision: true, updatedAt: true })
  .extend({ id: idSchema('profile').optional() });
/** Model profile input. */
export type ModelProfileInput = z.infer<typeof modelProfileInputSchema>;
