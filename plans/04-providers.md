# Plan 04: Provider Adapters & Catalog (Agent D)

Spec: §8.1–8.5, §9.2, §9.5, §7.5, §7.6 · Backlog: RLY-008, RLY-010 · Waves (00 §3): **Wave 1 / M1** D1–D4, D7–D8 (contract, catalog, tracking, Anthropic, Fake, registry) · **Wave 2 / M2** D5–D6, D9, D9b (OpenAI + live smokes)

Files (exclusive): `packages/providers/src/**` (including `src/fake-fixtures/**` and `src/__fixtures__/**`), `packages/providers/catalog/**`, and the live tests listed in D9/D9b.

Provider SDK objects never leave this package (§8.3). Everything else sees only the `ProviderAdapter` interface and plain data.

**No runtime filesystem reads.** Catalog files and fake fixtures are loaded through static JSON imports (`with { type: 'json' }`), so the package behaves identically under Node, tsx, Vitest, and the bundled runner (08 §H7). The only file this package ever writes is the fake call log (`createJsonlCallLog`, D7).

---

## D1: Adapter contract (`src/types.ts`)

This extends the spec §8.3 sketch with the fields the checkpoint protocol needs. `generate` reports its **dispatch phase**, so the engine can tell "failed before dispatch" apart from "outcome unknown" (§7.5).

`ProviderId`, `ModelCapabilities`, `ModelPrices`, and `CatalogEntry` are **imported from `@relay/contracts`** (`domain/catalog.ts`, 02 §B2). D does not redefine them. For reference, `ModelCapabilities` carries `structuredOutput`, `streaming`, `tools`, `maxInputTokens?`, `maxOutputTokens?`, `supportsRequestLookup` (can reconcile by id after a crash, §7.5), `supportsTokenCounting` (provider count endpoint for estimates), `effortLevels` (`[]` = unsupported → block if the profile sets effort), and `thinkingAlwaysOn` (the output allowance must include thinking tokens). `ModelPrices` is `{ input, output, cacheRead, cacheWrite }` in integer µUSD per MTok. If the adapter needs a field that is not in the contracts schema, D requests it from the contracts owner rather than adding a local variant.

```ts
import type {
  ProviderId, ModelCapabilities, ModelPrices, CatalogEntry,
  AttemptPurpose, AppError, Microusd,
} from '@relay/contracts';

export interface ModelRequest {
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly system: string;                           // role instructions (versioned prompt text)
  readonly messages: readonly { role: 'user'; content: string }[];   // P0: single user turn carrying assembled context
  readonly outputSchema: { name: string; jsonSchema: Record<string, unknown> };  // from templates (z.toJSONSchema)
  readonly maxOutputTokens: number;
  readonly effort?: 'low'|'medium'|'high'|'xhigh'|'max';
  readonly refusalFallback: 'off' | 'default';       // ADR-016
  readonly metadata: {                               // filled by the engine's buildModelRequest (06 §F4); never secrets
    attemptId: string; runId: string;
    stepKey: string;                                 // used by the fake's script matching + call log
    purpose: AttemptPurpose;                         // 'initial'|'transport_retry'|'schema_repair'|'user_retry'|'reconcile'
  };
}
// Real adapters send ONLY attemptId + runId to the provider (OpenAI `metadata`); stepKey/purpose stay local.

export interface UsageEstimate {                     // §8.3
  inputTokens: number;
  maxOutputTokens: number;
  upperAllowanceMicrousd: Microusd;                  // N for admission (§9.3)
  basis: 'provider_count' | 'local_estimate';
  priceCatalogVersion: string;
}

export interface NormalizedUsage {                   // §8.4 — categories are DISJOINT (no double counting)
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;                              // includes reasoning/thinking tokens (billed as output)
  reasoningTokens?: number;                          // informational subset of outputTokens
}

export type DispatchPhase =
  | 'not_sent'            // fetch never invoked, or the connection provably never carried the request (D3)
  | 'sent_no_response'    // fetch invoked, no Response (status line) yet
  | 'responded'           // status line arrived; no body byte of a 2xx stream read yet
  | 'responded_partial';  // at least one body byte of a 2xx stream was read (firstByteAt set)

export interface ResultFlags {                       // optional on success / truncated / refused; absent = known usage, matching prices
  usageKnown?: boolean;        // false: the terminal response had no usage block; `usage` is a zero placeholder, NOT a known $0
                               //   (engine settles at the reservation N, certainty `estimated`). Anthropic/fake never set it (always known).
  priceTierMismatch?: boolean; // true: billed at a tier the catalog prices do not describe (OpenAI service_tier ≠ 'default');
                               //   engine marks the cost `estimated`
}

export type ModelResult =
  | ResultFlags & { kind: 'success'; json: unknown; rawText: string; usage: NormalizedUsage; rawUsage: unknown;
      stopReason: 'end_turn'; providerRequestId?: string; providerResponseId?: string; latencyMs: number; firstByteMs?: number }
  | ResultFlags & { kind: 'truncated'; rawText: string; usage: NormalizedUsage; rawUsage: unknown; providerRequestId?: string; providerResponseId?: string }
  | ResultFlags & { kind: 'refused'; category?: string; usage: NormalizedUsage; rawUsage: unknown; providerRequestId?: string }
  | { kind: 'error'; error: AppError; phase: DispatchPhase; retryAfterMs?: number;
      usage?: NormalizedUsage; providerRequestId?: string; providerResponseId?: string };
// error.details may carry: causeCode (network cause, D3), providerError (redacted body), aborted, partialUsage.

export interface GenerateHooks {
  onDispatched?(): void;                                 // called right before bytes leave (engine already persisted intent)
  onResponseId?(ids: { providerRequestId?: string; providerResponseId?: string }): void; // persist ASAP (reconciliation)
  onProgress?(p: { outputTokensSoFar: number; elapsedMs: number }): void;  // throttled by engine; never content
}

export interface ProviderAdapter {
  readonly providerId: ProviderId;
  capabilities(modelId: string): Promise<ModelCapabilities>;           // from catalog + live models API when available
  estimate(req: ModelRequest, prices: ModelPrices,
           ctx?: EstimateContext): Promise<UsageEstimate>;   // { apiKey?, signal?, priceCatalogVersion? }
  generate(req: ModelRequest, ctx: { apiKey: string; signal: AbortSignal; hooks?: GenerateHooks }): Promise<ModelResult>;
  reconcile?(ids: { providerResponseId: string }, ctx: { apiKey: string; signal: AbortSignal }): Promise<ReconciliationResult>;
  testConnection(ctx: { apiKey: string; signal: AbortSignal; modelId: string }): Promise<ModelResult>; // FR-02 tiny request
}

export type ReconciliationResult =                  // usageKnown: true only when the retrieved response carried usage;
  | { kind: 'completed'; json: unknown; usage: NormalizedUsage; rawUsage: unknown; usageKnown?: boolean }
  | { kind: 'failed'; usage?: NormalizedUsage; usageKnown?: boolean }   // false ⇒ keep the liability (never a known $0)
  | { kind: 'in_progress' }
  | { kind: 'not_found' };
```

- `generate` **never throws** for provider/network conditions. It returns `kind: 'error'` with an accurate `phase`. It throws only on programmer errors (invariant violations).
- **Estimate contract (R4-12).** When `ctx.apiKey` is present **and** the model's `supportsTokenCounting` is true, the adapter uses the provider count endpoint (`basis: 'provider_count'`). Otherwise, or if the count call fails, it uses the local heuristic (`basis: 'local_estimate'`). **Price-cliff exception (OpenAI):** when the count call fails for a model whose catalog entry sets `maxInputTokens` (the long-context price cliff), the local bound is `conservativeInputTokens(req)` = one token per UTF-16 code unit of system + messages + serialized schema, plus the fixed overhead, so a dense-script prompt (CJK ≈ 1 token/char) cannot slip under `maxInputTokens` via the chars/3.2 heuristic. The engine (06 §F4) resolves the credential **before** estimating, so live dispatches normally pass the key. `upperAllowanceMicrousd = upperBound(inputTokens, maxOutputTokens, prices)` in both cases.
- **Hooks never break a call (R4-27).** Every hook invocation (`onDispatched`, `onResponseId`, `onProgress`) goes through `safeHook(name, fn)`, which wraps it in try/catch, logs `{ hook, errorName }` at `warn` (never the arguments), and swallows the error. A hook failure is never thrown into the SDK stream and never changes the `ModelResult`. The engine's `onResponseId` persists via `AttemptRepo.setProviderIds`, whose per-column COALESCE semantics are defined in 03.

## D2: Catalog & pricing (`src/catalog.ts`, `src/pricing.ts`, `catalog/2026-09-25.json`)

Catalog file format (a **versioned** data file; old versions are kept, never edited, §9.2). Each entry matches the contracts `catalogEntrySchema`; `catalogVersion` is filled from the file header by `loadCatalogEntries()`.

```jsonc
{
  "catalogVersion": "2026-09-25",
  "currency": "USD",
  "entries": [
    // ANTHROPIC PRICES: verify at D2 against the official page (source URL below). If any number differs,
    // correct it, set effectiveDate to the retrieval date, and note the change in the D2 commit message.
    {
      "providerId": "anthropic", "modelId": "claude-opus-5-5", "displayName": "Claude Opus 5.5",
      "capabilities": { "structuredOutput": true, "streaming": true, "tools": true, "maxInputTokens": 1000000,
        "maxOutputTokens": 128000, "supportsRequestLookup": false, "supportsTokenCounting": true,
        "effortLevels": ["low","medium","high","xhigh","max"], "thinkingAlwaysOn": true },
      "prices": { "input": 4000000, "output": 20000000, "cacheRead": 200000, "cacheWrite": 5000000 },
      "effectiveDate": "2026-09-25",
      "source": "https://platform.claude.com/docs/en/about-claude/pricing",
      "sourceRetrievedAt": "2026-09-25"
    },
    { "providerId": "anthropic", "modelId": "claude-sonnet-5-5", "displayName": "Claude Sonnet 5.5",
      "capabilities": { "…": "same shape; thinkingAlwaysOn: true" },
      "prices": { "input": 2000000, "output": 10000000, "cacheRead": 200000, "cacheWrite": 2500000 },
      "effectiveDate": "2026-09-25", "source": "https://platform.claude.com/docs/en/about-claude/pricing",
      "sourceRetrievedAt": "2026-09-25" },
    { "providerId": "anthropic", "modelId": "claude-haiku-4-5", "displayName": "Claude Haiku 4.5",
      "capabilities": { "maxInputTokens": 200000, "effortLevels": [], "thinkingAlwaysOn": false, "…": "…" },
      "prices": { "input": 1000000, "output": 5000000, "cacheRead": 100000, "cacheWrite": 1250000 },
      "effectiveDate": "2026-09-25", "source": "https://platform.claude.com/docs/en/about-claude/pricing",
      "sourceRetrievedAt": "2026-09-25" },
    // OpenAI entries: added in D6 FROM THE OFFICIAL PRICING PAGE with source URL + date. Never invented (§8.1, §17.5 honesty).
    // Fake entry (D7): providerId 'fake', modelId 'fake-model', source "https://relay.invalid/docs/fake-provider" (repo fake-provider doc; reserved TLD, not a price page), sourceRetrievedAt = catalogVersion.
  ]
}
```

- **Source rule (R3-37).** Every entry has the required fields `source` (an `https://` URL), `sourceRetrievedAt` (ISO date the source was retrieved), and `effectiveDate` (ISO date the prices take effect); the price object key is `prices` (contracts `catalogEntrySchema.prices: modelPricesSchema`). Every non-fake entry's `source` is an official pricing URL of the provider. The `fake` entry's `source` is the repo fake-provider doc URL above. The Anthropic URL above is confirmed (and the prices re-checked) when D2 is implemented.
- **Loading (R2-20).** `src/catalog.ts` statically imports each version file (`import catalog20260925 from '../catalog/2026-09-25.json' with { type: 'json' }`) and exports `loadCatalogEntries(): CatalogEntry[]`, which parses every entry with the contracts `catalogEntrySchema` (memoized; a parse failure throws at first call). Adding a catalog version means adding a JSON file **and** its import line. There are no runtime fs reads.
- **Seeding is not D's job (R2-19).** D exports only `loadCatalogEntries()`. The engine's `seedDatabase` (06 §F16) inserts the entries into `model_catalog` idempotently.
- Cache write price uses the 1.25× input rate. Before relying on it, verify it on the pricing page at D2 time. `pricing.test.ts` pins the arithmetic rather than the rates.
- `computeCost(usage: NormalizedUsage, prices: ModelPrices): { microusd, certainty: 'calculated' }` = `Σ mulDivCeil(tokens_cat, price_cat)` over the **disjoint** categories. It never adds `reasoningTokens` separately because they are already in `outputTokens` (§8.4 "do not double-count").
- `upperBound(inputTokens, maxOutputTokens, prices)` = `mulDivCeil(inputTokens, max(prices.input, prices.cacheWrite, prices.cacheRead)) + mulDivCeil(maxOutputTokens, prices.output) + INPUT_SPLIT_ROUNDING_SLACK_MICROUSD` (2 µUSD when `inputTokens > 0`). Every input token is priced at the highest input-side rate (a cache write costs more than an uncached token), and the slack covers `computeCost` rounding each input category up separately. So `upperBound(n, m, p) ≥ computeCost(u, p)` for **every** split of `n` input tokens across uncached / cache read / cache write and output ≤ `m` (fast-check property over random splits and prices, §9.3).
- **Local estimate input.** `inputTokens` of a local estimate counts system + messages + `JSON.stringify(req.outputSchema.jsonSchema)` characters (structured outputs bill the schema as input) through the D4 heuristic, plus a fixed `LOCAL_REQUEST_OVERHEAD_TOKENS = 512` per request (provider-injected structured-output framing). A provider count already includes both.
- **Refusal fallback (ADR-016) in N.** With `refusalFallback: 'default'`, N covers **two hops** (the declined call + the rescue), each priced at the component-wise maximum of the passed prices and every catalog entry of the same provider (all versions; conservatively, every same-provider model counts as an eligible fallback): `N = 2 × upperBound(inputTokens, maxOutputTokens, maxProviderPrices(providerId, prices))`. Shared helper in `estimate.ts` (`buildEstimate`), used by every adapter.
- `computeIterationsCost(iterations, pricesFor, providerId)` prices each served iteration with its own model. An iteration whose model has no known price (a fallback model newer than the catalog) is priced at `maxProviderPrices(providerId, …known)` and the result is `certainty: 'estimated'`; it never returns `undefined`.
- **Price catalog version.** `UsageEstimate.priceCatalogVersion` is the version of the **same** catalog entry as the prices passed: `estimate(req, prices, { priceCatalogVersion })` (the engine passes the profile snapshot's version alongside its prices); when omitted, the newest entry for `(providerId, modelId)` whose prices equal the passed prices (`priceCatalogVersionFor`).

## D3: Dispatch tracking & error mapping (`src/tracked-fetch.ts`, `src/errors.ts`)

**Dispatch phase is decided mechanically, never guessed from error text.**

### `trackedFetch`

```ts
export interface DispatchTracker {
  readonly phase: DispatchPhase;
  readonly causeCode?: string;        // err.cause?.code when fetch rejected
  readonly requestId?: string;        // from `request-id` / `x-request-id` response header
  readonly status?: number;
  readonly firstByteAt?: number;      // first body chunk of a 2xx response
}
export function createTrackedFetch(
  baseFetch: typeof fetch,
  opts: { clock: Clock; onDispatched?: () => void },
): { fetch: typeof fetch; tracker: DispatchTracker };
```

- The adapter wraps an **injected** base fetch. Adapter factories take `fetch?: typeof fetch`; when omitted, the adapter reads `globalThis.fetch` **at call time**, never captured at module load, so test mocks and the integration suite's no-network guard (11) always apply. Each `generate` / `testConnection` / `reconcile` call creates its own tracker and passes the wrapped `fetch` as the SDK's `fetch` option.
- `phase = 'not_sent'` until the wrapped fetch is invoked. At invocation it becomes `sent_no_response` and `onDispatched()` fires (through `safeHook`); the engine has already persisted the durable intent (06 §F4).
- If `baseFetch` rejects, the tracker stores `err.cause?.code` as `causeCode` and classifies:
  - `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, any `CERT_*`, any `ERR_TLS_*`, `EHOSTUNREACH`, `ENETUNREACH` → back to `not_sent` (the request provably never reached the provider).
  - Anything else (including a missing code, `ECONNRESET`, `UND_ERR_SOCKET`, timeouts after connect) → stays `sent_no_response`.
- When a `Response` resolves: `phase = 'responded'`, `status` recorded, and `request-id` / `x-request-id` captured from the headers. The header value is the preferred `providerRequestId`; the SDK's `_request_id` is used only as a fallback.
- For 2xx responses, the body is piped through a pass-through `TransformStream` that sets `firstByteAt` (and `phase = 'responded_partial'`) on the first chunk. Non-2xx bodies are not tracked (they are complete error responses).
- `causeCode` is copied into `error.details.causeCode` on every mapped network error.

### Mapping chain

The mapping is a specific-first chain, following the claude-api skill's advice to catch a chain rather than one broad class. **In the TypeScript SDKs, `APIConnectionError` is a subclass of `APIError`, so check it first; and the SDKs classify HTTP 529 as `InternalServerError`, so check the status before that branch.** Rows are evaluated top to bottom; the first match wins.

| # | Condition | `AppError.code` | phase | Engine retry class (06 §F7) |
|---|---|---|---|---|
| 1 | `APIUserAbortError` (our `AbortSignal`) | `INTERNAL` with `details.aborted = true` (the engine treats it as cancellation, not an error) | from tracker | cancellation path |
| 2 | **Any failure after `firstByteAt`**: an SSE `error` event (Anthropic `overloaded_error` / `api_error`, OpenAI `error` event), a connection drop or parse failure mid-stream, or an OpenAI terminal `response.failed` | `REQUEST_OUTCOME_UNKNOWN` (includes `providerResponseId` when known; partial usage in `details.partialUsage`) | `responded_partial` | **no blind retry**. Unknown flow (§7.5); reconcile if supported. **Never** `PROVIDER_UNAVAILABLE` |
| 3 | 2xx status line received, stream fails before the first body byte | `REQUEST_OUTCOME_UNKNOWN` | `responded` | no blind retry (the provider accepted the request) |
| 4 | `APIConnectionError` / `APIConnectionTimeoutError`, tracker phase `not_sent` (DNS, refused, TLS, unreachable) | `PROVIDER_UNAVAILABLE` (`details.causeCode`) | `not_sent` | transport retry |
| 5 | `APIConnectionError` / `APIConnectionTimeoutError`, tracker phase `sent_no_response` | `REQUEST_OUTCOME_UNKNOWN` (`details.causeCode`) | `sent_no_response` | **no blind retry** (§7.6). User decision |
| 6 | HTTP **529** (overloaded), checked **before** row 11 | `RATE_LIMITED`, `retryAfterMs` = `retry-after` header seconds × 1000, capped at 60 000 | `responded` | rate-limit backoff |
| 7 | `RateLimitError` 429 | `RATE_LIMITED`, `retryAfterMs` as row 6 | `responded` | rate-limit backoff |
| 8 | `AuthenticationError` 401, `PermissionDeniedError` 403 | `AUTH_REQUIRED` | `responded` | none. Pause immediately (§7.6) |
| 9 | `NotFoundError` 404 | `MODEL_UNSUPPORTED` | `responded` | none |
| 10a | `BadRequestError` 400 whose error type/message indicates prompt too long | `CONTEXT_TOO_LARGE` | `responded` | none |
| 10b | other `BadRequestError` 400, `UnprocessableEntityError` 422 | `MODEL_UNSUPPORTED` (redacted provider message in `details.providerError`) | `responded` | none |
| 11a | HTTP **502** / **504** (gateway) before any body byte, checked **before** row 11b | `REQUEST_OUTCOME_UNKNOWN` (`details.gateway = true`) | `responded` | **no blind retry** (§7.6): an intermediary answered, the provider may have executed the request |
| 11b | `InternalServerError` (500, 503, other ≥ 500 except 502/504/529) — an HTTP 5xx status line from the provider, so **no body byte of a stream** was ever produced | `PROVIDER_UNAVAILABLE` | `responded` | transport retry (known not executed: the provider answered with an error status and produced no output) |

- The 5xx-before-any-body-byte rule (row 11b; never 502/504, row 11a) and the `not_sent` rule (row 4) are the **only** transport-retryable cases. `responded_partial` and `sent_no_response` always map to `REQUEST_OUTCOME_UNKNOWN` (06 §F7, R3-6).
- `PROVIDER_UNAVAILABLE` is a contracts taxonomy extension (02 §B3: retryable, nextAction `wait`, future HTTP 502).
- All raw provider error bodies pass through `redactDeep` before they are stored in `attempts.error_json.details.providerError`.

## D4: Anthropic adapter (`src/anthropic.ts`)

The SDK is `@anthropic-ai/sdk` (TypeScript), with facts from the claude-api skill, cached 2026-09-25:

- **Factory:** `createAnthropicAdapter({ clock, logger?, fetch? })`. `fetch` is the injected base fetch for `createTrackedFetch` (D3).
- **Client per request:** `new Anthropic({ apiKey, maxRetries: 0, timeout: 600_000, fetch: tracked.fetch })`. **`maxRetries: 0` is required** by ADR-013: the engine owns retries so that every HTTP attempt is an `Attempt` row with its own reservation. Construct the client per call so the key is not retained between calls.
- **Streaming** is always on (`client.messages.stream(params, { signal })`). The final message comes from `await stream.finalMessage()`. Streaming avoids HTTP timeouts at large `max_tokens` and gives an early `message_start` for the response id.
- **Request params:**
  ```ts
  {
    model: req.modelId,
    max_tokens: req.maxOutputTokens,
    system: req.system,
    messages: req.messages,
    output_config: {
      format: { type: 'json_schema', schema: req.outputSchema.jsonSchema },   // structured outputs (NOT deprecated output_format)
      ...(req.effort ? { effort: req.effort } : {}),
    },
    // thinking: OMITTED. On claude-opus-5-5 thinking is always on; {type:'disabled'} and budget_tokens return 400.
    // tool_choice: OMITTED. Forced tool_choice any/tool returns 400 on Opus 5.5 / Sonnet 5.5; P0 uses no tools (ADR-014).
    // No assistant prefill (400 on current models).
    // No metadata fields from req.metadata are sent (Anthropic metadata is user_id only).
    // fallbacks: only when req.refusalFallback === 'default' → client.beta.messages.stream with
    //   betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'   (ADR-016; off by default)
  }
  ```
  If `effort` is set but the catalog `effortLevels` lacks it (for example Haiku 4.5), the call is **blocked in capability validation** (§8.4: "block it rather than silently ignoring a requested control"). The adapter asserts this as well.
- **Ids:** `message_start` event → `onResponseId({ providerResponseId: message.id, providerRequestId })`, where `providerRequestId` is the tracker's header `request-id` (D3). `finalMessage._request_id` (non-enumerable; read explicitly) is used only if the header was absent.
- **Stop reasons:** `end_turn` → parse JSON (`JSON.parse` on the text block, then the engine validates with Zod) → `success`. `max_tokens` → `truncated`. `refusal` → `refused` with `stop_details?.category` (guard: `stop_details` is null otherwise). Any other value is treated as `truncated`, with the raw reason in the details.
- **Mid-stream failures:** an SSE `error` event (`overloaded_error`, `api_error`) or a dropped connection after `message_start` is mapped by D3 row 2 → `REQUEST_OUTCOME_UNKNOWN`, phase `responded_partial`, with the `message.id` as `providerResponseId`.
- **Usage mapping** (disjoint): `uncachedInputTokens = usage.input_tokens`, `cacheReadInputTokens = usage.cache_read_input_tokens ?? 0`, `cacheWriteInputTokens = usage.cache_creation_input_tokens ?? 0`, `outputTokens = usage.output_tokens`. In the Anthropic API, `input_tokens` already **excludes** cache reads and writes. When fallbacks are enabled and `usage.iterations` shows that a fallback model served the turn, price each iteration with **its** model's catalog entry, record `details.servedByModel`, and set certainty to `calculated`.
- **Estimate:** per D1's estimate contract. With `ctx.apiKey` and `supportsTokenCounting`, call `client.messages.countTokens({ model, system, messages })` → `basis: 'provider_count'`. Counting is free but rate-limited. Without a key, or on any count failure, use the local heuristic `ceil(chars / 3.2 × 1.15)` → `basis: 'local_estimate'`.
- **Reconcile:** not implemented (`supportsRequestLookup: false`). There is no endpoint that looks up a past Messages request (verified 2026-09-30 against the SDK typings). Unknown Anthropic outcomes therefore always go to the user decision flow (§7.5).
- **testConnection:** `max_tokens: 16`, a trivial schema `{ok: boolean}`, and the cheapest catalog model for that provider unless the user picked one. The engine's setup-call handler (06 §`setup-calls.ts`) admits, reserves, and records the cost under the ledger `setup` scope.

## D5: OpenAI adapter (`src/openai.ts`)

The SDK is `openai` 7.25+ using the **Responses API** (facts verified 2026-09-30 from the SDK typings):

- Factory `createOpenAIAdapter({ clock, logger?, fetch? })`. Client per request: `new OpenAI({ apiKey, maxRetries: 0, timeout: 600_000, fetch: tracked.fetch })`.
- `client.responses.stream({ model, instructions: req.system, input: req.messages, max_output_tokens: req.maxOutputTokens, text: { format: { type: 'json_schema', name: req.outputSchema.name, schema: req.outputSchema.jsonSchema, strict: true } }, reasoning: req.effort ? { effort: mapEffort(req.effort) } : undefined, store, metadata: { relay_attempt_id: req.metadata.attemptId, relay_run_id: req.metadata.runId } }, { signal })`. Only the two ids are sent; `stepKey` and `purpose` are never sent.
  - `store: true` (the project default, `providerOptions.openai.storeResponses`) is **required for reconciliation** via `responses.retrieve(id)`. It keeps the response on the provider for ≥ 30 days. Surface this in Settings as a data-handling note (§6.2 boundary honesty) and let the user switch it off per project. When off, send `store: false` and report `supportsRequestLookup = false`.
  - `mapEffort`: map only to levels the catalog lists for that model. Otherwise block at validation.
  - `service_tier: 'default'` is always sent (the catalog prices are the standard tier; `auto` could route to flex/priority/scale per project settings). The response's `service_tier` is read: any reported tier other than `'default'` sets `priceTierMismatch: true` on the result (the engine marks the cost `estimated`); an absent value is treated as the requested default.
  - **Auth headers are pinned per request.** The SDK merges `OPENAI_CUSTOM_HEADERS` from the environment into `defaultHeaders`, which are applied after the auth headers. The adapter therefore (a) strips `Authorization` / `OpenAI-Organization` / `OpenAI-Project` via `defaultHeaders: { …: null }` and (b) passes `headers: { Authorization: 'Bearer <user key>', 'OpenAI-Organization': null, 'OpenAI-Project': null }` in the per-call `RequestOptions` (applied last) on `responses.stream`, `responses.inputTokens.count` and `responses.retrieve`, so nothing from the environment can replace the user's key or add an org/project.
  - **Strict JSON-schema subset:** templates must emit schemas compatible with OpenAI strict mode (every property in `required`, `additionalProperties: false`, and `null` unions instead of optional). `z.toJSONSchema` output is post-processed by `toStrictJsonSchema()` in **templates** (07 §G6). D owns only the assertion `assertStrictCompatible(schema)`, which throws in dev.
- **Ids:** the first stream event `response.created` → `onResponseId({ providerResponseId: response.id, providerRequestId })`. **Persisting this early is what makes post-crash reconciliation possible.** `providerRequestId` comes from the tracker's `x-request-id` header, falling back to `_request_id`.
- **Usage presence:** a terminal response without a `usage` block yields zero placeholders plus `usageKnown: false` on `success` / `truncated` / `refused` (never a known $0).
- **Status handling:** `response.status === 'completed'` → parse `output_text` → `success`. `'incomplete'` with `incomplete_details.reason === 'max_output_tokens'` → `truncated`. `'incomplete'` with reason `content_filter` → `refused`. A refusal content item → `refused`. A terminal `response.failed`, an `error` stream event, or a dropped stream after `response.created` → D3 row 2 (`REQUEST_OUTCOME_UNKNOWN`, `responded_partial`, with `providerResponseId`); reconciliation then settles it from `responses.retrieve`.
- **Usage mapping** (disjoint; §8.4): `cached = usage.input_tokens_details?.cached_tokens ?? 0`, `cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0`, `uncachedInputTokens = usage.input_tokens − cached − cacheWrite`, `outputTokens = usage.output_tokens` (**includes** `output_tokens_details.reasoning_tokens`), `reasoningTokens = …reasoning_tokens`. In OpenAI, `input_tokens` **includes** cached tokens, while in Anthropic it excludes them. This asymmetry is the double-count trap named in spec §8.4. `usage.test.ts` pins both mappings with fixtures.
- **Estimate:** per D1's estimate contract. `supportsTokenCounting` is `false` in the catalog (local heuristic only) unless a token-count endpoint is verified at implementation time, in which case the catalog flag and the provider-count branch are added together.
- **Reconcile:** `client.responses.retrieve(providerResponseId)`. `completed` → `{kind:'completed', json, usage, usageKnown}`. `failed`/`cancelled`/`incomplete`/missing status → `{kind:'failed', usage?, usageKnown}`. `usageKnown` is `true` only when the response carried usage; without it the result keeps the liability (`usageKnown: false`) instead of reading as a known $0. `queued`/`in_progress` → `{kind:'in_progress'}`. 404 → `not_found`.
- **testConnection:** `max_output_tokens: 256` (`OPENAI_CONNECTION_TEST_MAX_OUTPUT_TOKENS`; `connectionTestRequest('openai', …)` carries it, `connectionTestMaxOutputTokens(providerId)` exposes it for N) at the **lowest** listed effort. Reasoning is always on, and 16 tokens can be consumed by reasoning before the answer; a `truncated` result still counts as a working connection.
- **Cancellation:** abort the stream via the signal. OpenAI may still bill partial output, so the engine keeps liability until reconciled (§9.5).

## D6: OpenAI catalog entries
- Fetch the current OpenAI pricing and models page. Pick **one** model that supports strict JSON-schema structured output and streaming for the "Balanced" profile. Record `source` (the official `https://` pricing URL), `sourceRetrievedAt` (retrieval date), and `effectiveDate` (date the prices take effect).
- Add it to `catalog/2026-09-25.json`, or to a new version file (plus its static import in `src/catalog.ts`) if the date differs. Unit tests use `catalog/test-fixture.json`, whose prices are round numbers and **clearly fake**.

## D7: Fake provider (`src/fake.ts`, `src/fake-scenarios.ts`, `src/fake-fixtures/**`, `src/call-log.ts`) — deterministic, scriptable (spec §13.2, §17)

```ts
export interface FakeScriptStep {
  match?: { stepKey?: string; purpose?: AttemptPurpose };
  times?: number;                           // calls this step serves before it is consumed (default 1; Infinity allowed)
  delayMs?: number;                         // uses the injected clock/timers only (never global fake timers)
  result:
    | { kind: 'success'; fixture: string }  // key into FAKE_FIXTURES (src/fake-fixtures) or opts.extraFixtures
    | { kind: 'malformed'; text: string }   // non-JSON / schema-invalid
    | { kind: 'truncated' } | { kind: 'refused' }
    | { kind: 'auth_error' } | { kind: 'rate_limited'; retryAfterMs: number } | { kind: 'server_error' }  // server_error = 5xx before any body byte
    | { kind: 'hang' }                      // never resolves until aborted → cancellation tests
    | { kind: 'unknown_after_dispatch' }    // onDispatched + onResponseId, then connection reset → sent_no_response
    | { kind: 'midstream_error' }           // onDispatched + onResponseId + onProgress, then SSE error → responded_partial
    | { kind: 'crash_process_after_dispatch' }  // see "Crash step" below (11 §K4)
    | { kind: 'overrun'; outputTokens: number };// usage exceeds reservation (§9.5 overrun)
  usage?: Partial<NormalizedUsage>;
  reconcile?: ('completed'|'failed'|'in_progress'|'not_found')[];  // successive answers to reconcile() for attempts served by this step
}

export interface FakeScenario {
  name: string;
  steps: FakeScriptStep[];
  capabilityOverrides?: Partial<ModelCapabilities>;   // e.g. { supportsRequestLookup: true } for reconcile scenarios
}

export type FakeCall = {
  at: number; runId: string; attemptId: string; stepKey: string; purpose: AttemptPurpose;
  providerId: ProviderId; modelId: string; systemSha256: string;
};
export interface FakeCallLog { append(call: FakeCall): void; entries(): FakeCall[] }   // append is synchronous
export function createJsonlCallLog(filePath: string): FakeCallLog;   // appendFileSync one JSON line per call
export function createMemoryCallLog(): FakeCallLog;

export function createFakeProvider(opts: {
  providerId: ProviderId;                              // reports the real id (D8)
  scenario: FakeScenario; clock: Clock; timers?: Timers;
  callLog?: FakeCallLog;
  capabilityOverrides?: Partial<ModelCapabilities>;    // merged over scenario.capabilityOverrides
  extraFixtures?: Record<string, unknown>;             // K2 integration variants (11)
  exit?: (code: number) => never;                      // default process.exit; fake.test.ts injects a spy
  logger?: Logger;
}): ProviderAdapter;

export const FAKE_SCENARIOS: Record<string, FakeScenario>;
```

**Scenarios** (`FAKE_SCENARIOS`; each unlisted call falls through to the happy-path fixture for its `stepKey`):

| Name | Script |
|---|---|
| `happy-path` | Every step succeeds with its fixture |
| `slow-review` | `review` initial → success after `delayMs: 5000` (injected timers); every other call is the happy path. Used by 12 L2 (`responsiveness.spec.ts`, `run-happy-path.spec.ts`) to observe "while running" states |
| `budget-exhaustion` | Success with large usage so the run allowance is reached mid-template |
| `malformed-then-ok` | `review` initial → `malformed`; `schema_repair` → success |
| `malformed-twice` | `review` initial and `schema_repair` → `malformed`; `user_retry` → success (11 R3-1) |
| `auth-fail` | First call → `auth_error` |
| `rate-limit-then-ok` | `review` initial → `rate_limited` (1000 ms); next → success |
| `rate-limit-exhausted` | `review` → `rate_limited` (1000 ms), `times: Infinity` for `initial`/`transport_retry` matches; `user_retry` → success |
| `server-error-twice` | `review` initial and `transport_retry` → `server_error`; `user_retry` → success |
| `refused` | `review` initial → `refused`; `user_retry` → success |
| `unknown-outcome` | `implement` initial → `unknown_after_dispatch` |
| `midstream-error` | `review` initial → `midstream_error` (→ unknown, no auto retry) |
| `crash-after-dispatch-plan` | `plan` initial → `crash_process_after_dispatch`; any later `plan` call → success |
| `reconcile-completed` | Happy path with `reconcile: ['completed']` on every step; `capabilityOverrides: { supportsRequestLookup: true }` (11 crash row 4) |
| `reconcile-slow` | `implement` initial → `unknown_after_dispatch` with `reconcile: ['in_progress','in_progress','completed']`; `supportsRequestLookup: true` |
| `revise-then-accept` | `verify` first → revise verdict; second → accept |
| `revise-until-limit` | `verify` → revise verdict, `times: Infinity` |
| `hang` | `review` initial → `hang` |
| `overrun` | `review` → `overrun` with `outputTokens` above the reservation |

**Behavior:**

- **Script matching.** Each `generate` call uses the first not-yet-consumed step whose `match` (on `req.metadata.stepKey` / `req.metadata.purpose`) matches; a step is consumed after serving `times` calls. With no match, the call succeeds with the default fixture for that `stepKey`.
- **Ids.** After `onDispatched`, the fake **always** calls `hooks.onResponseId({ providerResponseId: 'fake_resp_<attemptId>' })` (via `safeHook`), for every result kind including `crash_process_after_dispatch`.
- **Call log.** Every `generate` call appends one `FakeCall` built from `req.metadata` (`stepKey`, `purpose`, ids), `providerId`, `modelId`, and `sha256(req.system)`, **before** the result is produced. `createJsonlCallLog` writes synchronously (`appendFileSync`), so an entry survives an immediate process exit. The crash-recovery e2e test (12 §L6) and the harness read it (`userData/fake-call-log.jsonl`, wired by 06 §F16 / 08 §H7) to prove completed steps are **not re-executed**.
- **Crash step.** `crash_process_after_dispatch` calls `onDispatched`, then `onResponseId`, then appends the call-log line with `appendFileSync`, and only then calls the injected `exit(137)` (default `process.exit`). `fake.test.ts` injects a spy and asserts the line is on disk before the spy is invoked.
- **Reconcile.** `reconcile({ providerResponseId })` strips the `fake_resp_` prefix to get the attempt id, finds its `FakeCall` in the call log (the JSONL log survives a process restart; an in-memory map is used when no log is configured), re-matches the script step for that call, and returns the step's `reconcile` entries in order (one per `reconcile` call; the last entry repeats). `completed` returns the step's success fixture and usage; `failed` returns the step usage if set. A step without `reconcile` answers `not_found`. The fake reports `supportsRequestLookup` from its catalog entry merged with the capability overrides; `reconcile` is only called by the engine when that flag is true.
- **Capabilities.** `capabilities(modelId)` returns the catalog entry for `(providerId, modelId)` if one exists, else the `fake-model` entry, then applies `scenario.capabilityOverrides` and `opts.capabilityOverrides` (in that order).
- **Timers.** `delayMs` and `hang` use the injected `timers`/`clock` only; tests never rely on global fake timers (R4-36).
- **Fixtures (R2-21).** Success fixtures live in D-owned `packages/providers/src/fake-fixtures/*.json` (`findings.v1.json`, `plan.v1.json`, `patch.v1.json`, `review.v1.accept.json`, `review.v1.revise.json`, `connection-test.json`), each statically imported by `src/fake-fixtures/index.ts` into `FAKE_FIXTURES`. Their patches apply to `tests/fixtures/sample-api` (K1); K's `fixtures.int.test.ts` verifies that. Integration-only variants (K2) are supplied through `extraFixtures`.
- The fake provider is selected when `RELAY_PROVIDER_MODE=fake`. **Packaged builds ignore this variable unless `RELAY_E2E=1`** (08 §H1), so a real user can never be served fake results. This is spec §22.2: "never present a scripted fake-provider response as a live model result". The UI also shows a persistent "Fake provider" badge whenever it is active.
- Fake prices: `providerId: 'fake'`, `modelId: 'fake-model'`, `input 1_000_000`, `output 2_000_000` µUSD/MTok.

**Reconcile persistence (F6 audit fix).** Each `generate` log line records `kind: 'generate'` and `scriptStep` (the index of the script step that served it). Each reconcile call appends `{ kind: 'reconcile', at, attemptId, providerId }`. After a restart the fake looks up the serving step by `scriptStep` and advances the reconcile answer by counting prior reconcile lines for that attempt. `entries()` returns generate lines only.

## D8: Registry (`src/registry.ts`)

```ts
export function createProviderRegistry(opts: {
  mode: 'live' | 'fake';
  fakeScenario?: string | FakeScenario;                  // FAKE_SCENARIOS key or an inline scenario; default 'happy-path'; unknown name → throws
  clock: Clock;
  timers?: Timers;                                       // passed to fake adapters (delayMs / hang); default global timers
  callLog?: FakeCallLog;                                 // fake mode only
  fakeCapabilityOverrides?: Partial<ModelCapabilities>;  // fake mode only; merged over the scenario's overrides
  extraFixtures?: Record<string, unknown>;               // fake mode only; forwarded to createFakeProvider (K2 variants)
  logger?: Logger;                                       // hook-failure warnings (D1) and fake adapters; default no-op
}): { get(providerId: ProviderId): ProviderAdapter; list(): ProviderId[] };
```

- In fake mode every provider id resolves to a fake adapter that reports the real `providerId` (sharing one scenario cursor and one call log), so the multi-provider workflow path is exercised end-to-end. Fake options are ignored in live mode.
- Live adapters are built with no `fetch` override, so they read `globalThis.fetch` at call time (D3).
- `createJsonlCallLog(filePath)` is exported from the package barrel; the runtime (06 §F16) passes `createJsonlCallLog(join(userDataDir, 'fake-call-log.jsonl'))` in fake mode.

## D10: Gemini adapter (`src/gemini.ts`) — third BYOK provider (founder request 2026-09-30)

Scheduled for the end of Wave 2, **after** D4 and D5 pass their gates. It is not needed for the M2 gate, which requires the Anthropic + OpenAI pair. It is the first scope cut if behind (§21.1).

**Verify every SDK fact below against the official `@google/genai` docs at D10 start.** Record URLs in the catalog `source` and note any differences in the D10 commit message.

- **SDK:** `@google/genai` (the unified Google GenAI SDK), with a client per request: `new GoogleGenAI({ apiKey })`. Pass `trackedFetch` if the SDK accepts a custom fetch. Otherwise wrap at the HTTP-options level, and if neither is possible, classify phase by error type (documented limitation, with a test).
- **Retries:** disable SDK retries if the option exists (ADR-013).
- **Call:** `ai.models.generateContentStream({ model, contents: [{ role: 'user', parts: [{ text }] }], config: { systemInstruction: req.system, maxOutputTokens: req.maxOutputTokens, responseMimeType: 'application/json', responseJsonSchema: req.outputSchema.jsonSchema, thinkingConfig: mapEffort(req.effort), abortSignal: signal } })`.
  - If `responseJsonSchema` is unavailable, fall back to `responseSchema` with the OpenAPI-subset conversion.
  - `capabilities.structuredOutput` is false for any model that can't do either, and those models are blocked.
- **Ids:** capture `responseId` from the first chunk → `onResponseId`. `supportsRequestLookup: false`: there is no retrieval endpoint, so unknown outcomes go to the user decision flow (like Anthropic).
- **Usage mapping (disjoint, §8.4). This is a third variant of the double-count trap:**
  - `uncachedInputTokens = promptTokenCount − (cachedContentTokenCount ?? 0)`
  - `cacheReadInputTokens = cachedContentTokenCount ?? 0`
  - `cacheWriteInputTokens = 0`
  - `outputTokens = candidatesTokenCount + (thoughtsTokenCount ?? 0)`
  - `reasoningTokens = thoughtsTokenCount`

  Thinking tokens are reported **separately** from candidates but billed as output. Verify this against the pricing page, and pin it with a `usage.test.ts` fixture next to the Anthropic and OpenAI cases.
- **Service tier:** always send `config.serviceTier: 'standard'` (the catalog prices are the Standard paid tier). The reported `usageMetadata.serviceTier` (Developer API) other than `standard` / `unspecified`, or `usageMetadata.trafficType` (Vertex) other than `ON_DEMAND` / `TRAFFIC_TYPE_UNSPECIFIED`, sets `priceTierMismatch: true`. An absent value is treated as the requested standard tier.
- **Usage finality:** usage is known only when a `usageMetadata` block arrived on or after the chunk carrying `finishReason` (or the prompt `blockReason`); an earlier block is a running count, so a stream whose terminal chunk carries no usage → `usageKnown: false` (`rawUsage` / `partialUsage` still carry the last block).
- **Aborts:** the SDK calls `fetch` even when `abortSignal` is already aborted. The adapter's fetch (and `trackedFetch` itself, for every adapter) throws an `AbortError` without dispatching, so the phase stays `not_sent` and `onDispatched` never fires.
- **SSE error events:** a mid-stream `data: {"error":{…}}` event is parsed by the SDK into an empty chunk (the error is dropped). The adapter watches the raw 2xx body for such events and attaches the redacted `{ error: { code, status, message } }` as `details.providerError` (plus `details.errorType` = the RPC status) to the resulting `REQUEST_OUTCOME_UNKNOWN`; the classification (D3 row 2, no blind retry) is unchanged.
- **Finish reasons:** `STOP` → success. `MAX_TOKENS` → truncated. `SAFETY` / `PROHIBITED_CONTENT` / `RECITATION` / `BLOCKLIST` → refused. Any other value → truncated with the raw reason. Also map a blocked prompt (`promptFeedback.blockReason`) → refused.
- **Errors:** map the SDK's API error by HTTP status using the same D3 table (401/403 → `AUTH_REQUIRED`, 404 → `MODEL_UNSUPPORTED`, 429 → `RATE_LIMITED`, 500/503 before body → `PROVIDER_UNAVAILABLE`, 502/504 → `REQUEST_OUTCOME_UNKNOWN` (gateway: may have executed), mid-stream → `REQUEST_OUTCOME_UNKNOWN`).
- **Estimate:** use `ai.models.countTokens` when an apiKey is present, otherwise the local heuristic.
- **Catalog:** add one Gemini model with streaming + JSON-schema output to the catalog, with official pricing `source` + `sourceRetrievedAt`. The tiered long-context prices must be handled: store the **higher** tier as the admission price unless the request's input is provably below the tier threshold, so admission stays conservative (§9.3).
- **Tests:** `gemini.test.ts` (mock fetch or mock client with recorded chunks under `src/__fixtures__/gemini/`), plus the `usage.test.ts` Gemini fixture, plus `tests/live/gemini.live.test.ts` (same $0.10 cap).
- **Fake mode:** the registry resolves `'gemini'` to a fake adapter reporting `providerId: 'gemini'`, like the others.

## D9: Live smoke tests (`tests/live/` — **owned by D** as an exception, listed here: `tests/live/providers.live.test.ts`, `tests/live/provider-smoke.ts`, `tests/live/live-budget.ts` + its offline `live-budget.test.ts`)
- They run only with `RELAY_LIVE_TESTS=1` and keys from env (the test runner's env only, never the app's).
- Each test does one `testConnection`, one `estimate` with the key (provider count where supported), and one tiny `generate` against the `findings.v1` schema with a 20-line fixture input.
- A cumulative cap is enforced: `RELAY_LIVE_TEST_CAP_MICROUSD` (default 100 000 = $0.10) for **all providers together** — both providers run in the single file `providers.live.test.ts`, sharing one `LiveBudget` (separate files would run in separate workers with separate totals). §20.4 says not to spend without authorization.
  - **Pre-check before every billable call** (including `testConnection`, using the estimate of `connectionTestRequest(providerId, modelId)`): `spent + upperAllowance > cap` fails the test without dispatching.
  - **Charging** (`liveChargeMicrousd`): known usage → `computeCost`; `usageKnown: false` → the upper allowance N; `priceTierMismatch` → max(cost, N); an `error` with phase `not_sent` → 0; any other `error` (outcome possibly billed) → max(N, cost of `partialUsage`).
- The tests assert the id capture (`providerResponseId` is set before completion; `providerRequestId` comes from the response header), the usage mapping with no negative values, and the redaction of the error body on a deliberately invalid model id.

## D9b: Live workflow test (`tests/live/workflow.live.test.ts` — owned by D)
- Runs only with `RELAY_LIVE_TESTS=1` and provider keys from env.
- For each live adapter (Anthropic, then OpenAI; an adapter whose key is absent is skipped with a printed notice), it runs the **full template once** via `createRuntime({ providerMode: 'live', … })` (06 §F16) against a temp copy of `tests/fixtures/sample-api`, with every step on that adapter's catalog model and a credentials resolver that reads the env key.
- Approval is automatic through the service API (`approvals.decide` with `approve`), never through the UI.
- Spend cap: `RELAY_LIVE_WORKFLOW_CAP_MICROUSD` (default `1_500_000` = $1.50) for the whole file. Each run's budget `L` is set to the remaining cap, so the engine's admission blocks any dispatch that would exceed it. In `finally` (every path, **before** `rt.dispose()`), the test adds the run's ledger `C + U + R` (settled + unknown + still-reserved) to the file total (`createWorkflowSpend`) and then fails if the cumulative total exceeds the cap (or if the ledger could not be read). After any failure the remaining providers are skipped.
- Asserts: run reaches `completed` (or `paused(budget_run)` with a clear message if the cap is too low), every attempt has a `providerResponseId`, ledger certainty is `calculated`, and the patch applies to the snapshot.

## Unit tests (owned by D, colocated)

SSE fixtures live in D-owned `packages/providers/src/__fixtures__/{anthropic,openai}/*.sse`: synthetic streams hand-authored to match the documented event shapes, with usage blocks that include the cache categories. Tests read them with `readFileSync(new URL(…, import.meta.url))` (test code only). Files: `anthropic/{success,cache-usage,max-tokens,refusal,overloaded-midstream-error,api-midstream-error}.sse` and `openai/{success,cache-usage,incomplete-max-output,refusal,failed-midstream-error,error-event-midstream-error}.sse`. Connection drops are simulated by the mock fetch erroring the body stream after N bytes of `success.sse`.

| File | Must cover |
|---|---|
| `pricing.test.ts` | Disjoint-category cost. `mulDivCeil` ceil behavior. Upper bound ≥ any actual cost with the same token counts. `fast-check`: `computeCost(u) <= upperBound(u.total_in, u.output)` whenever cache categories are 0 |
| `usage.test.ts` | Anthropic fixture: `input_tokens=1000, cache_read=500, cache_creation=200` → uncached 1000, read 500, write 200. OpenAI fixture: `input_tokens=1700, cached=500, cache_write=200` → uncached 1000 (not 1700). Reasoning is not double-counted |
| `tracked-fetch.test.ts` | Uses an **injected** base fetch (never `globalThis`). `not_sent` before invocation. Rejection with `cause.code` `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, `CERT_HAS_EXPIRED`, `ERR_TLS_CERT_ALTNAME_INVALID`, `EHOSTUNREACH`, `ENETUNREACH` → `not_sent`; `ECONNRESET` and no cause → `sent_no_response`; `causeCode` stored. `request-id` / `x-request-id` header captured. First 2xx body chunk sets `firstByteAt` and `responded_partial`; a 5xx body does not. `onDispatched` fires exactly once at invocation |
| `errors.test.ts` | Every D3 row in order (construct SDK error instances directly plus tracker states). 529 → `RATE_LIMITED` (not `PROVIDER_UNAVAILABLE`). 5xx with no stream byte → `PROVIDER_UNAVAILABLE`. SSE `overloaded_error` / `api_error` and a mid-stream drop after `firstByteAt` → `REQUEST_OUTCOME_UNKNOWN`, `responded_partial`, `providerResponseId` included — never `PROVIDER_UNAVAILABLE`. Connection error in `sent_no_response` → `REQUEST_OUTCOME_UNKNOWN`. `details.causeCode` present. Provider error body redacted |
| `anthropic.test.ts` | Uses a **mock `fetch`** (injected) that serves `src/__fixtures__/anthropic/*.sse`. Request body has `output_config.format`, **no** `thinking`, **no** `tool_choice`, no `stepKey`/`purpose`, and `max_tokens` = request. `maxRetries: 0` is honored (a 500 produces exactly one fetch call). Response id is captured from `message_start` before completion; request id from the header. `refusal` → `refused`. `max_tokens` → `truncated`. `*-midstream-error.sse` → unknown / `responded_partial`. The abort signal stops the stream. A throwing `onResponseId` / `onProgress` hook does not change the result. `estimate` with `apiKey` calls `countTokens` (`provider_count`); without it, or when the count fails, `local_estimate` |
| `openai.test.ts` | Same approach with `src/__fixtures__/openai/*.sse`. `store: true` and strict schema are present; `metadata` has only `relay_attempt_id` / `relay_run_id`. `response.created` id captured. `incomplete/max_output_tokens` → `truncated`. `*-midstream-error.sse` → unknown / `responded_partial`. `reconcile` status mapping |
| `fake.test.ts` | Every script result kind and every `FAKE_SCENARIOS` entry behaves as documented (matching, `times`, fallthrough). `onResponseId` is called with `fake_resp_<attemptId>` for every kind. The call log entry has all `FakeCall` fields. `crash_process_after_dispatch`: the JSONL line is on disk **before** the injected `exit` spy is called with 137. `reconcile` answers the scripted sequence, also from a fresh provider instance reading the same JSONL log. `capabilityOverrides` (scenario + option) are merged. `hang` resolves only on abort. Uses injected timers only |
| `registry.test.ts` | Fake mode returns a fake adapter per provider id reporting the real id; unknown `fakeScenario` throws; `callLog` and `fakeCapabilityOverrides` are passed through; live mode ignores fake options |
| `catalog.test.ts` | `loadCatalogEntries()` parses every statically imported catalog file with the contracts schema. Entries are unique per version. Every entry's `source` starts with `https://` and has ISO `sourceRetrievedAt` and `effectiveDate`; non-fake sources are official provider pricing URLs. Prices are integers. Every fake fixture in `FAKE_FIXTURES` parses with its contracts output schema |

## Success Criteria (gate)
- [ ] `pnpm typecheck && pnpm test:unit packages/providers --coverage --coverage.include='packages/providers/src/**'` → green, ≥ 85% lines
- [ ] `pnpm lint` → exit 0 (SDK imports confined to this package)
- [ ] `grep -rn "maxRetries: 0" packages/providers/src/{anthropic,openai}.ts | wc -l` → 2
- [ ] `grep -rn "thinking" packages/providers/src/anthropic.ts` shows no request field set (comment only)
- [ ] `grep -rlE "readFile|readdir|existsSync" packages/providers/src --include=*.ts --exclude=*.test.ts --exclude=call-log.ts` → no matches (catalog and fixtures are static imports; `call-log.ts`, which reads back its own JSONL log in `entries()`, is the only file allowed to touch the fs)
- [ ] `grep -rn "globalThis.fetch" packages/providers/src` → only call-time reads inside adapter factories (no module-level capture)
- [ ] `grep -rn "seedCatalog" packages/` → no matches
- [ ] Manual (before M2 sign-off): `RELAY_LIVE_TESTS=1 pnpm test:live` → green; printed connection-smoke total ≤ $0.10 and workflow total ≤ $1.50 (D9b)

## Review Checklist
- [ ] No provider SDK type appears in any exported signature
- [ ] `ProviderId`, `ModelCapabilities`, `ModelPrices`, `CatalogEntry` are imported from `@relay/contracts`; no local redefinitions
- [ ] Every `generate` path sets `phase` correctly, including `responded_partial` (review `trackedFetch` and its cause-code list)
- [ ] 529 is checked before `InternalServerError`; no mid-stream failure maps to `PROVIDER_UNAVAILABLE`
- [ ] Every hook invocation goes through `safeHook`
- [ ] Real adapters send only `attemptId` / `runId` metadata
- [ ] No API key in any log statement, error detail, or thrown message (grep `apiKey` usages)
- [ ] Every non-fake catalog entry has an official `https://` source and a retrieval date; Anthropic prices were re-verified at D2; none are invented
- [ ] Fake mode cannot activate in packaged builds without `RELAY_E2E=1`
- [ ] Crash step writes the call-log line synchronously before exiting
