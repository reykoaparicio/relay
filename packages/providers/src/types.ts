// 04 §D1: the adapter contract. Provider SDK types never appear here (§8.3); everything is plain data.
import type {
  AppError,
  AttemptPurpose,
  Effort,
  Microusd,
  ModelCapabilities,
  ModelPrices,
  ProviderId,
} from '@relay/contracts';

/** Minimal structured logger the providers package needs (the engine's logger is a structural superset). */
export interface Logger {
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Injected timer source (06 R4-36): the fake provider's `delayMs` uses only this, never global fake timers. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** One model request. `metadata` is filled by the engine (06 §F4) and never contains secrets. */
export interface ModelRequest {
  readonly providerId: ProviderId;
  readonly modelId: string;
  /** Role instructions (versioned prompt text). */
  readonly system: string;
  /** P0: a single user turn carrying the assembled context. */
  readonly messages: readonly { readonly role: 'user'; readonly content: string }[];
  /** From templates (`z.toJSONSchema`). */
  readonly outputSchema: { readonly name: string; readonly jsonSchema: Readonly<Record<string, unknown>> };
  readonly maxOutputTokens: number;
  readonly effort?: Effort;
  /** ADR-016: provider-side refusal fallback; off unless the profile opts in. */
  readonly refusalFallback: 'off' | 'default';
  /** Real adapters send ONLY attemptId + runId to the provider; stepKey/purpose stay local. */
  readonly metadata: {
    readonly attemptId: string;
    readonly runId: string;
    readonly stepKey: string;
    readonly purpose: AttemptPurpose;
  };
}

/** §8.3 pre-dispatch estimate; `upperAllowanceMicrousd` is N for admission (§9.3). */
export interface UsageEstimate {
  readonly inputTokens: number;
  readonly maxOutputTokens: number;
  readonly upperAllowanceMicrousd: Microusd;
  readonly basis: 'provider_count' | 'local_estimate';
  readonly priceCatalogVersion: string;
}

/** §8.4: disjoint usage categories (never double-counted). */
export interface NormalizedUsage {
  readonly uncachedInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
  /** Includes reasoning/thinking tokens (billed as output). */
  readonly outputTokens: number;
  /** Informational subset of `outputTokens`. */
  readonly reasoningTokens?: number;
}

/** 04 §D3: decided mechanically by the tracked fetch, never guessed from error text. */
export type DispatchPhase =
  /** fetch never invoked, or the connection provably never carried the request */
  | 'not_sent'
  /** fetch invoked, no Response (status line) yet */
  | 'sent_no_response'
  /** status line arrived; no body byte of a 2xx stream read yet */
  | 'responded'
  /** at least one body byte of a 2xx stream was read */
  | 'responded_partial';

/** One served iteration when a provider-side fallback ran (ADR-016). Each is priced with its own model's prices. */
export interface ServedIteration {
  readonly modelId: string;
  readonly usage: NormalizedUsage;
}

/** Set on a result when a fallback model served (part of) the turn. */
export interface FallbackInfo {
  readonly servedByModel: string;
  readonly iterations: readonly ServedIteration[];
}

/** Successful completion. `json` is `undefined` when `rawText` is not valid JSON (the engine's Zod check then fails). */
export interface ModelSuccess {
  readonly kind: 'success';
  readonly json: unknown;
  readonly rawText: string;
  readonly usage: NormalizedUsage;
  readonly rawUsage: unknown;
  readonly stopReason: 'end_turn';
  readonly providerRequestId?: string;
  readonly providerResponseId?: string;
  readonly latencyMs: number;
  readonly firstByteMs?: number;
  readonly fallback?: FallbackInfo;
}

/** Output allowance reached (or an unrecognized stop reason, recorded in `rawStopReason`). */
export interface ModelTruncated {
  readonly kind: 'truncated';
  readonly rawText: string;
  readonly usage: NormalizedUsage;
  readonly rawUsage: unknown;
  readonly providerRequestId?: string;
  readonly providerResponseId?: string;
  readonly rawStopReason?: string;
  readonly fallback?: FallbackInfo;
}

/** The model declined. */
export interface ModelRefused {
  readonly kind: 'refused';
  readonly category?: string;
  readonly usage: NormalizedUsage;
  readonly rawUsage: unknown;
  readonly providerRequestId?: string;
  readonly providerResponseId?: string;
  readonly fallback?: FallbackInfo;
}

/**
 * A provider or network condition. `error.details` may carry `causeCode`, `providerError` (redacted body),
 * `aborted`, `partialUsage`, `status`.
 */
export interface ModelError {
  readonly kind: 'error';
  readonly error: AppError;
  readonly phase: DispatchPhase;
  readonly retryAfterMs?: number;
  readonly usage?: NormalizedUsage;
  readonly providerRequestId?: string;
  readonly providerResponseId?: string;
}

/** Result of one `generate` call. */
export type ModelResult = ModelSuccess | ModelTruncated | ModelRefused | ModelError;

/** Engine callbacks. Every invocation goes through `safeHook` (R4-27): a throwing hook never changes the result. */
export interface GenerateHooks {
  /** Right before bytes leave (the engine already persisted the dispatch intent). */
  onDispatched?(): void;
  /** Persist ASAP (reconciliation). */
  onResponseId?(ids: { providerRequestId?: string; providerResponseId?: string }): void;
  /** Throttled by the engine; never carries content. */
  onProgress?(p: { outputTokensSoFar: number; elapsedMs: number }): void;
}

/** Context for `generate`. */
export interface GenerateContext {
  readonly apiKey: string;
  readonly signal: AbortSignal;
  readonly hooks?: GenerateHooks;
}

/** Answer of `reconcile` (§7.5). */
export type ReconciliationResult =
  | { readonly kind: 'completed'; readonly json: unknown; readonly usage: NormalizedUsage; readonly rawUsage: unknown }
  | { readonly kind: 'failed'; readonly usage?: NormalizedUsage }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'not_found' };

/** The only provider surface the rest of Relay sees (§8.3). */
export interface ProviderAdapter {
  readonly providerId: ProviderId;
  /** From the catalog (plus live models API when available). */
  capabilities(modelId: string): Promise<ModelCapabilities>;
  estimate(
    req: ModelRequest,
    prices: ModelPrices,
    ctx?: { readonly apiKey?: string; readonly signal?: AbortSignal },
  ): Promise<UsageEstimate>;
  /** Never throws for provider/network conditions; returns `kind: 'error'` with an accurate phase. */
  generate(req: ModelRequest, ctx: GenerateContext): Promise<ModelResult>;
  reconcile?(
    ids: { readonly providerResponseId: string },
    ctx: { readonly apiKey: string; readonly signal: AbortSignal },
  ): Promise<ReconciliationResult>;
  /** FR-02 tiny request. */
  testConnection(ctx: { readonly apiKey: string; readonly signal: AbortSignal; readonly modelId: string }): Promise<ModelResult>;
}
