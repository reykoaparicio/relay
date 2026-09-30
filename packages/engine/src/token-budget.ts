// 07 G1b (Wave-1 minimum): token counting and the input budget. The full optional-item fit algorithm
// (`fitToBudget`) lands with G1 in Wave 3; in Wave 1 every selected file is mandatory.
import type { ProfileSnapshot } from '@relay/contracts';

/** 5% safety margin for estimator error (G1b). */
export const INPUT_BUDGET_SAFETY = 0.95;

/** Token count + its basis (the manifest records the basis). */
export interface TokenCount {
  readonly tokens: number;
  readonly basis: 'provider_count' | 'local_estimate';
}

/** Counts input tokens for a rendered request. */
export interface TokenEstimator {
  count(i: { readonly system: string; readonly user: string; readonly profile: ProfileSnapshot }): Promise<TokenCount>;
}

/** Local heuristic `ceil(chars × 23 / 64)` (= chars / 3.2 × 1.15, the 04 §D4 estimate; deliberately generous). */
export function localTokens(chars: number): number {
  return Math.ceil((chars * 23) / 64);
}

/** The default estimator: local heuristic over system + user characters. */
export function createLocalEstimator(): TokenEstimator {
  return {
    count: ({ system, user }) => Promise.resolve({ tokens: localTokens(system.length + user.length), basis: 'local_estimate' }),
  };
}

/**
 * `min(caps.maxInputTokens − maxOutputTokens, profile.params.maxInputTokens ?? ∞) × 0.95`, floored. Unknown caps are
 * treated as unbounded (the adapter-side capability check still applies at dispatch, F6 #4).
 */
export function inputBudget(profile: ProfileSnapshot, maxOutputTokens: number): number {
  const capIn = profile.capabilities.maxInputTokens;
  const byCaps = capIn === undefined ? Number.MAX_SAFE_INTEGER : capIn - maxOutputTokens;
  const byProfile = profile.params.maxInputTokens ?? Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor(Math.min(byCaps, byProfile) * INPUT_BUDGET_SAFETY));
}
