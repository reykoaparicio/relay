import { describe, expect, it, vi } from 'vitest';
import { PROVIDER_IDS } from '@relay/contracts';
import { manualClock } from './__fixtures__/mock-fetch.js';
import { createMemoryCallLog } from './call-log.js';
import { createProviderRegistry } from './registry.js';
import type { ModelRequest } from './types.js';

const req = (stepKey: string, attemptId: string, providerId: ModelRequest['providerId'] = 'anthropic'): ModelRequest => ({
  providerId,
  modelId: 'm',
  system: 's',
  messages: [{ role: 'user', content: 'c' }],
  outputSchema: { name: 'findings.v1', jsonSchema: {} },
  maxOutputTokens: 1000,
  refusalFallback: 'off',
  metadata: { attemptId, runId: 'run_1', stepKey, purpose: 'initial' },
});

const ctx = () => ({ apiKey: 'k', signal: new AbortController().signal });

describe('createProviderRegistry (fake mode)', () => {
  it('returns a fake adapter per provider id that reports the real id', () => {
    const registry = createProviderRegistry({ mode: 'fake', clock: manualClock() });

    expect(registry.list()).toEqual([...PROVIDER_IDS]);
    for (const id of PROVIDER_IDS) expect(registry.get(id).providerId).toBe(id);
    expect(registry.get('anthropic')).toBe(registry.get('anthropic'));
  });

  it('shares one scenario cursor and one call log across providers', async () => {
    const callLog = createMemoryCallLog();
    const registry = createProviderRegistry({ mode: 'fake', clock: manualClock(), fakeScenario: 'revise-then-accept', callLog });

    const first = await registry.get('anthropic').generate(req('verify', 'att_1'), ctx());
    const second = await registry.get('openai').generate(req('verify', 'att_2', 'openai'), ctx());

    expect(first).toMatchObject({ kind: 'success', json: { outcome: 'revise' } });
    expect(second).toMatchObject({ kind: 'success', json: { outcome: 'accept' } });
    expect(callLog.entries().map((c) => c.providerId)).toEqual(['anthropic', 'openai']);
  });

  it('accepts an inline scenario and forwards extraFixtures', async () => {
    const registry = createProviderRegistry({
      mode: 'fake',
      clock: manualClock(),
      fakeScenario: { name: 'inline', steps: [{ result: { kind: 'success', fixture: 'variant' } }] },
      extraFixtures: { variant: { outcome: 'variant' } },
    });

    await expect(registry.get('gemini').generate(req('review', 'att_1', 'gemini'), ctx())).resolves.toMatchObject({ json: { outcome: 'variant' } });
  });

  it('throws on an unknown fake scenario name', () => {
    expect(() => createProviderRegistry({ mode: 'fake', clock: manualClock(), fakeScenario: 'nope' })).toThrow(/unknown fake scenario/);
  });

  it('passes fakeCapabilityOverrides through, merged over the scenario overrides', async () => {
    const registry = createProviderRegistry({
      mode: 'fake',
      clock: manualClock(),
      fakeScenario: 'reconcile-completed',
      fakeCapabilityOverrides: { supportsTokenCounting: true },
    });

    await expect(registry.get('openai').capabilities('fake-model')).resolves.toMatchObject({
      supportsRequestLookup: true,
      supportsTokenCounting: true,
    });
  });

  it('passes injected timers to the fake adapters', async () => {
    const setTimeoutSpy = vi.fn((cb: () => void) => {
      cb();
      return 1;
    });
    const registry = createProviderRegistry({
      mode: 'fake',
      clock: manualClock(),
      fakeScenario: 'slow-review',
      timers: { setTimeout: setTimeoutSpy, clearTimeout: vi.fn() },
    });

    await registry.get('anthropic').generate(req('review', 'att_1'), ctx());

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
  });
});

describe('createProviderRegistry (live mode)', () => {
  it('ignores fake options and returns real adapters', () => {
    const callLog = createMemoryCallLog();
    const append = vi.spyOn(callLog, 'append');

    const registry = createProviderRegistry({ mode: 'live', clock: manualClock(), fakeScenario: 'nope-ignored', callLog });

    expect(registry.list()).toEqual(['anthropic', 'openai', 'gemini']);
    const adapter = registry.get('anthropic');
    expect(adapter.providerId).toBe('anthropic');
    expect('reconcile' in adapter).toBe(false);
    expect(registry.get('anthropic')).toBe(adapter);
    const openai = registry.get('openai');
    expect(openai.providerId).toBe('openai');
    expect(typeof openai.reconcile).toBe('function');
    expect(registry.get('openai')).toBe(openai);
    const gemini = registry.get('gemini');
    expect(gemini.providerId).toBe('gemini');
    expect('reconcile' in gemini).toBe(false); // no lookup endpoint: unknown outcomes go to the user (04 §D10)
    expect(registry.get('gemini')).toBe(gemini);
    expect(append).not.toHaveBeenCalled();
  });

  it('throws for providers without a live adapter yet', () => {
    const registry = createProviderRegistry({ mode: 'live', clock: manualClock() });

    expect(() => registry.get('fake')).toThrow(/no live adapter/);
  });
});
