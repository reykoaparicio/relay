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
  // The settled amount and its certainty. An attempt whose outcome was uncertain (dispatch state `unknown`) is settled
  // at once as an `estimated` charge (decision 1): its input tokens plus the output observed so far, at the attempt's
  // catalog prices. Only data recorded before that change can still carry certainty 'unknown' (converted at start).
  cost: costWithCertaintySchema.nullable(),
  providerLatencyMs: z.number().int().nonnegative().nullable(), // provider time (first byte → finish)
  // Total wall time (reserve → finish), provider time included. UIs show app time = appElapsedMs − providerLatencyMs
  // (R3-20: provider time and app time shown separately).
  appElapsedMs: z.number().int().nonnegative().nullable(),
  providerRequestId: z.string().nullable(),
  startedAt: epochMsSchema,
  finishedAt: epochMsSchema.nullable(),
  /**
   * Decision 1: the request may never have reached the provider (it was not sent, or it was sent and no response byte
   * came back), so its estimated charge may not have been billed. Shown as the note "may not have been charged".
   */
  mayNotHaveBeenCharged: z.boolean(),
});
/** Attempt view. */
export type AttemptView = z.infer<typeof attemptViewSchema>;
