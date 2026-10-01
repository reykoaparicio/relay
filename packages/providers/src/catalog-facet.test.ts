import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayError, catalogFileSchema } from '@relay/contracts';
import type { ModelPrices } from '@relay/contracts';
import testCatalog from '../catalog/test-fixture.json' with { type: 'json' };
import * as catalogModule from './catalog.js';
import { catalogCapabilities, estimateWith, testConnectionAtLowestEffort } from './catalog-facet.js';
import { conservativeInputTokens, localInputTokens } from './estimate.js';
import type { ModelRequest, ModelResult } from './types.js';

const PRICES: ModelPrices = catalogFileSchema.parse(testCatalog).entries[0]!.prices;

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  providerId: 'openai',
  modelId: 'gpt-6.1-sol',
  system: 'sys',
  messages: [{ role: 'user', content: '漢'.repeat(500) }],
  outputSchema: { name: 's', jsonSchema: { type: 'object' } },
  maxOutputTokens: 100,
  refusalFallback: 'off',
  metadata: { attemptId: 'a', runId: 'r', stepKey: 'k', purpose: 'initial' },
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('estimateWith (04 R4-12 + count-failure fallback ADR note)', () => {
  const failing = () => Promise.reject(new TypeError('network down'));

  it('uses the provider count when a key is given and the model supports counting', async () => {
    const est = await estimateWith({ providerId: 'openai', logger: { warn: vi.fn() }, countTokens: () => Promise.resolve(42) }, request(), PRICES, { apiKey: 'k' });

    expect(est).toMatchObject({ basis: 'provider_count', inputTokens: 42 });
  });

  it('never calls the count without a key, and uses the heuristic', async () => {
    const countTokens = vi.fn(() => Promise.resolve(1));

    const est = await estimateWith({ providerId: 'openai', logger: { warn: vi.fn() }, countTokens }, request(), PRICES);

    expect(countTokens).not.toHaveBeenCalled();
    expect(est).toMatchObject({ basis: 'local_estimate', inputTokens: localInputTokens(request()) });
  });

  it('on a count failure: conservative bound iff the catalog sets priceCliffInputTokens; the error name is logged', async () => {
    const warn = vi.fn();
    const cliff = await estimateWith({ providerId: 'openai', logger: { warn }, countTokens: failing }, request(), PRICES, { apiKey: 'k' });
    const flat = await estimateWith(
      { providerId: 'gemini', logger: { warn }, countTokens: failing },
      request({ providerId: 'gemini', modelId: 'gemini-3.5-flash' }),
      PRICES,
      { apiKey: 'k' },
    );

    expect(cliff).toMatchObject({ basis: 'local_estimate', inputTokens: conservativeInputTokens(request()) });
    expect(flat).toMatchObject({ basis: 'local_estimate', inputTokens: localInputTokens(request({ providerId: 'gemini', modelId: 'gemini-3.5-flash' })) });
    expect(warn).toHaveBeenCalledWith('provider.count_tokens_failed', { providerId: 'openai', errorName: 'TypeError' });
  });

  it('a model without token counting never calls the count', async () => {
    const entry = catalogModule.findCatalogEntry('openai', 'gpt-6.1-sol')!;
    vi.spyOn(catalogModule, 'findCatalogEntry').mockReturnValue({ ...entry, capabilities: { ...entry.capabilities, supportsTokenCounting: false } });
    const countTokens = vi.fn(() => Promise.resolve(1));

    const est = await estimateWith({ providerId: 'openai', logger: { warn: vi.fn() }, countTokens }, request(), PRICES, { apiKey: 'k' });

    expect(countTokens).not.toHaveBeenCalled();
    expect(est.basis).toBe('local_estimate');
  });
});

describe('catalogCapabilities / testConnectionAtLowestEffort', () => {
  it('resolves catalog capabilities and rejects an unknown model with MODEL_UNSUPPORTED not_in_catalog', async () => {
    await expect(catalogCapabilities('openai', 'gpt-6.1-sol')).resolves.toMatchObject({ priceCliffInputTokens: 272_000 });
    const e: unknown = await catalogCapabilities('openai', 'nope').catch((x: unknown) => x);

    expect(e).toBeInstanceOf(RelayError);
    expect((e as RelayError).appError.details).toMatchObject({ providerId: 'openai', modelId: 'nope', reason: 'not_in_catalog' });
  });

  it('sends the connection-test request at the lowest listed effort, and without effort for unknown models', async () => {
    const seen: ModelRequest[] = [];
    const generate = (req: ModelRequest): Promise<ModelResult> => {
      seen.push(req);
      return Promise.resolve({ kind: 'error', error: { code: 'INTERNAL', userMessage: '', retryable: false, nextAction: 'report_bug', alternatives: [] }, phase: 'not_sent' });
    };
    const ctx = { apiKey: 'k', signal: new AbortController().signal };

    await testConnectionAtLowestEffort('gemini', generate, { ...ctx, modelId: 'gemini-3.5-flash' });
    await testConnectionAtLowestEffort('gemini', generate, { ...ctx, modelId: 'gemini-unknown' });

    expect(seen[0]).toMatchObject({ modelId: 'gemini-3.5-flash', effort: 'low', maxOutputTokens: 256 });
    expect(seen[1]?.effort).toBeUndefined();
  });
});
