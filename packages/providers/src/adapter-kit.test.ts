import { describe, expect, it, vi } from 'vitest';
import { epochMs } from '@relay/contracts';
import { emitProgress, emitResponseId, errorNameOf, guardListener, optionalIds, progressTokens, successResult } from './adapter-kit.js';
import { tryParseJson } from './json.js';
import type { DispatchTracker } from './tracked-fetch.js';
import type { GenerateContext } from './types.js';

const USAGE = { uncachedInputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2 };

describe('adapter-kit', () => {
  it('optionalIds keeps only defined ids', () => {
    expect(optionalIds({ providerResponseId: 'r', providerRequestId: undefined })).toEqual({ providerResponseId: 'r' });
    expect(optionalIds({})).toEqual({});
  });

  it('a throwing hook or listener never escapes; only the error name is logged', () => {
    const warn = vi.fn();
    const onProgress = vi.fn();
    const ctx: GenerateContext = {
      apiKey: 'k',
      signal: new AbortController().signal,
      hooks: {
        onResponseId: () => {
          throw new RangeError('hook bug with secret sk-xyz');
        },
        onProgress,
      },
    };

    emitResponseId(ctx, { warn }, 'resp_1', undefined);
    emitProgress(ctx, { warn }, { now: () => epochMs(15) }, 10, progressTokens(9));
    guardListener({ warn }, () => {
      throw new TypeError('listener bug');
    })();

    expect(onProgress).toHaveBeenCalledWith({ outputTokensSoFar: 3, elapsedMs: 5 });
    expect(warn).toHaveBeenCalledWith('provider.hook_failed', { hook: 'onResponseId', errorName: 'RangeError' });
    expect(warn).toHaveBeenCalledWith('provider.stream_listener_failed', { errorName: 'TypeError' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-xyz');
  });

  it('successResult measures latency from dispatch and first byte when known', () => {
    const tracker = { dispatchedAt: 100, firstByteAt: 130 } as DispatchTracker;

    const r = successResult(tracker, 200, { json: { a: 1 }, rawText: '{"a":1}', usage: USAGE }, { rawUsage: null });
    const noDispatch = successResult({} as DispatchTracker, 200, { json: undefined, rawText: 'x', usage: USAGE }, { rawUsage: null });

    expect(r).toMatchObject({ kind: 'success', stopReason: 'end_turn', latencyMs: 100, firstByteMs: 30 });
    expect(noDispatch.latencyMs).toBe(0);
    expect('firstByteMs' in noDispatch).toBe(false);
  });

  it('errorNameOf and tryParseJson', () => {
    expect(errorNameOf(new SyntaxError('x'))).toBe('SyntaxError');
    expect(errorNameOf('boom')).toBe('string');
    expect(tryParseJson('{"ok":true}')).toEqual({ ok: true });
    expect(tryParseJson('{nope')).toBeUndefined();
  });
});
