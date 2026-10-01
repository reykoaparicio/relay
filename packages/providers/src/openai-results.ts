// 04 §D5: OpenAI Responses API terminal payload → ModelResult / ReconciliationResult. Structural views only; SDK
// objects never leave the openai modules (§8.3).
import OpenAI from 'openai';
import type { Clock } from '@relay/contracts';
import { optionalIds, successResult } from './adapter-kit.js';
import { mapProviderError, sdkErrorClasses } from './errors.js';
import { tryParseJson } from './json.js';
import type { DispatchTracker } from './tracked-fetch.js';
import type { ModelResult, ReconciliationResult } from './types.js';
import { normalizeOpenAIUsage } from './usage.js';
import type { OpenAIUsageLike } from './usage.js';

/** The D3 chain's classes, from the OpenAI client statics. */
export const OPENAI_ERRORS = sdkErrorClasses(OpenAI);

/**
 * The only service tier Relay requests: the catalog prices are the standard (`default`) tier. `auto` would let a project
 * setting route calls to flex/priority/scale tiers at different prices; the response echoes the tier actually used.
 */
export const OPENAI_SERVICE_TIER = 'default' as const;

/** Whether a response's reported `service_tier` means it was billed at other than the standard (catalog) prices. */
export function isPriceTierMismatch(serviceTier: string | null | undefined): boolean {
  // Absent: the tier was not reported (the request asked for `default`); only an explicit other tier is a mismatch.
  return serviceTier != null && serviceTier !== OPENAI_SERVICE_TIER;
}

interface ContentLike {
  readonly type: string;
  readonly text?: string;
  readonly refusal?: string;
}
interface OutputItemLike {
  readonly type: string;
  readonly content?: readonly ContentLike[] | null;
}
/** Structural view of an SDK `Response` (a terminal stream payload or a `responses.retrieve` answer). */
export interface ResponseLike {
  readonly id: string;
  readonly status?: string | null;
  readonly output?: readonly OutputItemLike[] | null;
  readonly usage?: OpenAIUsageLike | null;
  readonly incomplete_details?: { readonly reason?: string | null } | null;
  readonly error?: unknown;
  readonly service_tier?: string | null;
}

function messageContents(resp: ResponseLike): ContentLike[] {
  return (resp.output ?? []).filter((o) => o.type === 'message').flatMap((o) => [...(o.content ?? [])]);
}

/** Concatenated `output_text` of every message item. */
export function outputText(resp: ResponseLike): string {
  return messageContents(resp)
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text ?? '')
    .join('');
}

function hasRefusal(resp: ResponseLike): boolean {
  return messageContents(resp).some((c) => c.type === 'refusal');
}

/** What {@link toResult} needs about the call besides the terminal payload. */
export interface CallFacts {
  readonly tracker: DispatchTracker;
  readonly clock: Clock;
  readonly aborted: boolean;
  /** The SDK's `_request_id` of the final response (the tracker's header wins when both exist). */
  readonly sdkRequestId?: string | null | undefined;
}

/** D3 row 2: a terminal `response.failed`, or a stream that ended without a terminal status, after the first byte. */
export function unknownOutcome(resp: ResponseLike, call: CallFacts): ModelResult {
  const status = resp.status ?? 'none';
  const body = resp.error ?? { status };
  const partialUsage = resp.usage == null ? undefined : normalizeOpenAIUsage(resp.usage);
  return mapProviderError(new OpenAI.APIError(undefined, body, `response ${status}`, undefined), {
    providerId: 'openai',
    tracker: call.tracker,
    classes: OPENAI_ERRORS,
    clock: call.clock,
    aborted: call.aborted,
    providerResponseId: resp.id,
    ...(partialUsage === undefined ? {} : { partialUsage }),
  });
}

/** The terminal payload of a `generate` stream → ModelResult (completed / incomplete; anything else is unknown). */
export function toResult(resp: ResponseLike, call: CallFacts): ModelResult {
  const usage = normalizeOpenAIUsage(resp.usage);
  const extra = {
    rawUsage: resp.usage ?? null,
    ...optionalIds({ providerResponseId: resp.id, providerRequestId: call.tracker.requestId ?? call.sdkRequestId ?? undefined }),
    // A terminal response without `usage` must not read as a known $0 (the zeros above are placeholders).
    ...(resp.usage == null ? { usageKnown: false } : {}),
    ...(isPriceTierMismatch(resp.service_tier) ? { priceTierMismatch: true } : {}),
  };
  const rawText = outputText(resp);
  if (resp.status === 'completed') {
    if (hasRefusal(resp)) return { kind: 'refused', category: 'refusal', usage, ...extra };
    return successResult(call.tracker, call.clock.now(), { json: tryParseJson(rawText), rawText, usage }, extra);
  }
  if (resp.status === 'incomplete') {
    const reason = resp.incomplete_details?.reason ?? 'unknown';
    if (reason === 'content_filter') return { kind: 'refused', category: 'content_filter', usage, ...extra };
    if (reason === 'max_output_tokens') return { kind: 'truncated', rawText, usage, ...extra };
    return { kind: 'truncated', rawText, usage, rawStopReason: `incomplete:${reason}`, ...extra };
  }
  return unknownOutcome(resp, call); // failed / cancelled / in_progress / queued / missing
}

/** A `responses.retrieve` answer → ReconciliationResult (§7.5). */
export function reconcileResult(resp: ResponseLike): ReconciliationResult {
  const usage = resp.usage == null ? undefined : normalizeOpenAIUsage(resp.usage);
  // `usageKnown: false` keeps the liability: a missing usage block is NOT a known $0 (04 §D5).
  const usageKnown = usage !== undefined;
  switch (resp.status ?? 'missing') {
    case 'completed':
      return {
        kind: 'completed',
        json: tryParseJson(outputText(resp)),
        usage: usage ?? normalizeOpenAIUsage(null),
        rawUsage: resp.usage ?? null,
        usageKnown,
      };
    case 'queued':
    case 'in_progress':
      return { kind: 'in_progress' };
    default:
      // failed / cancelled / incomplete / missing: no usable output; the usage (if any) settles the liability,
      // otherwise the engine keeps it (usageKnown: false), since the provider may still have billed the call.
      return usage === undefined ? { kind: 'failed', usageKnown } : { kind: 'failed', usage, usageKnown };
  }
}
