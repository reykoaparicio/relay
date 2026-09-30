import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as providers from '@relay/providers';
import * as contracts from '@relay/contracts';
import { computeCost, epochMs, microusd, usd } from '@relay/contracts';
import type { AttemptId, Microusd, ModelPrices, ProjectId, RunId } from '@relay/contracts';
import type { SettleAmount } from './budget.js';
import {
  admit,
  admitSetup,
  allowanceSetEntries,
  isOverrun,
  remaining,
  reserveEntries,
  resolveUnknownEntries,
  settleAmount,
  settlementEntries,
} from './budget.js';
import * as budget from './budget.js';
import { monthWindow, monthWindowOf } from './clock.js';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

const m = (n: number): Microusd => microusd(n);
const ZERO = { C: m(0), R: m(0), U: m(0) };
const REFS = {
  attemptId: 'att_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as AttemptId,
  runId: 'run_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as RunId,
  projectId: 'prj_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as ProjectId,
  priceCatalogVersion: '2026-09-25',
  createdAt: epochMs(1),
};
const PRICES: ModelPrices = { input: m(1_000_000), output: m(5_000_000), cacheRead: m(100_000), cacheWrite: m(1_250_000) };
const USAGE = { uncachedInputTokens: 1200, cacheReadInputTokens: 10, cacheWriteInputTokens: 5, outputTokens: 600 };

describe('admit (§9.3)', () => {
  it('blocks the §9.4 example: L=3.00, C=1.20, R=0.40, U=0, N=1.50 → total 3.10', () => {
    const d = admit({ run: { L: usd('3.00'), C: usd('1.20'), R: usd('0.40'), U: m(0) }, project: null, N: usd('1.50') });

    expect(d.ok).toBe(false);
    expect(d.breakdown).toEqual({ L: 3_000_000, C: 1_200_000, R: 400_000, U: 0, N: 1_500_000, scope: 'run', total: 3_100_000, allowed: false });
  });

  it('allows exact equality (inclusive inequality)', () => {
    const d = admit({ run: { L: usd('3.00'), C: usd('1.20'), R: usd('0.40'), U: usd('0.10'), }, project: null, N: usd('1.30') });

    expect(d.ok).toBe(true);
    expect(d.breakdown.total).toBe(3_000_000);
  });

  it('blocks on the project month independently of the run', () => {
    const d = admit({ run: { L: usd('3.00'), ...ZERO }, project: { L: usd('1.00'), C: usd('0.90'), R: m(0), U: m(0) }, N: usd('0.20') });

    expect(d.ok).toBe(false);
    expect(d.breakdown.scope).toBe('project');
    expect(d.breakdown.total).toBe(1_100_000);
  });

  it('reports the run check first when both fail', () => {
    const d = admit({ run: { L: m(10), ...ZERO }, project: { L: m(10), ...ZERO }, N: m(11) });

    expect(d.breakdown.scope).toBe('run');
  });

  it('admits when both scopes pass', () => {
    expect(admit({ run: { L: m(10), ...ZERO }, project: { L: m(10), ...ZERO }, N: m(10) }).ok).toBe(true);
  });

  it('admitSetup checks the setup allowance', () => {
    expect(admitSetup({ setup: { C: m(40_000), R: m(0), U: m(5_000) }, L: m(50_000), N: m(5_000) }).ok).toBe(true);
    const blocked = admitSetup({ setup: { C: m(40_000), R: m(0), U: m(5_000) }, L: m(50_000), N: m(5_001) });
    expect(blocked.ok).toBe(false);
    expect(blocked.breakdown).toMatchObject({ scope: 'setup', allowed: false, total: 50_001 });
  });

  it('property: C + R + U ≤ L holds after every admitted reservation', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.array(fc.integer({ min: 0, max: 2_000_000 }), { maxLength: 40 }), (L, ns) => {
      let R = 0;
      for (const n of ns) {
        const d = admit({ run: { L: m(L), C: m(0), R: m(R), U: m(0) }, project: null, N: m(n) });
        if (d.ok) R += n;
        expect(R).toBeLessThanOrEqual(L);
      }
    }));
  });
});

describe('settlement (F5 table)', () => {
  const known = (x: number): SettleAmount => ({ kind: 'known', microusd: m(x), certainty: 'calculated' });

  it('admit: reserve +N', () => {
    expect(reserveEntries({ ...REFS, N: m(500) })).toEqual([expect.objectContaining({ type: 'reserve', bucket: 'reserved', deltaMicrousd: 500, scope: 'run' })]);
  });

  it('success X ≤ N: release −N, settle +X (calculated)', () => {
    expect(settlementEntries({ ...REFS, reservation: m(500), cost: known(300) }).map((e) => [e.type, e.bucket, e.deltaMicrousd, e.certainty ?? null]))
      .toEqual([['release', 'reserved', -500, null], ['settle', 'settled', 300, 'calculated']]);
  });

  it('overrun X > N: the recorded number is never capped', () => {
    const entries = settlementEntries({ ...REFS, reservation: m(500), cost: known(900) });

    expect(entries.map((e) => e.deltaMicrousd)).toEqual([-500, 900]);
    expect(isOverrun(known(900), m(500))).toBe(true);
    expect(isOverrun(known(500), m(500))).toBe(false);
    expect(isOverrun({ kind: 'unknown' }, m(500))).toBe(false);
  });

  it('not sent / known failure without usage: release −N only', () => {
    expect(settlementEntries({ ...REFS, reservation: m(500), cost: { kind: 'not_charged' } }).map((e) => [e.type, e.deltaMicrousd])).toEqual([['release', -500]]);
  });

  it('outcome unknown: move_to_unknown moves the full N (reserved −N, unknown +N)', () => {
    expect(settlementEntries({ ...REFS, reservation: m(500), cost: { kind: 'unknown' } }).map((e) => [e.type, e.bucket, e.deltaMicrousd]))
      .toEqual([['move_to_unknown', 'reserved', -500], ['move_to_unknown', 'unknown', 500]]);
  });

  it('unknown resolved: resolve_unknown −N + settle +X with the given certainty', () => {
    expect(resolveUnknownEntries({ ...REFS, liability: m(500), settled: m(500), certainty: 'estimated' }).map((e) => [e.type, e.bucket, e.deltaMicrousd, e.certainty ?? null]))
      .toEqual([['resolve_unknown', 'unknown', -500, null], ['settle', 'settled', 500, 'estimated']]);
    expect(resolveUnknownEntries({ ...REFS, liability: m(500), settled: m(0), certainty: 'calculated' })[1]?.deltaMicrousd).toBe(0);
  });

  it('allowance_set +L and setup-scope movements with null run/attempt', () => {
    expect(allowanceSetEntries({ ...REFS, attemptId: null, L: m(3_000_000) })[0]).toEqual(expect.objectContaining({ type: 'allowance_set', bucket: 'allowance', deltaMicrousd: 3_000_000 }));
    const setup = settlementEntries({ ...REFS, attemptId: null, runId: null, projectId: null, scope: 'setup', reservation: m(10), cost: known(7) });
    expect(setup.every((e) => e.scope === 'setup' && e.runId === null && e.attemptId === null)).toBe(true);
  });

  it('settleAmount prices known usage (calculated) and passes unknown / not charged through', () => {
    expect(settleAmount({ charge: { kind: 'known', usage: USAGE } }, PRICES)).toEqual({ kind: 'known', microusd: computeCost(USAGE, PRICES).microusd, certainty: 'calculated' });
    expect(settleAmount({ charge: { kind: 'unknown' } }, PRICES)).toEqual({ kind: 'unknown' });
    expect(settleAmount({ charge: { kind: 'not_charged' } }, PRICES)).toEqual({ kind: 'not_charged' });
  });

  it('remaining = L − C − R − U (negative on overrun)', () => {
    expect(remaining({ L: m(100), C: m(90), R: m(20), U: m(5) })).toBe(-15);
  });
});

describe('pricing is shared through @relay/contracts (no mirrored copy)', () => {
  it('the engine budget module no longer defines its own computeCost / upperBound; providers re-exports the contracts functions', () => {
    expect('computeCost' in budget).toBe(false);
    expect('upperBound' in budget).toBe(false);
    expect(providers.computeCost).toBe(contracts.computeCost);
    expect(providers.upperBound).toBe(contracts.upperBound);
  });

  it('settleAmount without fallback iterations equals contracts computeCost for any usage (property)', () => {
    fc.assert(fc.property(
      fc.record({ a: fc.integer({ min: 0, max: 200_000 }), b: fc.integer({ min: 0, max: 200_000 }), c: fc.integer({ min: 0, max: 200_000 }), o: fc.integer({ min: 0, max: 64_000 }) }),
      ({ a, b, c, o }) => {
        const usage = { uncachedInputTokens: a, cacheReadInputTokens: b, cacheWriteInputTokens: c, outputTokens: o };
        const s = settleAmount({ charge: { kind: 'known', usage } }, PRICES);
        return s.kind === 'known' && s.microusd === contracts.computeCost(usage, PRICES).microusd;
      },
    ));
  });
});

describe('settleAmount with ADR-016 fallback iterations (B5)', () => {
  const OTHER: ModelPrices = { input: m(3_000_000), output: m(15_000_000), cacheRead: m(300_000), cacheWrite: m(3_750_000) };
  const use = (input: number, output: number) => ({ uncachedInputTokens: input, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: output });
  const lookup = {
    profileModelId: 'profile-model',
    pricesFor: (id: string) => (id === 'fallback-model' ? OTHER : undefined),
    providerPrices: () => [OTHER],
  };

  it('prices every served iteration with its own model (calculated)', () => {
    const iterations = [{ modelId: 'profile-model', usage: use(1000, 10) }, { modelId: 'fallback-model', usage: use(1000, 200) }];
    const total = use(2000, 210);

    const cost = settleAmount({ charge: { kind: 'known', usage: total, iterations } }, PRICES, lookup);

    const expected = computeCost(iterations[0]!.usage, PRICES).microusd + computeCost(iterations[1]!.usage, OTHER).microusd;
    expect(cost).toEqual({ kind: 'known', microusd: expected, certainty: 'calculated' });
    expect(expected).toBeGreaterThan(computeCost(total, PRICES).microusd); // the old single-price settlement under-charged
  });

  it('prices an unknown fallback model at the provider maximum and marks the amount estimated', () => {
    const iterations = [{ modelId: 'profile-model', usage: use(100, 1) }, { modelId: 'future-model', usage: use(1000, 200) }];

    const cost = settleAmount({ charge: { kind: 'known', usage: use(1100, 201), iterations } }, PRICES, lookup);

    const max = contracts.maxPrices([PRICES, OTHER])!;
    expect(cost).toEqual({
      kind: 'known',
      microusd: computeCost(iterations[0]!.usage, PRICES).microusd + computeCost(iterations[1]!.usage, max).microusd,
      certainty: 'estimated',
    });
    expect(settlementEntries({ ...REFS, reservation: m(1), cost })[1]).toEqual(expect.objectContaining({ type: 'settle', certainty: 'estimated' }));
  });

  it('without a lookup every iteration is priced at the snapshot prices and marked estimated', () => {
    const iterations = [{ modelId: 'x', usage: use(10, 10) }];
    expect(settleAmount({ charge: { kind: 'known', usage: use(10, 10), iterations } }, PRICES))
      .toEqual({ kind: 'known', microusd: computeCost(use(10, 10), PRICES).microusd, certainty: 'estimated' });
  });
});

describe('project month (R4-4)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });

  it('filters C by the calendar-month window but counts outstanding R and U regardless of date', async () => {
    h = await createHarness();
    const runId = await h.startRun();
    const now = h.clock.now();
    const { start, end } = monthWindow(now);
    const lastMonth = epochMs(start - 86_400_000);
    const refs = { attemptId: null, runId, projectId: h.projectId, priceCatalogVersion: null };
    h.db.tx('immediate', (r) => {
      r.ledger.append([{ ...refs, scope: 'run', type: 'settle', bucket: 'settled', deltaMicrousd: 700, certainty: 'calculated', createdAt: lastMonth }]);
      r.ledger.append([{ ...refs, scope: 'run', type: 'reserve', bucket: 'reserved', deltaMicrousd: 50, createdAt: lastMonth }]);
      r.ledger.append([{ ...refs, scope: 'run', type: 'move_to_unknown', bucket: 'unknown', deltaMicrousd: 30, createdAt: lastMonth }]);
      r.ledger.append([{ ...refs, scope: 'run', type: 'settle', bucket: 'settled', deltaMicrousd: 11, certainty: 'calculated', createdAt: now }]);
    });

    const b = h.db.repos.ledger.projectMonthBalances(h.projectId, start, end);

    expect(b).toEqual({ C: 11, R: 50, U: 30 });
    expect(monthWindowOf('2026-09')).toEqual({ start: new Date(2026, 8, 1).getTime(), end: new Date(2026, 9, 1).getTime() });
  });
});
