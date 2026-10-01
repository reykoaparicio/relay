// 07 G1b: token counting, the input budget, and the fit algorithm (`fitToBudget`, pure). Files are included whole or
// not at all: an item is never truncated (§10.2 "ask the user to narrow scope").
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

/** One context item for the fit algorithm (its rendered block, counted as a whole). */
export interface FitItem {
  readonly kind: 'file' | 'memory';
  /** relPath (file) or memory record id. */
  readonly ref: string;
  readonly tokens: number;
}

/** `CONTEXT_TOO_LARGE` details (G1b). */
export interface TooLargeDetails {
  readonly mandatoryTokens: number;
  readonly budget: number;
  readonly largestItems: readonly { readonly relPath: string; readonly tokens: number }[];
}

/** Fit result: the optional items that fit (in priority order) and the ones omitted for `token_budget`. */
export type FitResult =
  | { readonly ok: true; readonly included: readonly FitItem[]; readonly omitted: readonly FitItem[]; readonly totalTokens: number }
  | { readonly ok: false; readonly details: TooLargeDetails };

/** Number of items listed in `largestItems`. */
const LARGEST_ITEMS = 5;

/**
 * G1b. `mandatoryTokens` covers everything that must be sent (system prompt, goal, constraints, upstream, pinned
 * rules, mandatory files); `mandatory` lists the mandatory items for the overflow report. Optional items are taken in
 * the given priority order until the next one does not fit; that item and every later one are omitted.
 */
export function fitToBudget(i: {
  readonly budget: number;
  readonly mandatoryTokens: number;
  readonly mandatory: readonly FitItem[];
  readonly optional: readonly FitItem[];
}): FitResult {
  if (i.mandatoryTokens > i.budget) {
    const largestItems = [...i.mandatory]
      .sort((a, b) => b.tokens - a.tokens || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
      .slice(0, LARGEST_ITEMS)
      .map((m) => ({ relPath: m.ref, tokens: m.tokens }));
    return { ok: false, details: { mandatoryTokens: i.mandatoryTokens, budget: i.budget, largestItems } };
  }
  let total = i.mandatoryTokens;
  let cut = i.optional.length;
  for (const [n, item] of i.optional.entries()) {
    if (total + item.tokens > i.budget) {
      cut = n;
      break;
    }
    total += item.tokens;
  }
  return { ok: true, included: i.optional.slice(0, cut), omitted: i.optional.slice(cut), totalTokens: total };
}
