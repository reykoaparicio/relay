// Decision 1 test helper: the estimate of an uncertain attempt computed independently of the engine — the input tokens
// recorded with the attempt's estimate plus the given output tokens, at the attempt's catalog prices (computeCost
// rounds each category up, like mulDivCeil everywhere).
import { computeCost } from '@relay/contracts';
import type { Microusd } from '@relay/contracts';
import type { AttemptRow } from '@relay/storage';

/** The expected estimate of `a` with `outputTokens` observed (default: its recorded usage's output, else 0). */
export function expectedEstimate(a: Pick<AttemptRow, 'estimate' | 'usage' | 'profileSnapshot'>, outputTokens = a.usage?.outputTokens ?? 0): Microusd {
  const inputTokens = (a.estimate as { inputTokens?: number } | null)?.inputTokens ?? 0;
  return computeCost({ uncachedInputTokens: inputTokens, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens }, a.profileSnapshot.prices).microusd;
}
