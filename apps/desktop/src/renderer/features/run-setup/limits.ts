// Run limit inputs shared by onboarding and the new-run form, bounded by contracts RUN_LIMIT_MAXIMUMS (§9.1).
import { MIN_EXECUTION_TIMEOUT_SECONDS, RUN_LIMIT_MAXIMUMS } from '@relay/contracts';
import type { Microusd } from '@relay/contracts';
import { formatUsdAtPrecision } from '../../lib/format';
import { parseDollarInput } from '../../components/ui';

/** "3.00" (no "$"), the MoneyInput text for an amount. */
export function dollarsText(m: Microusd): string {
  return formatUsdAtPrecision(m, 2).replace('$', '');
}

/** Bounds of the user-editable limits. Timeout is edited in whole minutes. */
export const LIMIT_BOUNDS = {
  maxRevisionCycles: { min: 0, max: RUN_LIMIT_MAXIMUMS.maxRevisionCycles },
  maxAttempts: { min: 1, max: RUN_LIMIT_MAXIMUMS.maxAttempts },
  timeoutMinutes: {
    min: Math.ceil(MIN_EXECUTION_TIMEOUT_SECONDS / 60),
    max: Math.floor(RUN_LIMIT_MAXIMUMS.executionTimeoutSeconds / 60),
  },
} as const;

/** A whole number within bounds, or a plain-language error. */
export function checkWhole(
  text: string,
  bounds: { readonly min: number; readonly max: number },
): { value: number } | { error: string } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed))
    return { error: `Enter a whole number from ${String(bounds.min)} to ${String(bounds.max)}.` };
  const value = Number.parseInt(trimmed, 10);
  if (value < bounds.min) return { error: `Must be at least ${String(bounds.min)}.` };
  if (value > bounds.max)
    return { error: `Must be at most ${String(bounds.max)} (the maximum Relay allows).` };
  return { value };
}

/** A run allowance: a valid, non-zero dollar amount. */
export function checkAllowance(text: string): { value: Microusd } | { error: string } {
  const parsed = parseDollarInput(text);
  if (!parsed.ok) return { error: parsed.message };
  if (parsed.value <= 0) return { error: 'The run allowance must be more than $0.00.' };
  return { value: parsed.value };
}
