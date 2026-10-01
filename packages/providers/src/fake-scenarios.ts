// 04 §D7 scripted fake scenarios. Any call no step matches falls through to the happy-path fixture for its stepKey.
import type { AttemptPurpose, ModelCapabilities } from '@relay/contracts';
import type { NormalizedUsage } from './types.js';

/** What one scripted step answers. */
export type FakeStepResult =
  /** `fixture` keys FAKE_FIXTURES or `extraFixtures`; omitted → the default fixture for the call's stepKey. */
  | { readonly kind: 'success'; readonly fixture?: string }
  /** Non-JSON or schema-invalid text. */
  | { readonly kind: 'malformed'; readonly text: string }
  | { readonly kind: 'truncated' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'auth_error' }
  | { readonly kind: 'rate_limited'; readonly retryAfterMs: number }
  /** HTTP 5xx before any body byte. */
  | { readonly kind: 'server_error' }
  /** Never resolves until aborted (cancellation tests). */
  | { readonly kind: 'hang' }
  /** onDispatched + onResponseId, then a connection reset → `sent_no_response`. */
  | { readonly kind: 'unknown_after_dispatch' }
  /** onDispatched + onResponseId + onProgress, then an SSE error → `responded_partial`. */
  | { readonly kind: 'midstream_error' }
  /** onDispatched, onResponseId, synchronous call-log line, then `exit(137)` (11 §K4). */
  | { readonly kind: 'crash_process_after_dispatch' }
  /** Success whose usage exceeds the reservation (§9.5 overrun). */
  | { readonly kind: 'overrun'; readonly outputTokens: number };

/** Reconcile answers, in order (the last one repeats). */
export type FakeReconcileAnswer = 'completed' | 'failed' | 'in_progress' | 'not_found';

/** One script step. */
export interface FakeScriptStep {
  readonly match?: { readonly stepKey?: string; readonly purpose?: AttemptPurpose };
  /** Calls this step serves before it is consumed (default 1; `Infinity` allowed). */
  readonly times?: number;
  /** Uses the injected timers only (R4-36). */
  readonly delayMs?: number;
  readonly result: FakeStepResult;
  readonly usage?: Partial<NormalizedUsage>;
  /** Successive answers to `reconcile()` for attempts served by this step. */
  readonly reconcile?: readonly FakeReconcileAnswer[];
}

/** A named script. */
export interface FakeScenario {
  readonly name: string;
  readonly steps: readonly FakeScriptStep[];
  readonly capabilityOverrides?: Partial<ModelCapabilities>;
}

const REVIEW_INITIAL = { stepKey: 'review', purpose: 'initial' } as const;
/** 12 §L2: long enough to observe "while running" states in e2e. */
const SLOW_REVIEW_DELAY_MS = 5000;
/** Rate-limit scenarios' retry-after. */
const RATE_LIMIT_RETRY_AFTER_MS = 1000;
/** Far above any review reservation (8k output allowance) so the overrun always triggers (§9.5). */
const OVERRUN_OUTPUT_TOKENS = 100_000;
const MALFORMED_TEXT = 'Here are my findings: the age field is not validated. (This reply is not JSON.)';
const SCHEMA_INVALID_TEXT = '{"summary": "", "findings": "none"}';

const scenario = (name: string, steps: readonly FakeScriptStep[], capabilityOverrides?: Partial<ModelCapabilities>): FakeScenario =>
  Object.freeze(capabilityOverrides === undefined ? { name, steps } : { name, steps, capabilityOverrides });

/** The scenario table; `satisfies` checks every entry while keeping the literal keys for {@link FakeScenarioName}. */
const SCENARIOS = {
  'happy-path': scenario('happy-path', []),
  'slow-review': scenario('slow-review', [
    { match: REVIEW_INITIAL, delayMs: SLOW_REVIEW_DELAY_MS, result: { kind: 'success' } },
  ]),
  'budget-exhaustion': scenario('budget-exhaustion', [
    // Large but within any reservation (inputs ≥ 1.5k tokens, output allowance ≥ 8k): reaches the allowance mid-template.
    { times: Infinity, result: { kind: 'success' }, usage: { uncachedInputTokens: 1500, outputTokens: 7500 } },
  ]),
  'malformed-then-ok': scenario('malformed-then-ok', [
    { match: REVIEW_INITIAL, result: { kind: 'malformed', text: MALFORMED_TEXT } },
  ]),
  'malformed-twice': scenario('malformed-twice', [
    { match: REVIEW_INITIAL, result: { kind: 'malformed', text: MALFORMED_TEXT } },
    { match: { stepKey: 'review', purpose: 'schema_repair' }, result: { kind: 'malformed', text: SCHEMA_INVALID_TEXT } },
  ]),
  'auth-fail': scenario('auth-fail', [{ result: { kind: 'auth_error' } }]),
  'rate-limit-then-ok': scenario('rate-limit-then-ok', [
    { match: REVIEW_INITIAL, result: { kind: 'rate_limited', retryAfterMs: RATE_LIMIT_RETRY_AFTER_MS } },
  ]),
  'rate-limit-exhausted': scenario('rate-limit-exhausted', [
    { match: REVIEW_INITIAL, times: Infinity, result: { kind: 'rate_limited', retryAfterMs: RATE_LIMIT_RETRY_AFTER_MS } },
    {
      match: { stepKey: 'review', purpose: 'transport_retry' },
      times: Infinity,
      result: { kind: 'rate_limited', retryAfterMs: RATE_LIMIT_RETRY_AFTER_MS },
    },
  ]),
  'server-error-twice': scenario('server-error-twice', [
    { match: REVIEW_INITIAL, result: { kind: 'server_error' } },
    { match: { stepKey: 'review', purpose: 'transport_retry' }, result: { kind: 'server_error' } },
  ]),
  refused: scenario('refused', [{ match: REVIEW_INITIAL, result: { kind: 'refused' } }]),
  'unknown-outcome': scenario('unknown-outcome', [
    { match: { stepKey: 'implement', purpose: 'initial' }, result: { kind: 'unknown_after_dispatch' } },
  ]),
  'midstream-error': scenario('midstream-error', [{ match: REVIEW_INITIAL, result: { kind: 'midstream_error' } }]),
  'crash-after-dispatch-plan': scenario('crash-after-dispatch-plan', [
    { match: { stepKey: 'plan', purpose: 'initial' }, result: { kind: 'crash_process_after_dispatch' } },
  ]),
  'reconcile-completed': scenario(
    'reconcile-completed',
    [{ times: Infinity, result: { kind: 'success' }, reconcile: ['completed'] }],
    { supportsRequestLookup: true },
  ),
  'reconcile-slow': scenario(
    'reconcile-slow',
    [
      {
        match: { stepKey: 'implement', purpose: 'initial' },
        result: { kind: 'unknown_after_dispatch' },
        reconcile: ['in_progress', 'in_progress', 'completed'],
      },
    ],
    { supportsRequestLookup: true },
  ),
  'revise-then-accept': scenario('revise-then-accept', [
    { match: { stepKey: 'verify' }, result: { kind: 'success', fixture: 'review.v1.revise' } },
  ]),
  'revise-until-limit': scenario('revise-until-limit', [
    { match: { stepKey: 'verify' }, times: Infinity, result: { kind: 'success', fixture: 'review.v1.revise' } },
  ]),
  hang: scenario('hang', [{ match: REVIEW_INITIAL, result: { kind: 'hang' } }]),
  overrun: scenario('overrun', [
    { match: { stepKey: 'review' }, result: { kind: 'overrun', outputTokens: OVERRUN_OUTPUT_TOKENS } },
  ]),
} satisfies Readonly<Record<string, FakeScenario>>;

/** Name of a bundled scenario (each key equals its scenario's `name`; fake.test.ts checks it). */
export type FakeScenarioName = keyof typeof SCENARIOS;

/** The scenario served when none is named. */
export const DEFAULT_FAKE_SCENARIO: FakeScenario = SCENARIOS['happy-path'];

/** Every scripted scenario, keyed by name (04 §D7 table). Indexed by arbitrary strings (env/CLI input), hence Record. */
export const FAKE_SCENARIOS: Readonly<Record<string, FakeScenario>> = Object.freeze(SCENARIOS);
