// 06 F18: setup calls — the `providers.test` handler (R3-7, FR-02). A deliberately small request, admitted against
// the monthly setup allowance over `scope='setup'` ledger entries (C + R + U + N ≤ L), reserved before the call and
// settled after it, with `run_id` and `attempt_id` NULL. The key is resolved with purpose `connection_test`.
import { computeCost, err, errors, microusd, ok } from '@relay/contracts';
import type { AppError, CatalogModel, CostCertainty, EpochMs, Microusd, ProviderId, ProviderTestResult, Result } from '@relay/contracts';
import type { ModelRequest, ModelResult, ProviderAdapter } from '@relay/providers';
import type { Repos } from '@relay/storage';
import { admitSetup, reserveEntries, settlementEntries } from './budget.js';
import type { SettleAmount } from './budget.js';
import { monthWindow } from './clock.js';
import { logSafe } from './log-safe.js';
import { adapterOf } from './provider-lookup.js';
import { flagsOf } from './retry.js';
import type { EngineCtx } from './ports.js';
import { readSettings } from './settings.js';

/** 04 §D4: output allowance of the fallback connection-test request (providers size it per provider, e.g. OpenAI 256). */
export const CONNECTION_TEST_MAX_OUTPUT_TOKENS = 16;
/** F18: the connection test is aborted after 15 s. */
const CONNECTION_TEST_TIMEOUT_MS = 15_000;

/** Fallback for the injected providers `connectionTestRequest` (same shape and text; 16 output tokens). */
export function connectionTestRequest(providerId: ProviderId, modelId: string): ModelRequest {
  return {
    providerId,
    modelId,
    system: 'Connection test. Answer with the JSON object {"ok": true} and nothing else.',
    messages: [{ role: 'user', content: 'Reply {"ok": true}.' }],
    outputSchema: {
      name: 'connection_test',
      jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    },
    maxOutputTokens: CONNECTION_TEST_MAX_OUTPUT_TOKENS,
    refusalFallback: 'off',
    metadata: { attemptId: 'setup', runId: 'setup', stepKey: 'connection-test', purpose: 'initial' },
  };
}

/** The cheapest catalog model of the provider for the test (input + output price), or the given one. */
export function modelForTest(r: Repos, providerId: ProviderId, modelId?: string): CatalogModel | undefined {
  if (modelId !== undefined) return r.catalog.get(providerId, modelId);
  return [...r.catalog.list(providerId)].sort(
    (a, b) => a.prices.input + a.prices.output - (b.prices.input + b.prices.output) || (a.modelId < b.modelId ? -1 : 1),
  )[0];
}

/** Maps a connection-test result to its charge (F5 rows with `scope='setup'`). */
export function setupCharge(result: ModelResult, aborted: boolean, entry: Pick<CatalogModel, 'prices'>, N: Microusd): SettleAmount {
  if (result.kind === 'error') {
    // REQUEST_OUTCOME_UNKNOWN is unknown in ANY phase (a gateway can answer `responded` without knowing whether the
    // upstream call ran): the full N becomes setup liability, never released.
    const ambiguous = result.phase === 'sent_no_response' || result.phase === 'responded_partial' || result.error.code === 'REQUEST_OUTCOME_UNKNOWN';
    if (ambiguous || (aborted && result.phase !== 'not_sent')) return { kind: 'unknown' };
    if (result.usage === undefined) return { kind: 'not_charged' };
  }
  const flags = flagsOf(result);
  if (flags.usageKnown === false || result.usage === undefined) return { kind: 'known', microusd: N, certainty: 'estimated' }; // never $0 calculated
  return { kind: 'known', microusd: computeCost(result.usage, entry.prices).microusd, certainty: flags.priceTierMismatch === true ? 'estimated' : 'calculated' };
}

function errorOf(result: ModelResult): AppError | null {
  switch (result.kind) {
    case 'success':
    case 'truncated': // a cut-off answer still proves the key and the model work (FR-02)
      return null;
    case 'refused':
      return errors.modelRefused();
    case 'error':
      return result.error;
  }
}

async function callWithTimeout(ctx: EngineCtx, adapter: ProviderAdapter, apiKey: string, modelId: string): Promise<{ result: ModelResult; aborted: boolean }> {
  const controller = new AbortController();
  const timer = ctx.timers.setTimeout(() => {
    controller.abort({ kind: 'deadline' });
  }, CONNECTION_TEST_TIMEOUT_MS);
  try {
    const result = await adapter.testConnection({ apiKey, signal: controller.signal, modelId });
    return { result, aborted: controller.signal.aborted };
  } catch (e) {
    ctx.logger.error('providers.test_threw', { err: logSafe(e, [apiKey]) });
    return { result: { kind: 'error', error: errors.providerUnavailable(), phase: 'sent_no_response' }, aborted: controller.signal.aborted };
  } finally {
    ctx.timers.clearTimeout(timer);
  }
}

/** `providers.test` (F18). */
export async function testProviderConnection(ctx: EngineCtx, input: { readonly providerId: ProviderId; readonly modelId?: string }): Promise<Result<ProviderTestResult>> {
  const { providerId } = input;
  const credential = await ctx.credentials.resolve({ providerId, purpose: 'connection_test', attemptId: null });
  if (!credential.ok) return err(errors.authRequired(providerId));
  const entry = modelForTest(ctx.db.repos, providerId, input.modelId);
  const found = adapterOf(ctx, providerId);
  if (!found.ok) return found;
  const adapter = found.value;
  if (entry === undefined) return err(errors.modelUnsupported({ providerId, reason: 'model_unknown' }));
  // N covers exactly what testConnection sends (the per-provider output allowance comes from @relay/providers).
  const request = (ctx.connectionTestRequest ?? connectionTestRequest)(providerId, entry.modelId);
  const estimate = await adapter.estimate(request, entry.prices, { priceCatalogVersion: entry.catalogVersion });
  const N = estimate.upperAllowanceMicrousd;
  const refs = { attemptId: null, runId: null, projectId: null, priceCatalogVersion: entry.catalogVersion, scope: 'setup' as const };
  const admitted = ctx.db.txResult('immediate', (r): Result<EpochMs> => {
    const now = ctx.clock.now();
    const { start, end } = monthWindow(now);
    const L = readSettings(r).setupAllowanceMicrousd; // default SETUP_ALLOWANCE_MICROUSD
    const decision = admitSetup({ setup: r.ledger.setupBalances(start, end), L, N });
    if (!decision.ok) return err(errors.budgetBlocked(decision.breakdown, { details: { scope: 'setup' } }));
    r.ledger.append(reserveEntries({ ...refs, N, createdAt: now }));
    return ok(now);
  });
  if (!admitted.ok) return admitted;
  const { result, aborted } = await callWithTimeout(ctx, adapter, credential.value, entry.modelId);
  const cost = setupCharge(result, aborted, entry, N);
  const error = errorOf(result);
  const settledAt = ctx.db.tx('immediate', (r) => {
    const now = ctx.clock.now();
    r.ledger.append(settlementEntries({ ...refs, reservation: N, cost, createdAt: now }));
    r.credentials.recordTest(providerId, error === null, error?.code ?? null, now);
    return now;
  });
  const costMicrousd = cost.kind === 'known' ? cost.microusd : cost.kind === 'unknown' ? N : microusd(0);
  const certainty: CostCertainty = cost.kind === 'known' ? cost.certainty : cost.kind === 'unknown' ? 'unknown' : 'calculated';
  return ok({
    ok: error === null,
    latencyMs: Math.max(0, settledAt - admitted.value),
    modelProbed: entry.modelId,
    ...(error === null ? {} : { error }),
    costMicrousd,
    certainty,
  });
}
