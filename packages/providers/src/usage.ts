// §8.4 usage normalization. The providers disagree on whether `input_tokens` includes cached tokens — the
// double-count trap. Each mapper returns DISJOINT categories.
import type { NormalizedUsage } from './types.js';

/** Structural subset of Anthropic `Usage` / `MessageDeltaUsage` (no SDK type leaks out of the adapter). */
export interface AnthropicUsageLike {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly output_tokens_details?: { readonly thinking_tokens?: number | null } | null;
}

/** Structural subset of OpenAI Responses `usage`. */
export interface OpenAIUsageLike {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly input_tokens_details?: { readonly cached_tokens?: number | null; readonly cache_write_tokens?: number | null } | null;
  readonly output_tokens_details?: { readonly reasoning_tokens?: number | null } | null;
}

const count = (n: number | null | undefined): number => (typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0);

/** Anthropic: `input_tokens` already EXCLUDES cache reads and writes; thinking tokens are inside `output_tokens`. */
export function normalizeAnthropicUsage(u: AnthropicUsageLike | null | undefined): NormalizedUsage {
  const base = {
    uncachedInputTokens: count(u?.input_tokens),
    cacheReadInputTokens: count(u?.cache_read_input_tokens),
    cacheWriteInputTokens: count(u?.cache_creation_input_tokens),
    outputTokens: count(u?.output_tokens),
  };
  const thinking = u?.output_tokens_details?.thinking_tokens;
  return typeof thinking === 'number' ? { ...base, reasoningTokens: count(thinking) } : base;
}

/** OpenAI: `input_tokens` INCLUDES cached (and cache-write) tokens, so they are subtracted; reasoning is inside output. */
export function normalizeOpenAIUsage(u: OpenAIUsageLike | null | undefined): NormalizedUsage {
  const cached = count(u?.input_tokens_details?.cached_tokens);
  const cacheWrite = count(u?.input_tokens_details?.cache_write_tokens);
  const base = {
    uncachedInputTokens: Math.max(0, count(u?.input_tokens) - cached - cacheWrite),
    cacheReadInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: count(u?.output_tokens),
  };
  const reasoning = u?.output_tokens_details?.reasoning_tokens;
  return typeof reasoning === 'number' ? { ...base, reasoningTokens: count(reasoning) } : base;
}

/** All-zero usage. */
export const ZERO_USAGE: NormalizedUsage = Object.freeze({
  uncachedInputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
});
