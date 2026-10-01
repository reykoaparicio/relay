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

/** Structural subset of Gemini `GenerateContentResponseUsageMetadata` (`@google/genai`). */
export interface GeminiUsageLike {
  readonly promptTokenCount?: number | null;
  readonly cachedContentTokenCount?: number | null;
  readonly candidatesTokenCount?: number | null;
  readonly thoughtsTokenCount?: number | null;
  readonly toolUsePromptTokenCount?: number | null;
}

/**
 * Gemini, the third variant of the double-count trap (§8.4, 04 §D10): `promptTokenCount` INCLUDES the cached tokens
 * (`cachedContentTokenCount`), so they are subtracted; thinking tokens (`thoughtsTokenCount`) are reported SEPARATELY
 * from `candidatesTokenCount` but billed as output, so they are added to output. Tool-use prompt tokens (not part of
 * `promptTokenCount`; Relay sends no tools, so normally absent) are billed input and counted as uncached input.
 * Gemini has no per-token cache-write charge (explicit caches bill storage per hour, which Relay never creates).
 */
export function normalizeGeminiUsage(u: GeminiUsageLike | null | undefined): NormalizedUsage {
  const cached = count(u?.cachedContentTokenCount);
  const thoughts = count(u?.thoughtsTokenCount);
  const base = {
    uncachedInputTokens: Math.max(0, count(u?.promptTokenCount) - cached) + count(u?.toolUsePromptTokenCount),
    cacheReadInputTokens: cached,
    cacheWriteInputTokens: 0,
    outputTokens: count(u?.candidatesTokenCount) + thoughts,
  };
  return typeof u?.thoughtsTokenCount === 'number' ? { ...base, reasoningTokens: thoughts } : base;
}

