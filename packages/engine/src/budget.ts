// 06 F5: budget admission (§9.3) and settlement (§9.5). Pure (integer µUSD only, never floats, ADR-017) except
// `admitAgainstLedger`, which reads the project month window through the ledger repo.
import { addMicrousd, computeCost, computeIterationsCost, microusd, subMicrousd } from '@relay/contracts';
import type {
  AttemptId,
  Balances,
  BudgetBreakdown,
  CostCertainty,
  EpochMs,
  Microusd,
  ModelPrices,
  PricedIteration,
  ProjectId,
  RunId,
} from '@relay/contracts';
import type { NormalizedUsage } from '@relay/providers';
import type { LedgerEntryInsert, LedgerRepo, ProjectRow } from '@relay/storage';
import { monthWindow } from './clock.js';

/** C/R/U of a scope without the allowance. */
export interface Outstanding {
  readonly C: Microusd;
  readonly R: Microusd;
  readonly U: Microusd;
}

/** Admission result; the breakdown is always returned so preflight can display it. */
export type Admission = { readonly ok: true; readonly breakdown: BudgetBreakdown } | { readonly ok: false; readonly breakdown: BudgetBreakdown };

function breakdown(scope: BudgetBreakdown['scope'], L: Microusd, o: Outstanding, N: Microusd): BudgetBreakdown {
  const total = addMicrousd(o.C, o.R, o.U, N);
  return { L, C: o.C, R: o.R, U: o.U, N, scope, total, allowed: total <= L };
}

/**
 * §9.3: dispatch only when `C + R + U + N <= L` — checked for the run, then for the project month when an allowance is
 * set. Inclusive: exactly equal is allowed. The run check is reported first when both fail.
 */
export function admit(i: {
  readonly run: Balances;
  readonly project: ({ readonly L: Microusd } & Outstanding) | null;
  readonly N: Microusd;
}): Admission {
  const run = breakdown('run', i.run.L, i.run, i.N);
  if (!run.allowed) return { ok: false, breakdown: run };
  if (i.project === null) return { ok: true, breakdown: run };
  const project = breakdown('project', i.project.L, i.project, i.N);
  return project.allowed ? { ok: true, breakdown: run } : { ok: false, breakdown: project };
}

/**
 * §9.3 admission of `N` against the ledger — the ONE place that reads the project month window for an admission
 * (dispatch reserve, next-admission re-checks, preflight, the queued-run readiness check). `run` is the run's balances
 * (or a not-yet-started run's `{ L, 0, 0, 0 }`); the project check applies only when the project has an allowance.
 */
export function admitAgainstLedger(
  ledger: Pick<LedgerRepo, 'projectMonthBalances'>,
  i: { readonly run: Balances; readonly project: Pick<ProjectRow, 'id' | 'monthlyAllowanceMicrousd'>; readonly N: Microusd; readonly now: EpochMs },
): Admission {
  const L = i.project.monthlyAllowanceMicrousd;
  if (L === null) return admit({ run: i.run, project: null, N: i.N });
  const { start, end } = monthWindow(i.now);
  return admit({ run: i.run, project: { L, ...ledger.projectMonthBalances(i.project.id, start, end) }, N: i.N });
}

/** F18: the providers.test allowance over this month's `scope='setup'` entries. */
export function admitSetup(i: { readonly setup: Outstanding; readonly L: Microusd; readonly N: Microusd }): Admission {
  const b = breakdown('setup', i.L, i.setup, i.N);
  return { ok: b.allowed, breakdown: b };
}

/** What is known about an attempt's charge (from F7 `classify`). */
export type ChargeBasis =
  | {
      readonly kind: 'known';
      readonly usage: NormalizedUsage;
      /** ADR-016: set when a provider-side fallback served (part of) the turn; each iteration is priced on its own. */
      readonly iterations?: readonly PricedIteration[] | undefined;
      /** The provider billed at a price tier the snapshot prices do not describe: the amount is `estimated`. */
      readonly estimated?: boolean | undefined;
    }
  /** The provider answered but did not report usage (`usageKnown: false`): settle at the reservation N, `estimated`. */
  | { readonly kind: 'at_reservation' }
  | { readonly kind: 'not_charged' }
  | { readonly kind: 'unknown' };

/** Settlement amount of one attempt. */
export type SettleAmount =
  | { readonly kind: 'known'; readonly microusd: Microusd; readonly certainty: 'reported' | 'calculated' | 'estimated' }
  | { readonly kind: 'not_charged' }
  | { readonly kind: 'unknown' };

/** Price sources for fallback iterations served by another model than the profile's (ADR-016). */
interface FallbackPriceLookup {
  /** Prices of `modelId` of the attempt's provider, or undefined when the catalog does not know it. */
  readonly pricesFor: (modelId: string) => ModelPrices | undefined;
  /** Every catalog price of the attempt's provider (the unknown-model maximum). */
  readonly providerPrices: () => readonly ModelPrices[];
}

/**
 * Maps an outcome's charge basis to an amount at the snapshot prices (FR-09 certainty `calculated`). When a
 * provider-side fallback served the turn, every served iteration is priced with its own model (contracts
 * `computeIterationsCost`); an iteration of a model without a known price is priced at the provider maximum and the
 * amount becomes `estimated`. `profileModelId` always prices at the snapshot `prices`.
 */
export function settleAmount(
  outcome: { readonly charge: ChargeBasis },
  prices: ModelPrices,
  fallback?: FallbackPriceLookup & { readonly profileModelId: string },
  reservation: Microusd = microusd(0),
): SettleAmount {
  const c = outcome.charge;
  switch (c.kind) {
    case 'known': {
      const certainty = (computed: 'reported' | 'calculated' | 'estimated') => (c.estimated === true ? 'estimated' : computed);
      if (c.iterations !== undefined && c.iterations.length > 0) {
        const lookup: FallbackPriceLookup = {
          pricesFor: (id) => (id === fallback?.profileModelId ? prices : fallback?.pricesFor(id)),
          providerPrices: () => [prices, ...(fallback?.providerPrices() ?? [])],
        };
        const cost = computeIterationsCost(c.iterations, lookup);
        return { kind: 'known', microusd: cost.microusd, certainty: certainty(cost.certainty) };
      }
      return { kind: 'known', microusd: computeCost(c.usage, prices).microusd, certainty: certainty('calculated') };
    }
    case 'at_reservation':
      // FR-09: no usage reported → the upper bound is the recorded charge (never a $0 "calculated").
      return { kind: 'known', microusd: reservation, certainty: 'estimated' };
    case 'not_charged':
      return { kind: 'not_charged' };
    case 'unknown':
      return { kind: 'unknown' };
  }
}

/** §9.5 overrun: known cost above the reservation (recorded, never capped). */
export function isOverrun(cost: SettleAmount, N: Microusd): boolean {
  return cost.kind === 'known' && cost.microusd > N;
}

const neg = (m: Microusd): Microusd => subMicrousd(microusd(0), m);

/** Common ledger columns of one movement. */
interface LedgerRefs {
  readonly attemptId: AttemptId | null;
  readonly runId: RunId | null;
  readonly projectId: ProjectId | null;
  readonly priceCatalogVersion: string | null;
  readonly createdAt: EpochMs;
  readonly scope?: 'run' | 'setup';
}

function base(i: LedgerRefs): Pick<LedgerEntryInsert, 'scope' | 'attemptId' | 'runId' | 'projectId' | 'priceCatalogVersion' | 'createdAt'> {
  return {
    scope: i.scope ?? 'run',
    attemptId: i.attemptId,
    runId: i.runId,
    projectId: i.projectId,
    priceCatalogVersion: i.priceCatalogVersion,
    createdAt: i.createdAt,
  };
}

/** Admission: `reserve: reserved +N`. */
export function reserveEntries(i: LedgerRefs & { readonly N: Microusd }): LedgerEntryInsert[] {
  return [{ ...base(i), type: 'reserve', bucket: 'reserved', deltaMicrousd: i.N }];
}

/** Run start: `allowance_set: allowance +L`. */
export function allowanceSetEntries(i: LedgerRefs & { readonly L: Microusd }): LedgerEntryInsert[] {
  return [{ ...base(i), type: 'allowance_set', bucket: 'allowance', deltaMicrousd: i.L }];
}

/** F5 table: the step-7 settlement group for one attempt (one group_id, assigned by LedgerRepo.append). */
export function settlementEntries(i: LedgerRefs & { readonly reservation: Microusd; readonly cost: SettleAmount }): LedgerEntryInsert[] {
  const b = base(i);
  const release: LedgerEntryInsert = { ...b, type: 'release', bucket: 'reserved', deltaMicrousd: neg(i.reservation) };
  switch (i.cost.kind) {
    case 'known':
      return [release, { ...b, type: 'settle', bucket: 'settled', deltaMicrousd: i.cost.microusd, certainty: i.cost.certainty }];
    case 'not_charged':
      return [release];
    case 'unknown':
      // §9.3 "do not count in both R and U": the full N moves.
      return [
        { ...b, type: 'move_to_unknown', bucket: 'reserved', deltaMicrousd: neg(i.reservation) },
        { ...b, type: 'move_to_unknown', bucket: 'unknown', deltaMicrousd: i.reservation, certainty: 'unknown' },
      ];
  }
}

/** Unknown → resolved: `resolve_unknown: unknown −N` + `settle +X` with the given certainty. */
export function resolveUnknownEntries(
  i: LedgerRefs & { readonly liability: Microusd; readonly settled: Microusd; readonly certainty: CostCertainty },
): LedgerEntryInsert[] {
  const b = base(i);
  return [
    { ...b, type: 'resolve_unknown', bucket: 'unknown', deltaMicrousd: neg(i.liability) },
    { ...b, type: 'settle', bucket: 'settled', deltaMicrousd: i.settled, certainty: i.certainty },
  ];
}

/** `L − C − R − U` (negative on overrun, §9.5). */
export function remaining(b: Balances): Microusd {
  return subMicrousd(subMicrousd(subMicrousd(b.L, b.C), b.R), b.U);
}
