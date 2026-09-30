import { z } from 'zod';
import { idSchema } from '../ids.js';
import { epochMsSchema, stepKeySchema } from '../primitives.js';
import { attemptPurposeSchema, attemptStateSchema, providerIdSchema } from '../status.js';
import { costWithCertaintySchema } from './ledger.js';

const tokenCount = z.number().int().nonnegative();

/** 04 NormalizedUsage: disjoint usage categories (§8.4). */
export const usageViewSchema = z.object({
  uncachedInputTokens: tokenCount,
  cacheReadInputTokens: tokenCount,
  cacheWriteInputTokens: tokenCount,
  outputTokens: tokenCount,
  reasoningTokens: tokenCount.optional(), // informational subset of outputTokens
  partial: z.boolean().optional(), // observed before an abort; informational only (R4-9)
});
/** Usage view. */
export type UsageView = z.infer<typeof usageViewSchema>;

/** One external attempt (§7.3) as shown in the Attempts tab. */
export const attemptViewSchema = z.object({
  id: idSchema('attempt'),
  stepRunId: idSchema('stepRun'),
  stepKey: stepKeySchema,
  seq: z.number().int().positive(),
  purpose: attemptPurposeSchema,
  state: attemptStateSchema,
  providerId: providerIdSchema,
  modelId: z.string(),
  usage: usageViewSchema.nullable(),
  cost: costWithCertaintySchema.nullable(), // settled, or for unknown/abandoned the liability with certainty 'unknown'
  providerLatencyMs: z.number().int().nonnegative().nullable(), // provider time (first byte → finish)
  appElapsedMs: z.number().int().nonnegative().nullable(), // app wall time (reserve → finish), shown separately (R3-20)
  providerRequestId: z.string().nullable(),
  startedAt: epochMsSchema,
  finishedAt: epochMsSchema.nullable(),
});
/** Attempt view. */
export type AttemptView = z.infer<typeof attemptViewSchema>;
