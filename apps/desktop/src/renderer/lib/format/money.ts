import { formatUsd } from '@relay/contracts';
import type { CostCertainty, Microusd } from '@relay/contracts';

/** Amounts below one cent are shown with 4 decimals so small calls do not read as "$0.00". */
const FOUR_DP_BELOW_MICROUSD = 10_000; // $0.01
/** Smallest amount 4 decimals can express ($0.0001). Anything non-zero below it is "< $0.0001". */
const SMALLEST_FOUR_DP_MICROUSD = 100;

function formatMagnitude(abs: number): string {
  if (abs === 0) return formatUsd(0 as Microusd, { precision: 2 });
  if (abs < SMALLEST_FOUR_DP_MICROUSD) return '< $0.0001';
  const precision = abs < FOUR_DP_BELOW_MICROUSD ? 4 : 2;
  return formatUsd(abs as Microusd, { precision });
}

/**
 * Formats integer micro-USD for display (§9.2). Integer-only: the sign is split off and the
 * magnitude goes through contracts `formatUsd`, so no float arithmetic touches money.
 * Estimated amounts read "≈ $0.48 est."; unknown liabilities read "$0.48 unknown".
 */
export function formatMoney(m: Microusd, certainty?: CostCertainty | null): string {
  const isNegative = m < 0;
  const magnitude = formatMagnitude(Math.abs(m));
  const amount = isNegative ? `-${magnitude}` : magnitude;
  if (certainty === 'estimated') return `≈ ${amount} est.`;
  if (certainty === 'unknown') return `${amount} unknown`;
  return amount;
}
