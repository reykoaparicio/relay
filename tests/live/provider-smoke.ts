// 04 §D9: one connection test, one keyed estimate, one tiny structured generate, and one deliberately invalid model
// per provider, under a cumulative spend cap. Shared by anthropic.live.test.ts and openai.live.test.ts.
import { afterAll, describe, expect, it } from 'vitest';
import type { ModelPrices, ProviderId } from '@relay/contracts';
import { cheapestCatalogModel, computeCost, findCatalogEntry } from '@relay/providers';
import type { ModelRequest, ModelResult, NormalizedUsage, ProviderAdapter } from '@relay/providers';
import { createTemplateRegistry } from '@relay/templates';
import { LIVE, capFromEnv, liveKey, sampleInput20Lines, skipNotice, usd } from './live-env.js';

/** $0.10 default (§20.4: never spend without authorization). */
const DEFAULT_CAP_MICROUSD = 100_000;
const GENERATE_MAX_OUTPUT_TOKENS = 2_000;
const INVALID_MODEL_ID = 'relay-live-test-invalid-model';

function assertUsageSane(u: NormalizedUsage): void {
  for (const v of [u.uncachedInputTokens, u.cacheReadInputTokens, u.cacheWriteInputTokens, u.outputTokens, u.reasoningTokens ?? 0]) {
    expect(Number.isSafeInteger(v) && v >= 0).toBe(true);
  }
  expect(u.reasoningTokens ?? 0).toBeLessThanOrEqual(u.outputTokens);
}

function usageOf(r: ModelResult): NormalizedUsage | undefined {
  return r.kind === 'error' ? r.usage : r.usage;
}

/** Registers the smoke suite for one live adapter. */
export function defineProviderSmoke(providerId: ProviderId, makeAdapter: () => ProviderAdapter): void {
  const key = liveKey(providerId);
  skipNotice(providerId);

  describe.skipIf(!LIVE || key === undefined)(`live smoke: ${providerId}`, () => {
    const cap = capFromEnv('RELAY_LIVE_TEST_CAP_MICROUSD', DEFAULT_CAP_MICROUSD);
    const adapter = makeAdapter();
    const model = cheapestCatalogModel(providerId);
    let spent = 0;

    const charge = (r: ModelResult, prices: ModelPrices): void => {
      const u = usageOf(r);
      if (u !== undefined) spent += computeCost(u, prices).microusd;
      expect(spent, `cumulative live spend ${usd(spent)} exceeds cap ${usd(cap)}`).toBeLessThanOrEqual(cap);
    };

    afterAll(() => {
      process.stdout.write(`[live] ${providerId} connection-smoke total: ${usd(spent)} (cap ${usd(cap)})\n`);
    });

    it('has a catalog model', () => {
      expect(model).toBeDefined();
    });

    it('testConnection succeeds with the cheapest catalog model', async () => {
      if (model === undefined || key === undefined) return;
      const r = await adapter.testConnection({ apiKey: key, signal: AbortSignal.timeout(60_000), modelId: model.modelId });

      charge(r, model.prices);
      // A 16-token budget can be exhausted by reasoning on some models; truncated still proves key + model work.
      expect(['success', 'truncated']).toContain(r.kind);
      if (r.kind !== 'error') assertUsageSane(r.usage);
    });

    const request = (modelId: string): ModelRequest => {
      const templates = createTemplateRegistry();
      return {
        providerId,
        modelId,
        system: 'You are a careful code reviewer. Report concrete defects only, as JSON matching the schema.',
        messages: [{ role: 'user', content: `Review this excerpt of src/handlers/user.ts:\n\n${sampleInput20Lines()}` }],
        outputSchema: { name: 'findings.v1', jsonSchema: templates.jsonSchema('findings.v1') },
        maxOutputTokens: GENERATE_MAX_OUTPUT_TOKENS,
        refusalFallback: 'off',
        metadata: { attemptId: 'live_smoke_attempt', runId: 'live_smoke_run', stepKey: 'review', purpose: 'initial' },
      };
    };

    it('estimate with the key uses the provider count where supported', async () => {
      if (model === undefined || key === undefined) return;
      const est = await adapter.estimate(request(model.modelId), model.prices, { apiKey: key, signal: AbortSignal.timeout(30_000) });

      expect(est.basis).toBe(model.capabilities.supportsTokenCounting ? 'provider_count' : 'local_estimate');
      expect(est.inputTokens).toBeGreaterThan(0);
      expect(est.upperAllowanceMicrousd).toBeGreaterThan(0);
    });

    it('a tiny findings.v1 generate captures ids early and maps usage', async () => {
      if (model === undefined || key === undefined) return;
      const req = request(model.modelId);
      const est = await adapter.estimate(req, model.prices);
      // Admission-like guard: never dispatch a call whose upper bound could break the cap.
      expect(spent + est.upperAllowanceMicrousd, 'the generate upper bound would exceed the live cap').toBeLessThanOrEqual(cap);
      let settled = false;
      let earlyIds: { providerRequestId?: string; providerResponseId?: string } | undefined;

      const pending = adapter.generate(req, {
        apiKey: key,
        signal: AbortSignal.timeout(110_000),
        hooks: {
          onResponseId: (ids) => {
            if (!settled) earlyIds ??= ids;
          },
        },
      });
      const r = await pending;
      settled = true;

      charge(r, model.prices);
      expect(r.kind, JSON.stringify(r.kind === 'error' ? r.error : r.kind)).toBe('success');
      if (r.kind !== 'success') return;
      expect(earlyIds?.providerResponseId).toBeTruthy();
      expect(r.providerResponseId).toBe(earlyIds?.providerResponseId);
      expect(r.providerRequestId).toMatch(/^req_/); // from the request-id / x-request-id header
      expect(r.json).toBeTypeOf('object');
      assertUsageSane(r.usage);
      expect(r.usage.uncachedInputTokens + r.usage.cacheReadInputTokens + r.usage.cacheWriteInputTokens).toBeGreaterThan(0);
    });

    it('an invalid model id returns a mapped error with a redacted provider body (no key)', async () => {
      if (key === undefined) return;
      const r = await adapter.generate({ ...request(INVALID_MODEL_ID), maxOutputTokens: 16 }, { apiKey: key, signal: AbortSignal.timeout(30_000) });

      expect(r.kind).toBe('error');
      if (r.kind !== 'error') return;
      expect(r.phase).toBe('responded');
      expect(r.error.code).toBe('MODEL_UNSUPPORTED');
      expect(JSON.stringify(r)).not.toContain(key);
      expect(findCatalogEntry(providerId, INVALID_MODEL_ID)).toBeUndefined();
    });
  });
}
