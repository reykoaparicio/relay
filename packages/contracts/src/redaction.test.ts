import { describe, expect, it } from 'vitest';
import {
  looksLikeSecret,
  redactDeep,
  redactedLabel,
  redactString,
  SECRET_PATTERNS,
  toDisplayPath,
} from './redaction.js';

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
    for (const word of [
      'risk-assessment-module-x',
      'task-management-service-v2',
      'desk-organizer-application',
    ]) {
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
    // Specific prefixes may also follow a `\n`/`\t`/`\r` or `%XX` escape (audit F3); the generic rule may not.
    const escBoundary = String.raw`(?:(?<![A-Za-z0-9])|(?<=\\[nrt]|%[0-9A-Fa-f]{2}))`;
    const generic = skPatterns.filter((p) => p.source.startsWith('(?<![A-Za-z0-9])sk-['));

    expect(skPatterns).toHaveLength(5);
    expect(generic).toHaveLength(1);
    for (const p of skPatterns) {
      expect(p.source.startsWith('(?<![A-Za-z0-9])') || p.source.startsWith(escBoundary)).toBe(true);
    }
  });
});

// Referee regression fixtures (built by concatenation so secret scanners do not flag them).
const GH_PAT = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
const GH_OAUTH = ['gh', 'o_', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('');
const GH_SERVER = ['gh', 's_', 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8'].join('');
const GH_FINE = ['github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'].join('');
const GEMINI = ['AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'].join('');

describe('redactString: Authorization credentials (B1)', () => {
  it.each([
    ['Basic', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    ['token', `Authorization: token ${GH_PAT}`, GH_PAT],
    ['Token', `authorization: Token ${GH_PAT}`, GH_PAT],
    ['Bearer with + / =', 'Authorization: Bearer abc+def/ghi==', 'abc+def/ghi=='],
    ['raw value', 'Authorization: a1b2c3d4e5f6g7h8i9j0', 'a1b2c3d4e5f6g7h8i9j0'],
    ['JSON header', '{"Authorization":"Basic dXNlcjpwYXNzd29yZA=="}', 'dXNlcjpwYXNzd29yZA=='],
  ])('redacts the whole %s credential after an Authorization key', (_name, text, credential) => {
    const out = redactString(text);

    expect(out).not.toContain(credential);
    expect(out).not.toContain(credential.slice(0, 6));
    expect(out).toContain('[REDACTED:');
    expect(looksLikeSecret(text)).toBe(true);
  });

  it('redacts a Bearer token containing + / = without leaking a suffix', () => {
    const token = 'ya29.a0AfH6SMBx1234+abc/def==';

    const out = redactString(`Bearer ${token} done`);

    expect(out).toBe('Bearer [REDACTED:…ef==] done');
    expect(out).not.toContain('+abc/def');
  });

  it.each([
    ['ghp_', GH_PAT],
    ['gho_', GH_OAUTH],
    ['ghs_', GH_SERVER],
    ['github_pat_', GH_FINE],
  ])('redacts GitHub %s tokens in prose', (_name, token) => {
    const out = redactString(`push with ${token} now`);

    expect(out).toBe(`push with [REDACTED:…${token.slice(-4)}] now`);
    expect(looksLikeSecret(token)).toBe(true);
  });

  it('is idempotent on redacted Authorization values', () => {
    const once = redactString(`Authorization: Basic dXNlcjpwYXNzd29yZA== and Authorization: token ${GH_PAT}`);

    expect(redactString(once)).toBe(once);
  });
});

describe('redactString: Gemini keys (B2)', () => {
  it('redacts AIza keys and long key= query params', () => {
    const header = redactString(`x-goog-api-key ${GEMINI}`);
    const url = redactString('https://g.example/v1beta/models?alt=sse&key=abcdefghijklmnopqrstuv12&x=1');

    expect(header).toBe(`x-goog-api-key [REDACTED:…${GEMINI.slice(-4)}]`);
    expect(url).toBe('https://g.example/v1beta/models?alt=sse&key=[REDACTED:…uv12]&x=1');
    expect(looksLikeSecret(GEMINI)).toBe(true);
  });

  it('leaves short key= query params alone', () => {
    expect(redactString('/list?key=short&page=2')).toBe('/list?key=short&page=2');
  });
});

describe('redactString: escaped JSON (B3)', () => {
  it('redacts key/value secrets inside backslash-escaped JSON', () => {
    const text = String.raw`{\"apiKey\":\"abcd1234efgh5678\"}`;

    const out = redactString(text);

    expect(out).toBe(String.raw`{\"apiKey\":\"[REDACTED:…5678]\"}`);
    expect(looksLikeSecret(text)).toBe(true);
    expect(redactString(String.raw`{\"authorization\":\"a1b2c3d4e5f6g7h8i9j0\"}`)).toBe(
      String.raw`{\"authorization\":\"[REDACTED:…i9j0]\"}`,
    );
  });
});

describe('redactString: keys after \\n / \\t / \\r escapes and %XX URL encodings (audit F3)', () => {
  const OPENAI_PROJ_LONG = `${SK}proj-AbCdEf0123456789_-ghIJklMNopQRstUV`;

  it.each([
    ['JSON \\n before an Anthropic key', JSON.stringify({ error: { message: `Key rejected:\n${ANTHROPIC}` } }), ANTHROPIC],
    ['JSON \\n before a Gemini key', JSON.stringify({ text: `config:\n${GEMINI}` }), GEMINI],
    ['JSON \\t before an OpenAI project key', JSON.stringify({ t: `k\t${OPENAI_PROJ_LONG}` }), OPENAI_PROJ_LONG],
    ['JSON \\r before an OpenAI service-account key', JSON.stringify({ t: `x\r${OPENAI_SVC}` }), OPENAI_SVC],
    ['JSON \\n before an Anthropic admin key', JSON.stringify({ t: `x\n${ANTHROPIC_ADMIN}` }), ANTHROPIC_ADMIN],
    ['JSON \\n before another Anthropic key', JSON.stringify({ t: `x\n${ANTHROPIC_OTHER}` }), ANTHROPIC_OTHER],
    ['JSON \\n before a GitHub token', JSON.stringify({ t: `token:\n${GH_PAT}` }), GH_PAT],
    ['JSON \\t before a fine-grained GitHub token', JSON.stringify({ t: `t\t${GH_FINE}` }), GH_FINE],
    ['NDJSON in stderr', String.raw`{"level":"error","msg":"auth\n` + `${GEMINI}"}`, GEMINI],
    ['URL-encoded JSON (%22)', `payload=%7B%22apiKey%22%3A%22${ANTHROPIC}%22%7D`, ANTHROPIC],
    ['URL-encoded JSON, lowercase hex', `p=%7b%22k%22%3a%22${OPENAI_PROJECT}%22%7d`, OPENAI_PROJECT],
    ['URL-encoded space before a GitHub token', `q=token%20${GH_SERVER}`, GH_SERVER],
    ['URL-encoded colon before a Gemini key', `q=k%3A${GEMINI}`, GEMINI],
  ])('redacts and detects: %s', (_name, text, key) => {
    const out = redactString(text);

    expect(out).not.toContain(key);
    expect(out).toContain(`[REDACTED:`);
    expect(out).toContain(`${key.startsWith(SK) ? SK : ''}…${key.slice(-4)}]`);
    expect(redactString(out)).toBe(out);
    expect(looksLikeSecret(text)).toBe(true);
  });

  it('keeps the surrounding escape sequence intact', () => {
    expect(redactString(`"a\\n${ANTHROPIC}"`)).toBe('"a\\n[REDACTED:sk-…a1F9]"');
    expect(redactString(`%22${GEMINI}%22`)).toBe(`%22[REDACTED:…${GEMINI.slice(-4)}]%22`);
  });

  it.each([
    // The generic sk- rule keeps its plain left boundary: a letter/digit before it still blocks it, escape or not.
    ['generic sk- after %2D', `x%2D${GENERIC}`],
    ['generic sk- after \\n', `x\\n${GENERIC}`],
    ['generic sk- after \\t', `x\\t${GENERIC}`],
    // Specific prefixes inside words (no escape before the letter) are still not keys.
    ['Anthropic prefix inside a word', `task${ANTHROPIC}`],
    ['Gemini prefix inside a word', `m${GEMINI}`],
    ['GitHub prefix inside a word', `x${GH_PAT}`],
    // A backslash before some other letter, or a partial %X escape, is not an escape boundary.
    ['backslash-x before a key', `\\x${OPENAI_PROJECT}`],
    ['backslash-b before a key', `\\b${GH_PAT}`],
    ['single hex digit after %', `%2${ANTHROPIC}`],
    ['non-hex %XX', `%2G${GEMINI}`],
  ])('does not redact: %s', (_name, text) => {
    expect(redactString(text)).toBe(text);
  });
});

describe('looksLikeSecret / redactString false positives (B4)', () => {
  it.each([
    'Use the Bearer authentication scheme for all endpoints',
    'The authorization: middleware checks roles',
    'Use Authorization=deny-by-default for admin routes',
    'Always read apiKey: fromVault() never from env',
    'const authorization = getAuthorizationHeader(req);',
  ])('neither flags nor rewrites %j', (text) => {
    expect(looksLikeSecret(text)).toBe(false);
    expect(redactString(text)).toBe(text);
  });

  it('still flags credential-shaped key/value secrets', () => {
    expect(looksLikeSecret('api_key=abcd1234efgh5678')).toBe(true);
    expect(looksLikeSecret('Authorization: Bearer abcdefghijklmnop1234')).toBe(true);
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

  it('keeps shared non-cyclic references instead of marking them [Circular] (B5)', () => {
    const shared = { note: 'same' };

    const out = redactDeep({ a: shared, b: shared, list: [shared, shared] });

    expect(out).toEqual({
      a: { note: 'same' },
      b: { note: 'same' },
      list: [{ note: 'same' }, { note: 'same' }],
    });
  });

  it('serializes Date, Map, Set, and binary values readably (B6)', () => {
    const input = {
      at: new Date(Date.UTC(2026, 8, 30, 12, 0, 0)),
      bad: new Date(Number.NaN),
      map: new Map<string, unknown>([
        ['model', 'gpt'],
        ['apiKey', 'dropped'],
        ['note', `leak ${GENERIC}`],
      ]),
      objectKeys: new Map<unknown, unknown>([[{ id: 1 }, 'v']]),
      set: new Set(['x', `k ${GENERIC}`]),
      bytes: new Uint8Array([1, 2, 3]),
      buf: new ArrayBuffer(8),
      view: new DataView(new ArrayBuffer(4)),
    };

    const out = redactDeep(input);

    expect(out).toEqual({
      at: '2026-09-30T12:00:00.000Z',
      bad: 'Invalid Date',
      map: { model: 'gpt', note: 'leak [REDACTED:sk-…f6L4]' },
      objectKeys: [[{ id: 1 }, 'v']],
      set: ['x', 'k [REDACTED:sk-…f6L4]'],
      bytes: '[binary 3 bytes]',
      buf: '[binary 8 bytes]',
      view: '[binary 4 bytes]',
    });
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
