// F18: providers.test — setup allowance admission over this month's scope='setup' entries, settle / release /
// unknown moves with run_id and attempt_id NULL, and the credential test record.
import { afterEach, describe, expect, it } from 'vitest';
import { errors, microusd } from '@relay/contracts';
import type { ModelResult } from '@relay/providers';
import { recoverSetupReservations } from './recovery.js';
import { modelForTest, setupCharge, testProviderConnection } from './setup-calls.js';
import { createHarness } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';
import { wrapAdapters } from './testing/drive.js';
import { SETTINGS_KEY } from './settings.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function harness(o: HarnessOptions = {}): Promise<Harness> {
  h = await createHarness(o);
  return h;
}

describe('providers.test (F18)', () => {
  it('reserves N against the setup allowance, settles the known usage (calculated), and records the test', async () => {
    const x = await harness({ credentialRefs: [] });

    const res = await x.engine.handle('relay/v1/providers.test', { providerId: 'anthropic' });

    expect(res.ok && res.data).toEqual(expect.objectContaining({ ok: true, certainty: 'calculated', modelProbed: modelForTest(x.db.repos, 'anthropic')?.modelId }));
    const cost = res.ok ? res.data.costMicrousd : -1;
    expect(cost).toBeGreaterThan(0);
    const month = x.db.repos.ledger.setupBalances(0 as never, Number.MAX_SAFE_INTEGER as never);
    expect(month).toEqual({ C: cost, R: 0, U: 0 });
    expect(x.db.repos.ledger.runBalances('run_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as never).C).toBe(0);
    expect(x.db.repos.credentials.get('anthropic')?.lastTest ?? null).toBeNull(); // no ref yet: nothing to record on
  });

  it('records the result on the provider credential ref when one exists', async () => {
    const x = await harness();
    await x.engine.handle('relay/v1/providers.recordCredentialRef', { providerId: 'anthropic', storageMode: 'session', vaultFile: null, redactedLabel: 'sk-…' });

    await x.engine.handle('relay/v1/providers.test', { providerId: 'anthropic' });

    expect(x.db.repos.credentials.get('anthropic')?.lastTest).toEqual(expect.objectContaining({ ok: true, code: null }));
  });

  it('BUDGET_BLOCKED (scope setup) without any call when C + R + U + N > L', async () => {
    let calls = 0;
    const x = await harness({ providers: wrapAdapters({ testConnection: (base, t) => {
      calls += 1;
      return base.get('anthropic').testConnection(t);
    } }) });
    x.db.repos.settings.set(SETTINGS_KEY, { setupAllowanceMicrousd: 1 });

    const res = await x.engine.handle('relay/v1/providers.test', { providerId: 'anthropic' });

    expect(res.ok ? null : [res.error.code, res.error.details?.['scope']]).toEqual(['BUDGET_BLOCKED', 'setup']);
    expect(calls).toBe(0);
    expect(x.db.repos.ledger.setupBalances(0 as never, Number.MAX_SAFE_INTEGER as never)).toEqual({ C: 0, R: 0, U: 0 });
  });

  it('AUTH_REQUIRED when the credential cannot be resolved (connection_test purpose, no attempt id)', async () => {
    const seen: unknown[] = [];
    const x = await harness({ credentials: { resolve: (req) => {
      seen.push(req);
      return Promise.resolve({ ok: false, error: errors.authRequired(req.providerId) });
    } } });

    const res = await x.engine.handle('relay/v1/providers.test', { providerId: 'openai' });

    expect(res.ok ? null : res.error.code).toBe('AUTH_REQUIRED');
    expect(seen).toEqual([{ providerId: 'openai', purpose: 'connection_test', attemptId: null }]);
  });

  it('an ambiguous outcome moves the full N to the setup liability (move_to_unknown), never released', async () => {
    const x = await harness({ providers: wrapAdapters({ testConnection: () =>
      Promise.resolve({ kind: 'error', error: errors.providerUnavailable('anthropic'), phase: 'sent_no_response' }) }) });

    const res = await x.engine.handle('relay/v1/providers.test', { providerId: 'anthropic' });

    expect(res.ok && [res.data.ok, res.data.certainty, res.data.error?.code]).toEqual([false, 'unknown', 'PROVIDER_UNAVAILABLE']);
    const b = x.db.repos.ledger.setupBalances(0 as never, Number.MAX_SAFE_INTEGER as never);
    expect([b.R, b.U, b.C]).toEqual([0, res.ok ? res.data.costMicrousd : -1, 0]);
  });

  it('aborts a hanging test after 15 s on the injected timers (unknown), and a not-sent failure releases', async () => {
    const x = await harness({ providers: wrapAdapters({ testConnection: (_base, t) => new Promise<ModelResult>((resolve) => {
      t.signal.addEventListener('abort', () => {
        resolve({ kind: 'error', error: errors.providerUnavailable('anthropic'), phase: 'sent_no_response' });
      });
    }) }) });

    const p = x.engine.handle('relay/v1/providers.test', { providerId: 'anthropic' });
    await x.waitFor(() => x.db.repos.ledger.setupBalances(0 as never, Number.MAX_SAFE_INTEGER as never).R > 0);
    x.timers.advance(15_000);
    const res = await p;

    expect(res.ok && res.data.certainty).toBe('unknown');
  });

  it('truncated counts as a working connection; usageKnown=false settles N as estimated; an unknown model is MODEL_UNSUPPORTED', async () => {
    const x = await harness({ providers: wrapAdapters({ testConnection: () =>
      Promise.resolve({ kind: 'truncated', rawText: '{"ok"', usage: { uncachedInputTokens: 20, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 16 }, rawUsage: null }) }) });

    const res = await x.engine.handle('relay/v1/providers.test', { providerId: 'anthropic' });
    const unknownModel = await testProviderConnection(x.ctx, { providerId: 'anthropic', modelId: 'no-such-model' });

    expect(res.ok && [res.data.ok, res.data.certainty]).toEqual([true, 'calculated']);
    expect(unknownModel.ok ? null : unknownModel.error.code).toBe('MODEL_UNSUPPORTED');
    const prices = { input: microusd(1), output: microusd(1), cacheRead: microusd(1), cacheWrite: microusd(1) };
    const success = { kind: 'success', json: {}, rawText: '{}', usage: { uncachedInputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1 },
      rawUsage: null, stopReason: 'end_turn', latencyMs: 0 } as const;
    expect(setupCharge({ ...success, usageKnown: false }, false, { prices }, microusd(77))).toEqual({ kind: 'known', microusd: 77, certainty: 'estimated' });
    expect(setupCharge({ ...success, priceTierMismatch: true }, false, { prices }, microusd(77))).toEqual(expect.objectContaining({ certainty: 'estimated' }));
    expect(setupCharge({ kind: 'error', error: errors.authRequired('anthropic'), phase: 'responded' }, false, { prices }, microusd(77))).toEqual({ kind: 'not_charged' });
    expect(setupCharge({ kind: 'error', error: errors.providerUnavailable(), phase: 'responded', usage: success.usage }, false, { prices }, microusd(77)))
      .toEqual({ kind: 'known', microusd: 2, certainty: 'calculated' });
  });

  it('recovery moves an orphaned setup reservation (runner died mid-test) to the setup liability', async () => {
    const x = await harness();
    x.db.tx('immediate', (r) => r.ledger.append([{ scope: 'setup', type: 'reserve', bucket: 'reserved', deltaMicrousd: 500, createdAt: x.clock.now() }]));

    expect(recoverSetupReservations(x.ctx)).toBe(500);
    expect(recoverSetupReservations(x.ctx)).toBe(0);
    expect(x.db.repos.ledger.setupBalances(0 as never, Number.MAX_SAFE_INTEGER as never)).toEqual({ C: 0, R: 0, U: 500 });
  });
});
