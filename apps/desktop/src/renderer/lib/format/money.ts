import { formatUsd } from '@relay/contracts';
import type { CostCertainty, Microusd } from '@relay/contracts';

/** Amounts below one cent are shown with 4 decimals so small calls do not read as "$0.00". */
const FOUR_DP_BELOW_MICROUSD = 10_000; // $0.01
/** Smallest amount 4 decimals can express ($0.0001). Anything non-zero below it reads "< $0.0001". */
const SMALLEST_FOUR_DP_MICROUSD = 100;
/** Half of one 4-dp step ($0.00005): 4-dp display rounds half up, so the cent threshold is checked after rounding. */
const HALF_FOUR_DP_STEP_MICROUSD = SMALLEST_FOUR_DP_MICROUSD / 2;
/** µUSD has 6 decimal places, so 6 dp always shows two different amounts differently. */
const MAX_PRECISION = 6;

/** Decimal places for money: 2 (cents) or 4 (sub-cent amounts). */
export type MoneyPrecision = 2 | 4;

/** True when the default rule shows `m` at 4 dp (a non-zero amount that rounds below one cent). */
function isSubCent(m: number): boolean {
  const abs = Math.abs(m);
  // 9_950 µUSD rounds to "$0.0100" at 4 dp, which is one cent: it reads "$0.01" instead.
  return abs !== 0 && abs + HALF_FOUR_DP_STEP_MICROUSD < FOUR_DP_BELOW_MICROUSD;
}

/**
 * Signed magnitude text. Tiny amounts use an inequality that stays true: "< $0.0001" and "> -$0.0001".
 * `precision` 4 forces 4 dp for every amount (a column that holds sub-cent values); otherwise each amount picks its own.
 */
function formatSigned(m: number, precision?: MoneyPrecision): string {
  const abs = Math.abs(m);
  if (abs !== 0 && abs < SMALLEST_FOUR_DP_MICROUSD) return m < 0 ? '> -$0.0001' : '< $0.0001';
  if (precision === 4) return formatUsd(m as Microusd, { precision: 4 });
  return formatUsd(m as Microusd, { precision: isSubCent(m) ? 4 : 2 });
}

/**
 * One precision for a whole column (or any group of amounts read side by side): 4 dp when any amount in it is
 * sub-cent, else 2 dp. Mixed rows like "$0.0042" over "$0.02" read as different magnitudes at a glance; with one
 * rule per column they read "$0.0042" over "$0.0200".
 */
export function moneyColumnPrecision(values: readonly Microusd[]): MoneyPrecision {
  return values.some(isSubCent) ? 4 : 2;
}

export interface FormatMoneyOptions {
  /** Force a precision (from {@link moneyColumnPrecision}); default: 4 dp only for sub-cent amounts. */
  readonly precision?: MoneyPrecision;
}

/**
 * Formats integer micro-USD for display (§9.2). Integer-only: rounding goes through contracts
 * `formatUsd`, so no float arithmetic touches money.
 * Estimated amounts read "≈ $0.48 est."; unknown liabilities read "$0.48 unknown".
 */
export function formatMoney(m: Microusd, certainty?: CostCertainty | null, options: FormatMoneyOptions = {}): string {
  const amount = formatSigned(m, options.precision);
  if (certainty === 'estimated') return `≈ ${amount} est.`;
  if (certainty === 'unknown') return `${amount} unknown`;
  return amount;
}

/** Dollars at an explicit precision (0–6 dp), rounding half away from zero with BigInt only. */
export function formatUsdAtPrecision(m: Microusd, precision: number): string {
  const digits = Math.min(MAX_PRECISION, Math.max(0, Math.trunc(precision)));
  const abs = BigInt(Math.abs(m));
  const step = 10n ** BigInt(MAX_PRECISION - digits);
  const units = (abs + step / 2n) / step;
  const scale = 10n ** BigInt(digits);
  const whole = (units / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = digits === 0 ? '' : `.${(units % scale).toString().padStart(digits, '0')}`;
  const sign = m < 0 && units !== 0n ? '-' : '';
  return `${sign}$${whole}${frac}`;
}

/**
 * Formats two amounts for a side-by-side comparison ("$3.004 > $3.000"). If the normal display of two
 * different amounts is identical, precision grows (up to 6 dp, which is exact for µUSD) until they differ,
 * so an inequality never reads "$3.00 > $3.00".
 */
export function formatMoneyPair(a: Microusd, b: Microusd): readonly [string, string] {
  const first = formatMoney(a);
  const second = formatMoney(b);
  if (a === b || first !== second) return [first, second];
  for (let precision = 3; precision <= MAX_PRECISION; precision++) {
    const pair = [formatUsdAtPrecision(a, precision), formatUsdAtPrecision(b, precision)] as const;
    if (pair[0] !== pair[1]) return pair;
  }
  return [formatUsdAtPrecision(a, MAX_PRECISION), formatUsdAtPrecision(b, MAX_PRECISION)];
}

/** Rounded units of `m` at `digits` dp (half away from zero), as the display shows them. */
function unitsAt(m: number, digits: number): bigint {
  const step = 10n ** BigInt(MAX_PRECISION - digits);
  const abs = BigInt(Math.abs(m));
  const units = (abs + step / 2n) / step;
  return m < 0 ? -units : units;
}

/**
 * One precision (2–6 dp) for amounts read as a sum, `parts[0] + parts[1] + … = total`, at which the displayed parts
 * visibly add up to the displayed total ("$0.06 + $0.44 = $0.50", never "$0.06 + $0.45 = $0.50"). 2 dp unless
 * rounding would break the sum; µUSD at 6 dp is exact, so the sum always holds there.
 */
export function sumConsistentPrecision(parts: readonly number[], total: number): number {
  const base = moneyColumnPrecision([...parts, total] as Microusd[]);
  for (let digits = base; digits < MAX_PRECISION; digits++) {
    const sum = parts.reduce((acc, p) => acc + unitsAt(p, digits), 0n);
    if (sum === unitsAt(total, digits)) return digits;
  }
  return MAX_PRECISION;
}
