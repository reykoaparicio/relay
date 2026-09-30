// 04 §D9: one connection test, one keyed estimate, one tiny structured generate, and one deliberately invalid model
// per provider, under ONE cumulative spend cap shared by every provider (providers.live.test.ts runs them all in one
// file, so one `LiveBudget` sees every call). Every billable call is pre-checked against the cap with its estimate's
// upper bound BEFORE dispatch, and charged conservatively afterwards (live-budget.ts).
import { describe, expect, it } from 'vitest';
import type { ProviderId } from '@relay/contracts';
import { cheapestCatalogModel, connectionTestRequest, findCatalogEntry } from '@relay/providers';
import type { ModelRequest, NormalizedUsage, ProviderAdapter } from '@relay/providers';
import { createTemplateRegistry } from '@relay/templates';
import type { LiveBudget } from './live-budget.js';
import { LIVE, liveKey, sampleInput20Lines, skipNotice } from './live-env.js';

/** $0.10 default (§20.4: never spend without authorization). */
export const DEFAULT_SMOKE_CAP_MICROUSD = 100_000;
const GENERATE_MAX_OUTPUT_TOKENS = 2_000;
const INVALID_MODEL_ID = 'relay-live-test-invalid-model';

function assertUsageSane(u: NormalizedUsage): void {
  for (const v of [u.uncachedInputTokens, u.cacheReadInputTokens, u.cacheWriteInputTokens, u.outputTokens, u.reasoningTokens ?? 0]) {
    expect(Number.isSafeInteger(v) && v >= 0).toBe(true);
  }
  expect(u.reasoningTokens ?? 0).toBeLessThanOrEqual(u.outputTokens);
}

/** Registers the smoke suite for one live adapter; `budget` is shared by every provider of the file. */
export function defineProviderSmoke(providerId: ProviderId, makeAdapter: () => ProviderAdapter, budget: LiveBudget): void {
  const key = liveKey(providerId);
  skipNotice(providerId);

  describe.skipIf(!LIVE || key === undefined)(`live smoke: ${providerId}`, () => {
    const adapter = makeAdapter();
    const model = cheapestCatalogModel(providerId);

    it('has a catalog model', () => {
      expect(model).toBeDefined();
    });

    it('testConnection succeeds with the cheapest catalog model', async () => {
      if (model === undefined || key === undefined) return;
      // The request testConnection sends (provider-specific output allowance), so N bounds the real call.
      const est = await adapter.estimate(connectionTestRequest(providerId, model.modelId), model.prices);
      budget.admit(est.upperAllowanceMicrousd, `${providerId} testConnection`);
      const r = await adapter.testConnection({ apiKey: key, signal: AbortSignal.timeout(60_000), modelId: model.modelId });

      budget.charge(r, model.prices, est.upperAllowanceMicrousd);
      // A small output allowance can be exhausted by reasoning on some models; truncated still proves key + model work.
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
      budget.admit(est.upperAllowanceMicrousd, `${providerId} generate`);
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

      budget.charge(r, model.prices, est.upperAllowanceMicrousd);
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
      if (key === undefined || model === undefined) return;
      const req: ModelRequest = { ...request(INVALID_MODEL_ID), maxOutputTokens: 16 };
      // Priced as the cheapest catalog model: the call should be rejected, but it is still pre-checked and charged.
      const est = await adapter.estimate({ ...req, modelId: model.modelId }, model.prices);
      budget.admit(est.upperAllowanceMicrousd, `${providerId} invalid-model generate`);
      const r = await adapter.generate(req, { apiKey: key, signal: AbortSignal.timeout(30_000) });

      budget.charge(r, model.prices, est.upperAllowanceMicrousd);

      expect(r.kind).toBe('error');
      if (r.kind !== 'error') return;
      expect(r.phase).toBe('responded');
      expect(r.error.code).toBe('MODEL_UNSUPPORTED');
      expect(JSON.stringify(r)).not.toContain(key);
      expect(findCatalogEntry(providerId, INVALID_MODEL_ID)).toBeUndefined();
    });
  });
}
