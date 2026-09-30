// 04 §D7: deterministic, scriptable fake provider (spec §13.2, §17). Never presented as a live result (§22.2):
// it is selectable only through the registry's fake mode, which packaged builds ignore unless RELAY_E2E=1 (08 §H1).
import { createHash } from 'node:crypto';
import { appError, assertNever } from '@relay/contracts';
import type { AttemptPurpose, CatalogModel, ModelCapabilities, ModelPrices, ProviderId } from '@relay/contracts';
import type { Clock } from '@relay/contracts';
import { createMemoryCallLog } from './call-log.js';
import type { FakeCall, FakeCallLog } from './call-log.js';
import { findCatalogEntry, latestCatalogVersion } from './catalog.js';
import { CONNECTION_TEST_STEP_KEY } from './connection-test.js';
import { localEstimate, localTokenEstimate, promptChars } from './estimate.js';
import { FAKE_FIXTURES } from './fake-fixtures/index.js';
import type { FakeScenario, FakeScriptStep, FakeStepResult } from './fake-scenarios.js';
import { NOOP_LOGGER, safeHook } from './safe-hook.js';
import type {
  DispatchPhase,
  GenerateContext,
  Logger,
  ModelError,
  ModelRequest,
  ModelResult,
  NormalizedUsage,
  ProviderAdapter,
  ReconciliationResult,
  Timers,
  UsageEstimate,
} from './types.js';

/** The fake catalog model every unknown (providerId, modelId) falls back to. */
export const FAKE_MODEL_ID = 'fake-model';
/** Prefix of every fake response id; `reconcile` strips it to find the attempt. */
export const FAKE_RESPONSE_ID_PREFIX = 'fake_resp_';
/** Exit code of `crash_process_after_dispatch` (SIGKILL-like). */
export const FAKE_CRASH_EXIT_CODE = 137;

/** Default usage of a successful fake call (clamped to the request so it never overruns unless scripted). */
const DEFAULT_INPUT_TOKENS = 1200;
const DEFAULT_OUTPUT_TOKENS = 600;
const MIDSTREAM_PROGRESS_TOKENS = 50;

/** stepKey → default success fixture (the happy path). */
const DEFAULT_FIXTURE_BY_STEP: Readonly<Record<string, string>> = {
  review: 'findings.v1',
  plan: 'plan.v1',
  implement: 'patch.v1',
  verify: 'review.v1.accept',
  [CONNECTION_TEST_STEP_KEY]: 'connection-test',
};

interface ServedCall {
  readonly step: FakeScriptStep | undefined;
  readonly stepKey: string;
  readonly schemaName: string;
}

/** Scenario cursor + served-attempt memory; shared by every fake adapter of one registry (04 §D8). */
export interface FakeScriptState {
  readonly scenario: FakeScenario;
  /** Returns the first not-yet-consumed matching step (consuming one use), or `undefined` (fall through). */
  take(call: { readonly stepKey: string; readonly purpose: AttemptPurpose }): FakeScriptStep | undefined;
  readonly served: Map<string, ServedCall>;
  readonly reconcileCounts: Map<string, number>;
}

function stepMatches(step: FakeScriptStep, call: { readonly stepKey: string; readonly purpose: AttemptPurpose }): boolean {
  const m = step.match;
  if (m === undefined) return true;
  return (m.stepKey === undefined || m.stepKey === call.stepKey) && (m.purpose === undefined || m.purpose === call.purpose);
}

/** Creates the scenario cursor for `scenario`. */
export function createFakeScriptState(scenario: FakeScenario): FakeScriptState {
  const used = scenario.steps.map(() => 0);
  return {
    scenario,
    served: new Map(),
    reconcileCounts: new Map(),
    take: (call) => {
      const idx = scenario.steps.findIndex((s, i) => (used[i] ?? 0) < (s.times ?? 1) && stepMatches(s, call));
      if (idx < 0) return undefined;
      used[idx] = (used[idx] ?? 0) + 1;
      return scenario.steps[idx];
    },
  };
}

/** Options of {@link createFakeProvider}. */
export interface FakeProviderOptions {
  /** Reports the real id (04 §D8). */
  readonly providerId: ProviderId;
  readonly scenario: FakeScenario;
  readonly clock: Clock;
  readonly timers?: Timers;
  readonly callLog?: FakeCallLog;
  /** Merged over `scenario.capabilityOverrides`. */
  readonly capabilityOverrides?: Partial<ModelCapabilities>;
  /** K2 integration variants, keyed by fixture name. */
  readonly extraFixtures?: Readonly<Record<string, unknown>>;
  /** Default `process.exit`; tests inject a spy. */
  readonly exit?: (code: number) => never;
  readonly logger?: Logger;
  /** Shared scenario cursor (the registry passes one for all provider ids). Default: a fresh cursor. */
  readonly state?: FakeScriptState;
}

const GLOBAL_TIMERS: Timers = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (h) => {
    globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>);
  },
};

/** Resolves `true` after `ms` on the injected timers, or `false` as soon as `signal` aborts. */
function sleep(timers: Timers, ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      timers.clearTimeout(handle);
      resolve(false);
    };
    const handle = timers.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolves only when `signal` aborts. */
function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      resolve();
    }, { once: true });
  });
}

function withUsage(base: NormalizedUsage, override: Partial<NormalizedUsage> | undefined): NormalizedUsage {
  return { ...base, ...override };
}

function fakeError(code: 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'REQUEST_OUTCOME_UNKNOWN' | 'INTERNAL', phase: DispatchPhase, details: Record<string, unknown>, extra: Partial<ModelError> = {}): ModelError {
  return { kind: 'error', error: appError(code, { details }), phase, ...extra };
}

/**
 * Creates a fake adapter that serves `scenario` (04 §D7). Every `generate` call appends one {@link FakeCall} to the
 * call log before its result is produced, and always reports `fake_resp_<attemptId>` via `onResponseId`.
 */
export function createFakeProvider(opts: FakeProviderOptions): ProviderAdapter {
  const { providerId, clock } = opts;
  const timers = opts.timers ?? GLOBAL_TIMERS;
  const callLog = opts.callLog ?? createMemoryCallLog();
  const logger = opts.logger ?? NOOP_LOGGER;
  const exit: (code: number) => void = opts.exit ?? ((code: number) => process.exit(code));
  const state = opts.state ?? createFakeScriptState(opts.scenario);
  const scenario = state.scenario;

  const catalogEntry = (modelId: string): CatalogModel => {
    const entry = findCatalogEntry(providerId, modelId) ?? findCatalogEntry('fake', FAKE_MODEL_ID);
    if (entry === undefined) throw new Error('fake-model catalog entry is missing'); // invariant: shipped catalog
    return entry;
  };

  const fixture = (name: string): unknown => {
    const value = opts.extraFixtures?.[name] ?? FAKE_FIXTURES[name];
    if (value === undefined) throw new Error(`unknown fake fixture: ${name}`);
    return structuredClone(value);
  };

  const defaultFixtureName = (stepKey: string, schemaName: string): string => {
    const byStep = DEFAULT_FIXTURE_BY_STEP[stepKey];
    if (byStep !== undefined) return byStep;
    if (FAKE_FIXTURES[schemaName] !== undefined) return schemaName;
    throw new Error(`no default fake fixture for stepKey ${stepKey}`);
  };

  const successFixture = (result: FakeStepResult | undefined, served: ServedCall): unknown =>
    fixture(result?.kind === 'success' && result.fixture !== undefined ? result.fixture : defaultFixtureName(served.stepKey, served.schemaName));

  const defaultUsage = (req: ModelRequest): NormalizedUsage => ({
    uncachedInputTokens: Math.min(DEFAULT_INPUT_TOKENS, localTokenEstimate(promptChars(req))),
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: Math.min(DEFAULT_OUTPUT_TOKENS, req.maxOutputTokens),
  });

  const aborted = (phase: DispatchPhase): ModelError => fakeError('INTERNAL', phase, { providerId, aborted: true });

  const produce = async (step: FakeScriptStep | undefined, req: ModelRequest, ctx: GenerateContext, startedAt: number): Promise<ModelResult> => {
    const attemptId = req.metadata.attemptId;
    const ids = { providerResponseId: `${FAKE_RESPONSE_ID_PREFIX}${attemptId}`, providerRequestId: `fake_req_${attemptId}` };
    const served: ServedCall = { step, stepKey: req.metadata.stepKey, schemaName: req.outputSchema.name };
    const usage = withUsage(defaultUsage(req), step?.usage);
    const result: FakeStepResult = step?.result ?? { kind: 'success' };
    const success = (json: unknown, rawText: string, u: NormalizedUsage): ModelResult => ({
      kind: 'success', json, rawText, usage: u, rawUsage: { ...u, fake: true }, stopReason: 'end_turn',
      latencyMs: clock.now() - startedAt, firstByteMs: 0, ...ids,
    });
    switch (result.kind) {
      case 'success': {
        const json = successFixture(result, served);
        return success(json, JSON.stringify(json), usage);
      }
      case 'overrun': {
        const json = successFixture(undefined, served);
        return success(json, JSON.stringify(json), { ...usage, outputTokens: result.outputTokens });
      }
      case 'malformed':
        return success(parseOrUndefined(result.text), result.text, usage);
      case 'truncated': {
        const text = JSON.stringify(successFixture(undefined, served));
        const u = { ...usage, outputTokens: req.maxOutputTokens };
        return { kind: 'truncated', rawText: text.slice(0, Math.floor(text.length / 2)), usage: u, rawUsage: { ...u, fake: true }, ...ids };
      }
      case 'refused':
        return { kind: 'refused', category: 'fake', usage, rawUsage: { ...usage, fake: true }, ...ids };
      case 'auth_error':
        return fakeError('AUTH_REQUIRED', 'responded', { providerId, status: 401 }, { providerRequestId: ids.providerRequestId });
      case 'rate_limited':
        return fakeError('RATE_LIMITED', 'responded', { providerId, status: 429, retryAfterMs: result.retryAfterMs }, { retryAfterMs: result.retryAfterMs, providerRequestId: ids.providerRequestId });
      case 'server_error':
        return fakeError('PROVIDER_UNAVAILABLE', 'responded', { providerId, status: 500 }, { providerRequestId: ids.providerRequestId });
      case 'hang':
        await untilAborted(ctx.signal);
        return aborted('sent_no_response');
      case 'unknown_after_dispatch':
      case 'crash_process_after_dispatch': // only reached when the injected exit returns (tests)
        return fakeError('REQUEST_OUTCOME_UNKNOWN', 'sent_no_response', { providerId, causeCode: 'ECONNRESET', providerResponseId: ids.providerResponseId }, { providerResponseId: ids.providerResponseId });
      case 'midstream_error': {
        const partial = { ...usage, outputTokens: Math.min(MIDSTREAM_PROGRESS_TOKENS, usage.outputTokens) };
        safeHook('onProgress', () => ctx.hooks?.onProgress?.({ outputTokensSoFar: partial.outputTokens, elapsedMs: clock.now() - startedAt }), logger);
        return fakeError('REQUEST_OUTCOME_UNKNOWN', 'responded_partial', {
          providerId, providerResponseId: ids.providerResponseId, partialUsage: partial,
          providerError: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
        }, ids);
      }
      default:
        return assertNever(result);
    }
  };

  const generate = async (req: ModelRequest, ctx: GenerateContext): Promise<ModelResult> => {
    if (ctx.signal.aborted) return aborted('not_sent');
    const startedAt = clock.now();
    const { attemptId, runId, stepKey, purpose } = req.metadata;
    const step = state.take({ stepKey, purpose });
    state.served.set(attemptId, { step, stepKey, schemaName: req.outputSchema.name });
    const call: FakeCall = {
      at: startedAt, runId, attemptId, stepKey, purpose, providerId, modelId: req.modelId,
      systemSha256: createHash('sha256').update(req.system).digest('hex'),
    };
    safeHook('onDispatched', () => ctx.hooks?.onDispatched?.(), logger);
    safeHook('onResponseId', () => ctx.hooks?.onResponseId?.({ providerResponseId: `${FAKE_RESPONSE_ID_PREFIX}${attemptId}` }), logger);
    callLog.append(call); // synchronous: on disk before any crash (12 §L6)
    if (step?.result.kind === 'crash_process_after_dispatch') exit(FAKE_CRASH_EXIT_CODE);
    if (step?.delayMs !== undefined && step.delayMs > 0 && !(await sleep(timers, step.delayMs, ctx.signal))) {
      return aborted('sent_no_response');
    }
    return produce(step, req, ctx, startedAt);
  };

  const rematch = (call: FakeCall): FakeScriptStep | undefined => scenario.steps.find((s) => stepMatches(s, call));

  const reconcile = (ids: { readonly providerResponseId: string }): Promise<ReconciliationResult> => {
    if (!ids.providerResponseId.startsWith(FAKE_RESPONSE_ID_PREFIX)) return Promise.resolve({ kind: 'not_found' });
    const attemptId = ids.providerResponseId.slice(FAKE_RESPONSE_ID_PREFIX.length);
    let served = state.served.get(attemptId);
    if (served === undefined) {
      const call = callLog.entries().find((c) => c.attemptId === attemptId); // the JSONL log survives a restart
      if (call === undefined) return Promise.resolve({ kind: 'not_found' });
      served = { step: rematch(call), stepKey: call.stepKey, schemaName: call.stepKey };
    }
    const answers = served.step?.reconcile ?? [];
    if (answers.length === 0) return Promise.resolve({ kind: 'not_found' });
    const n = state.reconcileCounts.get(attemptId) ?? 0;
    state.reconcileCounts.set(attemptId, n + 1);
    const answer = answers[Math.min(n, answers.length - 1)] ?? 'not_found';
    const usage = withUsage({ uncachedInputTokens: DEFAULT_INPUT_TOKENS, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: DEFAULT_OUTPUT_TOKENS }, served.step?.usage);
    switch (answer) {
      case 'completed':
        return Promise.resolve({ kind: 'completed', json: successFixture(served.step?.result, served), usage, rawUsage: { ...usage, fake: true } });
      case 'failed': {
        const scripted = served.step?.usage;
        return Promise.resolve(scripted === undefined ? { kind: 'failed' } : { kind: 'failed', usage });
      }
      case 'in_progress':
        return Promise.resolve({ kind: 'in_progress' });
      case 'not_found':
        return Promise.resolve({ kind: 'not_found' });
      default:
        return assertNever(answer);
    }
  };

  const estimate = (req: ModelRequest, prices: ModelPrices): Promise<UsageEstimate> =>
    Promise.resolve(localEstimate(req, prices, findCatalogEntry(providerId, req.modelId)?.catalogVersion ?? latestCatalogVersion()));

  const testConnection = (ctx: { readonly signal: AbortSignal; readonly modelId: string }): Promise<ModelResult> => {
    if (ctx.signal.aborted) return Promise.resolve(aborted('not_sent'));
    const json = fixture('connection-test');
    const usage: NormalizedUsage = { uncachedInputTokens: 20, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5 };
    return Promise.resolve({
      kind: 'success', json, rawText: JSON.stringify(json), usage, rawUsage: { ...usage, fake: true },
      stopReason: 'end_turn', latencyMs: 0, providerResponseId: `${FAKE_RESPONSE_ID_PREFIX}connection_test`,
    });
  };

  return {
    providerId,
    capabilities: (modelId) =>
      Promise.resolve({ ...catalogEntry(modelId).capabilities, ...scenario.capabilityOverrides, ...opts.capabilityOverrides }),
    estimate,
    generate,
    reconcile,
    testConnection,
  };
}

function parseOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
