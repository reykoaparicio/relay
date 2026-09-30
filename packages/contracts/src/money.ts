import { z } from 'zod';
import type { Brand } from './brand.js';

/** Integer micro-USD (§9.2, ADR-017). 1 USD = 1_000_000 µUSD. Never a float. */
export type Microusd = Brand<number, 'Microusd'>;

/** §9.2: 1 USD = 1_000_000 µUSD. */
export const MICROUSD_PER_USD = 1_000_000;
/** Token prices are quoted per million tokens (§9.2). */
export const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** Zod schema for any safe-integer µUSD amount (may be negative, e.g. ledger deltas or overrun remaining). */
export const microusdSchema = z
  .number()
  .int()
  .refine(Number.isSafeInteger, 'unsafe integer')
  .transform((n) => n as Microusd);

/** Zod schema for a µUSD amount that must be ≥ 0 (allowances, prices, reservations). */
export const nonNegativeMicrousdSchema = z
  .number()
  .int()
  .nonnegative('must be ≥ 0')
  .refine(Number.isSafeInteger, 'unsafe integer')
  .transform((n) => n as Microusd);

/**
 * Brands a number as {@link Microusd}.
 * @throws RangeError when `n` is not a safe integer.
 */
export function microusd(n: number): Microusd {
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`not a safe integer µUSD amount: ${String(n)}`);
  }
  return n as Microusd;
}

/** Zero µUSD. */
export const ZERO_MICROUSD = microusd(0);

const USD_PATTERN = /^(-?)(\d+)(?:\.(\d{1,6}))?$/;

/**
 * Parses a decimal dollar string exactly (max 6 decimal places) into µUSD. Never goes through floats.
 * @throws RangeError on malformed input, more than 6 decimals, or an unsafe result.
 */
export function usd(dollars: `${number}`): Microusd {
  const m = USD_PATTERN.exec(dollars);
  if (m === null) {
    throw new RangeError(`not an exact USD amount with at most 6 decimals: ${dollars}`);
  }
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = BigInt(m[2] ?? '0');
  const frac = BigInt((m[3] ?? '').padEnd(6, '0'));
  return fromBigInt(sign * (whole * BigInt(MICROUSD_PER_USD) + frac));
}

function fromBigInt(v: bigint): Microusd {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('µUSD amount outside the safe integer range');
  }
  return Number(v) as Microusd;
}

/**
 * Sums µUSD amounts exactly.
 * @throws RangeError when the result is not a safe integer.
 */
export function addMicrousd(...xs: readonly Microusd[]): Microusd {
  let total = 0n;
  for (const x of xs) {
    total += BigInt(x);
  }
  return fromBigInt(total);
}

/**
 * `a − b` in µUSD.
 * @throws RangeError when the result is not a safe integer.
 */
export function subMicrousd(a: Microusd, b: Microusd): Microusd {
  return fromBigInt(BigInt(a) - BigInt(b));
}

/**
 * Cost of `tokens` at `pricePerMillionMicrousd` µUSD per million tokens, rounded **up** to a whole µUSD (§9.2).
 * `ceil(tokens × price / 1_000_000)` computed with BigInt, so no float rounding can under-charge.
 * @throws RangeError when an input is not a non-negative safe integer or the result is unsafe.
 */
export function mulDivCeil(tokens: number, pricePerMillionMicrousd: number): Microusd {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new RangeError(`tokens must be a non-negative safe integer: ${String(tokens)}`);
  }
  if (!Number.isSafeInteger(pricePerMillionMicrousd) || pricePerMillionMicrousd < 0) {
    throw new RangeError(`price must be a non-negative safe integer: ${String(pricePerMillionMicrousd)}`);
  }
  const num = BigInt(tokens) * BigInt(pricePerMillionMicrousd);
  const den = BigInt(TOKENS_PER_PRICE_UNIT);
  return fromBigInt((num + den - 1n) / den);
}

/** Display options for {@link formatUsd}. */
export interface FormatUsdOptions {
  readonly precision?: 2 | 4;
}

/**
 * Formats µUSD as dollars, e.g. `"$0.48"`, `"-$1,234.5600"`. Rounds half away from zero at the requested precision.
 * Display only; never parse the result back into money.
 */
export function formatUsd(m: Microusd, opts?: FormatUsdOptions): string {
  const precision = opts?.precision ?? 2;
  const negative = m < 0;
  const abs = BigInt(Math.abs(m));
  const step = 10n ** BigInt(6 - precision);
  const units = (abs + step / 2n) / step;
  const scale = 10n ** BigInt(precision);
  const whole = (units / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (units % scale).toString().padStart(precision, '0');
  const isZero = units === 0n;
  return `${negative && !isZero ? '-' : ''}$${whole}.${frac}`;
}
