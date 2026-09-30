import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { localTokenEstimate, promptChars } from './estimate.js';
import { ZERO_USAGE, normalizeAnthropicUsage, normalizeOpenAIUsage } from './usage.js';

describe('normalizeAnthropicUsage', () => {
  it('keeps input_tokens as uncached because Anthropic already excludes cache reads and writes', () => {
    const u = normalizeAnthropicUsage({
      input_tokens: 1000,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 200,
      output_tokens: 300,
    });

    expect(u).toEqual({ uncachedInputTokens: 1000, cacheReadInputTokens: 500, cacheWriteInputTokens: 200, outputTokens: 300 });
  });

  it('reports thinking tokens as an informational subset of output, not an extra category', () => {
    const u = normalizeAnthropicUsage({ input_tokens: 10, output_tokens: 300, output_tokens_details: { thinking_tokens: 200 } });

    expect(u.outputTokens).toBe(300);
    expect(u.reasoningTokens).toBe(200);
  });

  it('treats null / missing counters as 0', () => {
    expect(normalizeAnthropicUsage({ input_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: null })).toEqual({
      uncachedInputTokens: 5,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
    });
    expect(normalizeAnthropicUsage(undefined)).toEqual(ZERO_USAGE);
  });
});

describe('normalizeOpenAIUsage', () => {
  it('subtracts cached and cache-write tokens because OpenAI input_tokens includes them (1700 → 1000, not 1700)', () => {
    const u = normalizeOpenAIUsage({
      input_tokens: 1700,
      input_tokens_details: { cached_tokens: 500, cache_write_tokens: 200 },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 120 },
    });

    expect(u).toEqual({
      uncachedInputTokens: 1000,
      cacheReadInputTokens: 500,
      cacheWriteInputTokens: 200,
      outputTokens: 300,
      reasoningTokens: 120,
    });
  });

  it('never double-counts reasoning: output_tokens already includes it', () => {
    const u = normalizeOpenAIUsage({ input_tokens: 10, output_tokens: 300, output_tokens_details: { reasoning_tokens: 300 } });

    expect(u.outputTokens).toBe(300);
  });

  it('never produces negative uncached input', () => {
    expect(normalizeOpenAIUsage({ input_tokens: 10, input_tokens_details: { cached_tokens: 50 } }).uncachedInputTokens).toBe(0);
    expect(normalizeOpenAIUsage(null)).toEqual(ZERO_USAGE);
  });
});

/** The usage block of the terminal `response.completed` event of an OpenAI SSE fixture. */
function openAIFixtureUsage(name: string): Parameters<typeof normalizeOpenAIUsage>[0] {
  const text = readFileSync(new URL(`./__fixtures__/openai/${name}.sse`, import.meta.url), 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('data: {"type":"response.completed"'));
  if (line === undefined) throw new Error(`no response.completed in ${name}`);
  return (JSON.parse(line.slice('data: '.length)) as { response: { usage: Parameters<typeof normalizeOpenAIUsage>[0] } }).response.usage;
}

describe('double-count trap: the same token split through both providers', () => {
  it('OpenAI cache-usage fixture (input_tokens 1700 incl. 500 cached + 200 written) → uncached 1000', () => {
    const raw = openAIFixtureUsage('cache-usage');

    expect(raw?.input_tokens).toBe(1700);
    expect(normalizeOpenAIUsage(raw)).toEqual({ uncachedInputTokens: 1000, cacheReadInputTokens: 500, cacheWriteInputTokens: 200, outputTokens: 180, reasoningTokens: 120 });
  });

  it('Anthropic reports the same split with input_tokens 1000 (already excluding cache) → uncached 1000', () => {
    const a = normalizeAnthropicUsage({ input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 200, output_tokens: 180 });
    const o = normalizeOpenAIUsage(openAIFixtureUsage('cache-usage'));

    expect([a.uncachedInputTokens, a.cacheReadInputTokens, a.cacheWriteInputTokens]).toEqual([o.uncachedInputTokens, o.cacheReadInputTokens, o.cacheWriteInputTokens]);
  });

  it('OpenAI success fixture without cache: uncached = input_tokens; reasoning stays inside output', () => {
    expect(normalizeOpenAIUsage(openAIFixtureUsage('success'))).toEqual({ uncachedInputTokens: 1000, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 180, reasoningTokens: 120 });
  });
});

describe('local token estimate', () => {
  it('is ceil(chars / 3.2 × 1.15) computed exactly', () => {
    expect(localTokenEstimate(0)).toBe(0);
    expect(localTokenEstimate(64)).toBe(23);
    expect(localTokenEstimate(3200)).toBe(Math.ceil((3200 / 3.2) * 1.15));
    expect(localTokenEstimate(1)).toBe(1);
  });

  it('counts system and every message', () => {
    expect(promptChars({ system: 'abc', messages: [{ role: 'user', content: 'de' }] })).toBe(5);
  });
});
