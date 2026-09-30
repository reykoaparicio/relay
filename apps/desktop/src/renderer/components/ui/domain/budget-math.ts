import { addMicrousd } from '@relay/contracts';
import type { CostSummary, Microusd } from '@relay/contracts';

/** Settled amounts with exact (reported or calculated) certainty. Integer µUSD, no floats (§9.2). */
export function settledExact(cost: CostSummary): Microusd {
  return addMicrousd(cost.settledReported, cost.settledCalculated);
}

/** Share of `total` as a CSS percentage. Display only; money arithmetic stays integer. */
export function percentOf(part: Microusd, total: Microusd): string {
  if (total <= 0 || part <= 0) return '0%';
  return `${String(Math.min(100, (part / total) * 100))}%`;
}
