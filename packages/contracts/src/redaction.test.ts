import { describe, expect, it } from 'vitest';
import { looksLikeSecret, redactDeep, redactedLabel, redactString, SECRET_PATTERNS, toDisplayPath } from './redaction.js';

// Built by concatenation so repository secret scanners do not flag these obviously fake fixtures.
const SK = 'sk-';
const ANTHROPIC = `${SK}ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_a1F9`;
const ANTHROPIC_ADMIN = `${SK}ant-admin01-ZZZZZZZZZZZZZZZZZZZZb2G8`;
const ANTHROPIC_OTHER = `${SK}ant-XXXXXXXXXXXXc3H7`;
const OPENAI_PROJECT = `${SK}proj-abcdefghijklmnopqrstuvwxyzd4J6`;
const OPENAI_SVC = `${SK}svcacct-abcdefghijklmnopqrstuvwxyze5K5`;
const GENERIC = `${SK}abcdefghijklmnopqrstf6L4`;

describe('redactString', () => {
  it.each([
    ['anthropic api', ANTHROPIC, '[REDACTED:sk-…a1F9]'],
    ['anthropic admin', ANTHROPIC_ADMIN, '[REDACTED:sk-…b2G8]'],
    ['anthropic other', ANTHROPIC_OTHER, '[REDACTED:sk-…c3H7]'],
    ['openai project', OPENAI_PROJECT, '[REDACTED:sk-…d4J6]'],
    ['openai service account', OPENAI_SVC, '[REDACTED:sk-…e5K5]'],
    ['generic sk', GENERIC, '[REDACTED:sk-…f6L4]'],
  ])('redacts %s keys, keeping the last 4 chars', (_name, key, expected) => {
    expect(redactString(`key=${key} end`)).not.toContain(key);
    expect(redactString(`before ${key} after`)).toBe(`before ${expected} after`);
  });

  it('redacts Bearer tokens, key/value secrets, private keys, and AWS access keys', () => {
    const bearer = redactString('Authorization: Bearer abcdefghijklmnop1234');
    const kv = redactString('{"api_key": "abcdefgh12345678"}');
    const pem = redactString('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----');
    const aws = redactString(['id AKIA', 'ABCDEFGHIJKLMNOP'].join(''));

    expect(bearer).toBe('Authorization: Bearer [REDACTED:…1234]');
    expect(kv).toBe('{"api_key": "[REDACTED:…5678]"}');
    expect(pem).toBe('[REDACTED:private-key]');
    expect(aws).toBe('id [REDACTED:AKIA…MNOP]');
  });

  it('does not redact words that merely contain sk-', () => {
    for (const word of ['risk-assessment-module-x', 'task-management-service-v2', 'desk-organizer-application']) {
      expect(redactString(word)).toBe(word);
      expect(looksLikeSecret(word)).toBe(false);
    }
  });

  it('does not flag a 40-char git SHA', () => {
    const sha = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';

    expect(redactString(`commit ${sha}`)).toBe(`commit ${sha}`);
    expect(looksLikeSecret(sha)).toBe(false);
  });

  it('is idempotent', () => {
    const text = `a ${ANTHROPIC} b Bearer abcdefghijklmnop c api_key=${OPENAI_PROJECT} d x-api-key: zzzzzzzzzzzz`;

    const once = redactString(text);

    expect(redactString(once)).toBe(once);
    expect(once).not.toContain('zzzzzzzzzzzz');
  });

  it('keeps every sk- pattern anchored with the lookbehind', () => {
    const skPatterns = SECRET_PATTERNS.filter((p) => p.source.includes('sk-'));

    expect(skPatterns).toHaveLength(5);
    for (const p of skPatterns) expect(p.source.startsWith('(?<![A-Za-z0-9])')).toBe(true);
  });
});

describe('redactedLabel', () => {
  it('shows only the prefix and last 4 chars', () => {
    expect(redactedLabel(ANTHROPIC)).toBe('sk-…a1F9');
    expect(redactedLabel('  AIzaSyExampleKeyWXYZ ')).toBe('…WXYZ');
    expect(redactedLabel('short')).toBe('…');
  });
});

describe('looksLikeSecret', () => {
  it('detects keys inside prose and is stable across calls', () => {
    const text = `please remember ${ANTHROPIC}`;

    expect(looksLikeSecret(text)).toBe(true);
    expect(looksLikeSecret(text)).toBe(true);
    expect(looksLikeSecret('use pnpm, never npm')).toBe(false);
  });
});

describe('redactDeep', () => {
  it('removes apiKey, authorization, headers, and content at any depth and redacts strings', () => {
    const input = {
      apiKey: 'x',
      nested: [{ API_KEY: 'y', Authorization: 'z', headers: { a: 1 }, note: `leak ${GENERIC}`, ok: 1 }],
      deeper: { a: { 'x-api-key': 'k', content: 'model text', keep: true } },
      n: null,
      count: 3,
    };

    const out = redactDeep(input);

    expect(out).toEqual({
      nested: [{ note: 'leak [REDACTED:sk-…f6L4]', ok: 1 }],
      deeper: { a: { keep: true } },
      n: null,
      count: 3,
    });
    expect(input.apiKey).toBe('x');
  });

  it('lets callers replace the optional drop keys but never the mandatory ones', () => {
    const out = redactDeep({ content: 'kept', usage: 1, apiKey: 'gone' }, { dropKeys: ['usage'] });

    expect(out).toEqual({ content: 'kept' });
  });

  it('handles errors and cycles', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;

    const out = redactDeep({ err: new Error(`bad ${GENERIC}`), cyclic });

    expect(out).toEqual({
      err: { name: 'Error', message: 'bad [REDACTED:sk-…f6L4]' },
      cyclic: { a: 1, self: '[Circular]' },
    });
  });
});

describe('toDisplayPath', () => {
  it('replaces the home prefix with ~', () => {
    expect(toDisplayPath('/Users/me/code/x', '/Users/me')).toBe('~/code/x');
    expect(toDisplayPath('/Users/me/code/x', '/Users/me/')).toBe('~/code/x');
    expect(toDisplayPath('/Users/me', '/Users/me')).toBe('~');
    expect(toDisplayPath('/Users/meow/x', '/Users/me')).toBe('/Users/meow/x');
    expect(toDisplayPath('/opt/x', '/')).toBe('/opt/x');
  });
});
