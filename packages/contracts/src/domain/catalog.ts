import { z } from 'zod';
import { nonNegativeMicrousdSchema } from '../money.js';
import { effortSchema, providerIdSchema } from '../status.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

/** §8.3/§8.4 model capabilities (04 D1 imports these; no local copies). */
export const modelCapabilitiesSchema = z.object({
  structuredOutput: z.boolean(), // JSON-schema constrained output
  streaming: z.boolean(),
  tools: z.boolean(),
  maxInputTokens: z.number().int().positive().optional(),
  // Prompts above this many input tokens are billed at a higher tier than `prices` (e.g. gpt-6.1-sol: 2x input above
  // 272K). Absent = no prompt-length price tier. The catalog then caps `maxInputTokens` at or below it, and an estimate
  // without a provider count uses the conservative 1 token/char bound (04 §D1 R4-12, ADR note "Count-failure fallback").
  priceCliffInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  supportsRequestLookup: z.boolean(), // can reconcile by response id after a crash (§7.5)
  supportsTokenCounting: z.boolean(), // provider count endpoint for estimates
  effortLevels: z.array(effortSchema), // [] = unsupported → block if the profile sets effort
  thinkingAlwaysOn: z.boolean(), // output allowance must include thinking tokens
});
/** Model capabilities. */
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

/** §9.2 prices: integer µUSD per million tokens, per disjoint usage category (§8.4). */
export const modelPricesSchema = z.object({
  input: nonNegativeMicrousdSchema,
  output: nonNegativeMicrousdSchema,
  cacheRead: nonNegativeMicrousdSchema,
  cacheWrite: nonNegativeMicrousdSchema,
});
/** Model prices. */
export type ModelPrices = z.infer<typeof modelPricesSchema>;

/** One entry of a versioned catalog file (04 D2). */
export const catalogEntrySchema = z.object({
  providerId: providerIdSchema,
  modelId: z.string().min(1).max(120),
  displayName: z.string().min(1).max(80),
  capabilities: modelCapabilitiesSchema,
  prices: modelPricesSchema,
  effectiveDate: isoDate, // date the prices take effect
  source: z.string().regex(/^https:\/\//, 'must be an https URL'), // official pricing URL (R3-37)
  sourceRetrievedAt: isoDate, // ISO date the source was retrieved
});
/** Catalog entry. */
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/** A versioned catalog file (old versions are kept, never edited, §9.2). */
export const catalogFileSchema = z.object({
  catalogVersion: isoDate,
  currency: z.literal('USD'),
  entries: z.array(catalogEntrySchema).min(1),
});

/** `providers.catalog` row: an entry plus the catalog version it came from. */
export const catalogModelSchema = catalogEntrySchema.extend({ catalogVersion: z.string() });
/** Catalog model. */
export type CatalogModel = z.infer<typeof catalogModelSchema>;
