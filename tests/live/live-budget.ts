// Spend accounting for the live tests (04 §D9 / §D9b). Pure helpers (no vitest, no network) so they are unit-tested
// offline in live-budget.test.ts. The rules are deliberately conservative: a live test may never spend past its cap.
import type { ModelPrices } from '@relay/contracts';
import { computeCost } from '@relay/providers';
import type { ModelResult, NormalizedUsage } from '@relay/providers';

/** Thrown when a call would (pre-check) or did (post-charge) push the cumulative spend past the cap. */
export class LiveCapError extends Error {
  override readonly name = 'LiveCapError';
}

function isUsage(value: unknown): value is NormalizedUsage {
  if (typeof value !== 'object' || value === null) return false;
  const u = value as Record<string, unknown>;
  return ['uncachedInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'outputTokens'].every(
    (k) => typeof u[k] === 'number',
  );
}

/** Usage an error result carries (`usage`, else `error.details.partialUsage`), if any. */
function errorUsage(r: Extract<ModelResult, { kind: 'error' }>): NormalizedUsage | undefined {
  if (r.usage !== undefined) return r.usage;
  const partial = r.error.details?.['partialUsage'];
  return isUsage(partial) ? partial : undefined;
}

/**
 * What one billable call is charged against the live cap, in µUSD:
 * - `error` with phase `not_sent`: 0 (the request provably never reached the provider).
 * - any other `error` (the provider may have executed and billed it): the estimate's upper allowance N, or the cost of the
 *   reported partial usage when that is higher (N bounds the whole call, so it is the conservative figure).
 * - `success` / `truncated` / `refused` with `usageKnown: false`: N (the zero usage is a placeholder, not a known $0).
 * - `priceTierMismatch: true`: the catalog prices do not describe the bill, so max(cost, N).
 * - otherwise: `computeCost(usage, prices)`.
 */
export function liveChargeMicrousd(r: ModelResult, prices: ModelPrices, upperAllowanceMicrousd: number): number {
  if (r.kind === 'error') {
    if (r.phase === 'not_sent') return 0;
    const u = errorUsage(r);
    const partial = u === undefined ? 0 : computeCost(u, prices).microusd;
    return Math.max(partial, upperAllowanceMicrousd);
  }
  if (r.usageKnown === false) return upperAllowanceMicrousd;
  const cost = computeCost(r.usage, prices).microusd;
  return r.priceTierMismatch === true ? Math.max(cost, upperAllowanceMicrousd) : cost;
}

/** One cumulative cap shared by every provider in a live test file. */
export interface LiveBudget {
  readonly cap: number;
  /** Cumulative µUSD charged so far. */
  spent(): number;
  /**
   * Pre-check BEFORE a billable call: throws {@link LiveCapError} (and dispatches nothing) when `spent + upper > cap`.
   */
  admit(upperAllowanceMicrousd: number, label: string): void;
  /** Charges a finished call ({@link liveChargeMicrousd}); throws {@link LiveCapError} once the cap is exceeded. */
  charge(r: ModelResult, prices: ModelPrices, upperAllowanceMicrousd: number): number;
}

/** Creates a {@link LiveBudget}. */
export function createLiveBudget(cap: number): LiveBudget {
  let spent = 0;
  return {
    cap,
    spent: () => spent,
    admit(upper, label) {
      if (!Number.isFinite(upper) || upper < 0) throw new LiveCapError(`${label}: invalid upper allowance ${String(upper)}`);
      if (spent + upper > cap) {
        throw new LiveCapError(`${label}: upper bound ${String(upper)} µUSD would push live spend ${String(spent)} past the cap ${String(cap)}`);
      }
    },
    charge(r, prices, upper) {
      const amount = liveChargeMicrousd(r, prices, upper);
      spent += amount;
      if (spent > cap) throw new LiveCapError(`cumulative live spend ${String(spent)} µUSD exceeds the cap ${String(cap)}`);
      return amount;
    },
  };
}

/** Ledger balances of one run (§9.3): settled C, reserved R, unknown U, in µUSD. */
export interface RunSpendBalances {
  readonly C: number;
  readonly R: number;
  readonly U: number;
}

/**
 * Cumulative spend across the live workflow runs of one file (04 §D9b). Every run's ledger (C + U + R: settled, still
 * unknown, and still reserved liability) is recorded — also for runs that failed — and after any failure the remaining
 * providers are skipped rather than spending more.
 */
export interface WorkflowSpend {
  readonly cap: number;
  spent(): number;
  /** Cap left for the next run's budget L (never negative). */
  remaining(): number;
  /** Adds one run's C + U + R. */
  record(balances: RunSpendBalances): number;
  /** Stops every later provider (a run failed). */
  halt(reason: string): void;
  /** A run's spend could not be read: halts, and makes {@link WorkflowSpend.assertWithinCap} fail (spend is unknown). */
  recordUnreadable(reason: string): void;
  /** Why the remaining providers are skipped, or `undefined`. */
  haltedReason(): string | undefined;
  /** Throws {@link LiveCapError} (and halts) when the cumulative spend exceeds the cap or could not be read. */
  assertWithinCap(): void;
}

/** Creates a {@link WorkflowSpend}. */
export function createWorkflowSpend(cap: number): WorkflowSpend {
  let spent = 0;
  let halted: string | undefined;
  let unreadable: string | undefined;
  const self: WorkflowSpend = {
    cap,
    spent: () => spent,
    remaining: () => Math.max(0, cap - spent),
    record(b) {
      const amount = b.C + b.U + b.R;
      spent += amount;
      return amount;
    },
    halt(reason) {
      halted ??= reason;
    },
    recordUnreadable(reason) {
      unreadable ??= reason;
      self.halt(reason);
    },
    haltedReason: () => halted,
    assertWithinCap() {
      if (unreadable !== undefined) throw new LiveCapError(`live workflow spend is unknown: ${unreadable}`);
      if (spent <= cap) return;
      self.halt('workflow cap exceeded');
      throw new LiveCapError(`cumulative live workflow spend ${String(spent)} µUSD exceeds the cap ${String(cap)}`);
    },
  };
  return self;
}
