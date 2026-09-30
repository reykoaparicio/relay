import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttemptPurpose, ModelPrices } from '@relay/contracts';
import { manualClock } from './__fixtures__/mock-fetch.js';
import { createJsonlCallLog, createMemoryCallLog } from './call-log.js';
import type { FakeCallLog } from './call-log.js';
import { FAKE_CRASH_EXIT_CODE, createFakeProvider } from './fake.js';
import type { FakeProviderOptions } from './fake.js';
import { FAKE_FIXTURES } from './fake-fixtures/index.js';
import { FAKE_SCENARIOS } from './fake-scenarios.js';
import type { FakeScenario, FakeStepResult } from './fake-scenarios.js';
import type { GenerateHooks, ModelRequest, ModelResult, ProviderAdapter, Timers } from './types.js';

/** Manual timers: nothing fires until `advance` (no global fake timers, R4-36). */
function manualTimers(): Timers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let seq = 0;
  const queue = new Map<number, { at: number; cb: () => void }>();
  return {
    setTimeout: (cb, ms) => {
      seq += 1;
      queue.set(seq, { at: now + ms, cb });
      return seq;
    },
    clearTimeout: (h) => {
      queue.delete(h as number);
    },
    advance: (ms) => {
      now += ms;
      for (const [id, t] of [...queue]) {
        if (t.at <= now) {
          queue.delete(id);
          t.cb();
        }
      }
    },
    pending: () => queue.size,
  };
}

const SCHEMA_BY_STEP: Record<string, string> = { review: 'findings.v1', plan: 'plan.v1', implement: 'patch.v1', verify: 'review.v1' };
let seq = 0;

const req = (stepKey: string, purpose: AttemptPurpose = 'initial', over: Partial<ModelRequest> = {}): ModelRequest => {
  seq += 1;
  return {
    providerId: 'anthropic',
    modelId: 'claude-opus-5-5',
    system: `system for ${stepKey}`,
    messages: [{ role: 'user', content: 'x'.repeat(10_000) }],
    outputSchema: { name: SCHEMA_BY_STEP[stepKey] ?? stepKey, jsonSchema: {} },
    maxOutputTokens: 8000,
    refusalFallback: 'off',
    metadata: { attemptId: `att_${String(seq)}`, runId: 'run_1', stepKey, purpose },
    ...over,
  };
};

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(scenario: FakeScenario | string, over: Partial<FakeProviderOptions> = {}) {
  const timers = manualTimers();
  const callLog = over.callLog ?? createMemoryCallLog();
  const exit = vi.fn<(code: number) => never>();
  const provider = createFakeProvider({
    providerId: 'anthropic',
    scenario: typeof scenario === 'string' ? FAKE_SCENARIOS[scenario]! : scenario,
    clock: manualClock(),
    timers,
    callLog,
    exit,
    ...over,
  });
  return { provider, timers, callLog, exit };
}

const gen = (p: ProviderAdapter, r: ModelRequest, hooks?: GenerateHooks, signal = new AbortController().signal): Promise<ModelResult> =>
  p.generate(r, { apiKey: 'test-key', signal, ...(hooks === undefined ? {} : { hooks }) });

const outcomeOf = (r: ModelResult): string => {
  if (r.kind === 'success') return `success:${(r.json as { outcome?: string } | undefined)?.outcome ?? 'invalid'}`;
  if (r.kind === 'error') return `error:${r.error.code}:${r.phase}`;
  return r.kind;
};

describe('fake provider: script result kinds', () => {
  const kinds: [FakeStepResult, string][] = [
    [{ kind: 'success' }, 'success:findings'],
    [{ kind: 'success', fixture: 'review.v1.revise' }, 'success:revise'],
    [{ kind: 'malformed', text: 'not json' }, 'success:invalid'],
    [{ kind: 'truncated' }, 'truncated'],
    [{ kind: 'refused' }, 'refused'],
    [{ kind: 'auth_error' }, 'error:AUTH_REQUIRED:responded'],
    [{ kind: 'rate_limited', retryAfterMs: 1500 }, 'error:RATE_LIMITED:responded'],
    [{ kind: 'server_error' }, 'error:PROVIDER_UNAVAILABLE:responded'],
    [{ kind: 'unknown_after_dispatch' }, 'error:REQUEST_OUTCOME_UNKNOWN:sent_no_response'],
    [{ kind: 'midstream_error' }, 'error:REQUEST_OUTCOME_UNKNOWN:responded_partial'],
    [{ kind: 'crash_process_after_dispatch' }, 'error:REQUEST_OUTCOME_UNKNOWN:sent_no_response'],
    [{ kind: 'overrun', outputTokens: 99_999 }, 'success:findings'],
  ];

  it.each(kinds)('%o → %s, always reporting fake_resp_<attemptId> after onDispatched', async (result, expected) => {
    const { provider } = make({ name: 'k', steps: [{ result }] });
    const order: string[] = [];
    const r = req('review');

    const out = await gen(provider, r, {
      onDispatched: () => order.push('dispatched'),
      onResponseId: (ids) => order.push(`id:${ids.providerResponseId ?? ''}`),
    });

    expect(outcomeOf(out)).toBe(expected);
    expect(order).toEqual(['dispatched', `id:fake_resp_${r.metadata.attemptId}`]);
  });

  it('hang resolves only when the signal aborts', async () => {
    const { provider } = make('hang');
    const controller = new AbortController();
    let settled = false;

    const pending = gen(provider, req('review'), undefined, controller.signal).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    controller.abort();
    const out = await pending;

    expect(out).toMatchObject({ kind: 'error', phase: 'sent_no_response', error: { code: 'INTERNAL', details: { aborted: true } } });
  });

  it('delayMs waits on the injected timers only, and an abort during the delay stops the call', async () => {
    const { provider, timers } = make('slow-review');
    let settled = false;

    const pending = gen(provider, req('review')).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    timers.advance(4999);
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    timers.advance(1);
    expect(outcomeOf(await pending)).toBe('success:findings');

    const controller = new AbortController();
    const { provider: p2, timers: t2 } = make('slow-review');
    const aborted = gen(p2, req('review'), undefined, controller.signal);
    await new Promise((r) => setImmediate(r));
    controller.abort();
    expect(await aborted).toMatchObject({ kind: 'error', error: { details: { aborted: true } } });
    expect(t2.pending()).toBe(0);
  });

  it('returns aborted/not_sent without logging when the signal is already aborted', async () => {
    const { provider, callLog } = make('happy-path');
    const controller = new AbortController();
    controller.abort();

    const out = await gen(provider, req('review'), undefined, controller.signal);

    expect(out).toMatchObject({ kind: 'error', phase: 'not_sent' });
    expect(callLog.entries()).toHaveLength(0);
  });

  it('midstream_error reports progress before failing', async () => {
    const { provider } = make('midstream-error');
    const onProgress = vi.fn();

    const out = await gen(provider, req('review'), { onProgress });

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ kind: 'error', providerResponseId: expect.stringMatching(/^fake_resp_/) as unknown });
  });

  it('rate_limited carries retryAfterMs; overrun reports the scripted output tokens', async () => {
    const { provider } = make({
      name: 'x',
      steps: [
        { match: { stepKey: 'review' }, result: { kind: 'rate_limited', retryAfterMs: 1500 } },
        { match: { stepKey: 'plan' }, result: { kind: 'overrun', outputTokens: 99_999 } },
      ],
    });

    const limited = await gen(provider, req('review'));
    const over = await gen(provider, req('plan'));

    expect(limited).toMatchObject({ retryAfterMs: 1500 });
    expect(over.kind === 'success' && over.usage.outputTokens).toBe(99_999);
  });

  it('a throwing hook never changes the result', async () => {
    const boom = (): never => {
      throw new Error('hook bug');
    };
    const warn = vi.fn();
    const { provider } = make('midstream-error', { logger: { warn } });

    const out = await gen(provider, req('review'), { onDispatched: boom, onResponseId: boom, onProgress: boom });

    expect(outcomeOf(out)).toBe('error:REQUEST_OUTCOME_UNKNOWN:responded_partial');
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('uses extraFixtures and rejects unknown fixture names', async () => {
    const extra = { 'plan.scope-expanded': { outcome: 'plan', variant: true } };
    const { provider } = make({ name: 'x', steps: [{ result: { kind: 'success', fixture: 'plan.scope-expanded' } }, { result: { kind: 'success', fixture: 'nope' } }] }, { extraFixtures: extra });

    const out = await gen(provider, req('plan'));

    expect(out).toMatchObject({ kind: 'success', json: { variant: true } });
    await expect(gen(provider, req('plan'))).rejects.toThrow(/unknown fake fixture/);
  });

  it('falls back to the output schema name, and throws for an unknown step', async () => {
    const { provider } = make('happy-path');

    const byName = await gen(provider, req('custom', 'initial', { outputSchema: { name: 'plan.v1', jsonSchema: {} } }));

    expect(outcomeOf(byName)).toBe('success:plan');
    await expect(gen(provider, req('custom', 'initial', { outputSchema: { name: 'other', jsonSchema: {} } }))).rejects.toThrow(/no default fake fixture/);
  });

  it('keeps default usage within the request so an unscripted call never overruns', async () => {
    const { provider } = make('happy-path');

    const out = await gen(provider, req('review', 'initial', { maxOutputTokens: 100, messages: [{ role: 'user', content: 'hi' }] }));

    expect(out.kind === 'success' && out.usage).toMatchObject({ outputTokens: 100 });
    expect(out.kind === 'success' && out.usage.uncachedInputTokens).toBeLessThan(20);
  });
});

describe('fake provider: FAKE_SCENARIOS', () => {
  type Call = [stepKey: string, purpose: AttemptPurpose, expected: string];
  const table: [string, Call[]][] = [
    ['happy-path', [['review', 'initial', 'success:findings'], ['plan', 'initial', 'success:plan'], ['implement', 'initial', 'success:patch'], ['verify', 'initial', 'success:accept']]],
    ['budget-exhaustion', [['review', 'initial', 'success:findings'], ['plan', 'initial', 'success:plan']]],
    ['malformed-then-ok', [['review', 'initial', 'success:invalid'], ['review', 'schema_repair', 'success:findings']]],
    ['malformed-twice', [['review', 'initial', 'success:invalid'], ['review', 'schema_repair', 'success:invalid'], ['review', 'user_retry', 'success:findings']]],
    ['auth-fail', [['review', 'initial', 'error:AUTH_REQUIRED:responded'], ['review', 'user_retry', 'success:findings']]],
    ['rate-limit-then-ok', [['review', 'initial', 'error:RATE_LIMITED:responded'], ['review', 'transport_retry', 'success:findings']]],
    ['rate-limit-exhausted', [
      ['review', 'initial', 'error:RATE_LIMITED:responded'], ['review', 'initial', 'error:RATE_LIMITED:responded'],
      ['review', 'transport_retry', 'error:RATE_LIMITED:responded'], ['review', 'transport_retry', 'error:RATE_LIMITED:responded'],
      ['review', 'user_retry', 'success:findings'],
    ]],
    ['server-error-twice', [['review', 'initial', 'error:PROVIDER_UNAVAILABLE:responded'], ['review', 'transport_retry', 'error:PROVIDER_UNAVAILABLE:responded'], ['review', 'user_retry', 'success:findings']]],
    ['refused', [['review', 'initial', 'refused'], ['review', 'user_retry', 'success:findings']]],
    ['unknown-outcome', [['review', 'initial', 'success:findings'], ['plan', 'initial', 'success:plan'], ['implement', 'initial', 'error:REQUEST_OUTCOME_UNKNOWN:sent_no_response'], ['implement', 'user_retry', 'success:patch']]],
    ['midstream-error', [['review', 'initial', 'error:REQUEST_OUTCOME_UNKNOWN:responded_partial'], ['review', 'user_retry', 'success:findings']]],
    ['crash-after-dispatch-plan', [['review', 'initial', 'success:findings'], ['plan', 'initial', 'error:REQUEST_OUTCOME_UNKNOWN:sent_no_response'], ['plan', 'initial', 'success:plan']]],
    ['reconcile-completed', [['review', 'initial', 'success:findings'], ['implement', 'initial', 'success:patch']]],
    ['reconcile-slow', [['implement', 'initial', 'error:REQUEST_OUTCOME_UNKNOWN:sent_no_response']]],
    ['revise-then-accept', [['verify', 'initial', 'success:revise'], ['verify', 'initial', 'success:accept']]],
    ['revise-until-limit', [['verify', 'initial', 'success:revise'], ['verify', 'initial', 'success:revise'], ['verify', 'initial', 'success:revise']]],
    ['overrun', [['review', 'initial', 'success:findings'], ['review', 'user_retry', 'success:findings']]],
  ];

  it('covers every scenario in the table (plus hang and slow-review above)', () => {
    expect([...table.map(([n]) => n), 'hang', 'slow-review'].sort()).toEqual(Object.keys(FAKE_SCENARIOS).sort());
  });

  it.each(table)('%s answers its script in order', async (name, calls) => {
    const { provider } = make(name);
    const outcomes: string[] = [];

    for (const [stepKey, purpose] of calls) outcomes.push(outcomeOf(await gen(provider, req(stepKey, purpose))));

    expect(outcomes).toEqual(calls.map(([, , e]) => e));
  });

  it('budget-exhaustion reports its large usage on every call', async () => {
    const { provider } = make('budget-exhaustion');

    const out = await gen(provider, req('implement'));

    expect(out.kind === 'success' && out.usage).toMatchObject({ uncachedInputTokens: 1500, outputTokens: 7500 });
  });

  it('overrun reports usage far above the review reservation', async () => {
    const { provider } = make('overrun');

    const out = await gen(provider, req('review'));

    expect(out.kind === 'success' && out.usage.outputTokens).toBe(100_000);
  });
});

describe('fake provider: call log and crash step', () => {
  it('appends one FakeCall with every field before producing the result', async () => {
    const callLog: FakeCallLog = createMemoryCallLog();
    const { provider } = make('hang', { callLog });
    const r = req('review');
    const controller = new AbortController();

    const pending = gen(provider, r, undefined, controller.signal);
    await new Promise((res) => setImmediate(res));
    expect(callLog.entries()).toEqual([
      {
        kind: 'generate',
        at: 1_000_000,
        runId: 'run_1',
        attemptId: r.metadata.attemptId,
        stepKey: 'review',
        purpose: 'initial',
        providerId: 'anthropic',
        modelId: 'claude-opus-5-5',
        systemSha256: createHash('sha256').update('system for review').digest('hex'),
        scriptStep: 0,
      },
    ]);
    controller.abort();
    await pending;
  });

  it('crash_process_after_dispatch writes the JSONL line to disk before calling exit(137)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-fake-'));
    tempDirs.push(dir);
    const file = join(dir, 'nested', 'fake-call-log.jsonl');
    const r = req('plan');
    let onDiskAtExit = '';
    const exit = vi.fn((): never => {
      onDiskAtExit = readFileSync(file, 'utf8');
      return undefined as never;
    });
    const onResponseId = vi.fn();
    const { provider } = make('crash-after-dispatch-plan', { callLog: createJsonlCallLog(file), exit });

    await gen(provider, r, { onResponseId });

    expect(exit).toHaveBeenCalledWith(FAKE_CRASH_EXIT_CODE);
    expect(onResponseId).toHaveBeenCalledWith({ providerResponseId: `fake_resp_${r.metadata.attemptId}` });
    expect(onDiskAtExit).toContain(`"attemptId":"${r.metadata.attemptId}"`);
    expect(onDiskAtExit.endsWith('\n')).toBe(true);
  });

  it('the JSONL log returns [] before the first append', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-fake-'));
    tempDirs.push(dir);

    expect(createJsonlCallLog(join(dir, 'none.jsonl')).entries()).toEqual([]);
  });
});

describe('fake provider: reconcile', () => {
  it('answers the scripted sequence, repeating the last entry', async () => {
    const { provider } = make('reconcile-slow');
    const r = req('implement');
    await gen(provider, r);
    const ids = { providerResponseId: `fake_resp_${r.metadata.attemptId}` };
    const ctx = { apiKey: 'k', signal: new AbortController().signal };

    const answers = [];
    for (let i = 0; i < 4; i += 1) answers.push(await provider.reconcile!(ids, ctx));

    expect(answers.map((a) => a.kind)).toEqual(['in_progress', 'in_progress', 'completed', 'completed']);
    expect(answers[2]).toMatchObject({ kind: 'completed', json: FAKE_FIXTURES['patch.v1'] });
  });

  it('answers from a fresh provider instance that reads the same JSONL log (restart)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-fake-'));
    tempDirs.push(dir);
    const file = join(dir, 'fake-call-log.jsonl');
    const first = make('reconcile-completed', { callLog: createJsonlCallLog(file) });
    const r = req('implement');
    await gen(first.provider, r);

    const restarted = make('reconcile-completed', { callLog: createJsonlCallLog(file) });
    const answer = await restarted.provider.reconcile!({ providerResponseId: `fake_resp_${r.metadata.attemptId}` }, { apiKey: 'k', signal: new AbortController().signal });

    expect(answer).toMatchObject({ kind: 'completed', json: FAKE_FIXTURES['patch.v1'] });
  });

  it('regression (F6): after a restart, reconcile uses the recorded step and continues the answer sequence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-fake-'));
    tempDirs.push(dir);
    const file = join(dir, 'fake-call-log.jsonl');
    const scenario: FakeScenario = {
      name: 'two-step',
      steps: [
        { match: { stepKey: 'implement' }, result: { kind: 'unknown_after_dispatch' }, reconcile: ['failed'] },
        { match: { stepKey: 'implement' }, result: { kind: 'unknown_after_dispatch' }, reconcile: ['in_progress', 'completed'] },
      ],
    };
    const ctx = { apiKey: 'k', signal: new AbortController().signal };
    const first = make(scenario, { callLog: createJsonlCallLog(file) });
    const a = req('implement');
    const b = req('implement');
    await gen(first.provider, a);
    await gen(first.provider, b);
    const idB = { providerResponseId: `fake_resp_${b.metadata.attemptId}` };
    const before = await first.provider.reconcile!(idB, ctx);

    const restarted = make(scenario, { callLog: createJsonlCallLog(file) });
    const after = await restarted.provider.reconcile!(idB, ctx);
    const againA = await restarted.provider.reconcile!({ providerResponseId: `fake_resp_${a.metadata.attemptId}` }, ctx);

    expect(before).toEqual({ kind: 'in_progress' });
    expect(after).toMatchObject({ kind: 'completed', json: FAKE_FIXTURES['patch.v1'] });
    expect(againA).toEqual({ kind: 'failed' });
    const log = createJsonlCallLog(file);
    expect(log.entries().map((c) => c.scriptStep)).toEqual([0, 1]);
    expect(log.reconcileEntries().map((c) => [c.kind, c.attemptId])).toEqual([
      ['reconcile', b.metadata.attemptId],
      ['reconcile', b.metadata.attemptId],
      ['reconcile', a.metadata.attemptId],
    ]);
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string });
    expect(lines.map((l) => l.kind)).toEqual(['generate', 'generate', 'reconcile', 'reconcile', 'reconcile']);
  });

  it('reads older log lines without kind/scriptStep as fall-through generate calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-fake-'));
    tempDirs.push(dir);
    const file = join(dir, 'fake-call-log.jsonl');
    writeFileSync(file, `${JSON.stringify({ at: 1, runId: 'r', attemptId: 'att_old', stepKey: 'review', purpose: 'initial', providerId: 'anthropic', modelId: 'm', systemSha256: 'x' })}\n`);

    const log = createJsonlCallLog(file);
    const { provider } = make('reconcile-completed', { callLog: log });

    expect(log.entries()).toEqual([expect.objectContaining({ kind: 'generate', attemptId: 'att_old', scriptStep: null })]);
    await expect(provider.reconcile!({ providerResponseId: 'fake_resp_att_old' }, { apiKey: 'k', signal: new AbortController().signal })).resolves.toEqual({ kind: 'not_found' });
  });

  it('answers not_found for unknown ids and steps without reconcile answers', async () => {
    const { provider } = make('happy-path');
    const r = req('review');
    await gen(provider, r);
    const ctx = { apiKey: 'k', signal: new AbortController().signal };

    await expect(provider.reconcile!({ providerResponseId: 'resp_other' }, ctx)).resolves.toEqual({ kind: 'not_found' });
    await expect(provider.reconcile!({ providerResponseId: 'fake_resp_att_missing' }, ctx)).resolves.toEqual({ kind: 'not_found' });
    await expect(provider.reconcile!({ providerResponseId: `fake_resp_${r.metadata.attemptId}` }, ctx)).resolves.toEqual({ kind: 'not_found' });
  });

  it('failed returns the step usage only when the step scripts one', async () => {
    const withUsage = make({ name: 'f', steps: [{ times: Infinity, result: { kind: 'unknown_after_dispatch' }, usage: { outputTokens: 7 }, reconcile: ['failed'] }] });
    const without = make({ name: 'g', steps: [{ times: Infinity, result: { kind: 'unknown_after_dispatch' }, reconcile: ['failed', 'not_found'] }] });
    const r1 = req('review');
    const r2 = req('review');
    await gen(withUsage.provider, r1);
    await gen(without.provider, r2);
    const ctx = { apiKey: 'k', signal: new AbortController().signal };

    const a = await withUsage.provider.reconcile!({ providerResponseId: `fake_resp_${r1.metadata.attemptId}` }, ctx);
    const b = await without.provider.reconcile!({ providerResponseId: `fake_resp_${r2.metadata.attemptId}` }, ctx);
    const c = await without.provider.reconcile!({ providerResponseId: `fake_resp_${r2.metadata.attemptId}` }, ctx);

    expect(a).toMatchObject({ kind: 'failed', usage: { outputTokens: 7 } });
    expect(b).toEqual({ kind: 'failed' });
    expect(c).toEqual({ kind: 'not_found' });
  });
});

describe('fake provider: capabilities, estimate, testConnection', () => {
  const PRICES = { input: 1_000_000, output: 2_000_000, cacheRead: 100_000, cacheWrite: 1_250_000 } as ModelPrices;

  it('merges scenario then option capability overrides over the catalog entry', async () => {
    const { provider } = make('reconcile-completed', { capabilityOverrides: { supportsTokenCounting: true } });

    const caps = await provider.capabilities('claude-opus-5-5');

    expect(caps).toMatchObject({ supportsRequestLookup: true, supportsTokenCounting: true, thinkingAlwaysOn: true });
  });

  it('option overrides win over scenario overrides; unknown models use the fake-model entry', async () => {
    const { provider } = make('reconcile-completed', { capabilityOverrides: { supportsRequestLookup: false } });

    const caps = await provider.capabilities('gpt-unknown');

    expect(caps).toMatchObject({ supportsRequestLookup: false, thinkingAlwaysOn: false, maxOutputTokens: 128_000 });
  });

  it('estimates locally with the catalog version', async () => {
    const { provider } = make('happy-path');

    const est = await provider.estimate(req('review'), PRICES, { apiKey: 'k' });

    expect(est.basis).toBe('local_estimate');
    expect(est.priceCatalogVersion).toBe('2026-09-25');
  });

  it('records the explicit price catalog version passed alongside the prices', async () => {
    const { provider } = make('happy-path');

    const est = await provider.estimate(req('review'), PRICES, { priceCatalogVersion: '2025-01-01' });

    expect(est.priceCatalogVersion).toBe('2025-01-01');
  });

  it('testConnection returns the connection fixture without touching the script or the call log', async () => {
    const { provider, callLog } = make('auth-fail');

    const conn = await provider.testConnection({ apiKey: 'k', signal: new AbortController().signal, modelId: 'fake-model' });
    const first = await gen(provider, req('review'));

    expect(conn).toMatchObject({ kind: 'success', json: { ok: true } });
    expect(outcomeOf(first)).toBe('error:AUTH_REQUIRED:responded');
    expect(callLog.entries()).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    await expect(provider.testConnection({ apiKey: 'k', signal: controller.signal, modelId: 'fake-model' })).resolves.toMatchObject({ kind: 'error', phase: 'not_sent' });
  });
});
