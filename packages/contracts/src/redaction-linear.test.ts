import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { looksLikeSecret, redactString } from './redaction.js';

// Regression for catastrophic backtracking (impr review item 1): lookahead-based value patterns made redactString /
// looksLikeSecret quadratic on adversarial text such as provider error bodies. The new rules check value shape after
// the match; this file pins (a) linear time on adversarial input and (b) output identical to the old implementation.

const KB256 = 256 * 1024;
const BUDGET_MS = 100;

const fill = (unit: string, tail = ''): string => unit.repeat(Math.ceil(KB256 / unit.length)).slice(0, KB256) + tail;

/** One adversarial input per rule family, each built to re-trigger the old backtracking at every start position. */
const ADVERSARIAL: readonly (readonly [string, string])[] = [
  ['authorization= run', fill('authorization=')],
  ['authorization: run', fill('authorization: ')],
  ['quoted authorization run', fill('authorization:"')],
  ['authorization + letters-only value', fill(`authorization:${'a'.repeat(200)}`)],
  ['authorization scheme without value', fill('authorization: bearer ')],
  ['api_key= run', fill('api_key=')],
  ['api_key= run ending in a call', fill('api_key=', '(')],
  ['x-api-key values ending in calls', fill(`x-api-key: ${'A'.repeat(100)}(`)],
  ['unterminated PEM blocks', fill('-----BEGIN RSA PRIVATE KEY-----\n')],
  ['PEM blocks with non-matching END lines', fill('-----BEGIN RSA PRIVATE KEY-----\n-----END RSA PUBLIC KEY-----\n')],
  ['Bearer run', fill('Bearer ')],
  ['short Bearer values', fill(`Bearer ${'a'.repeat(15)} `)],
  ['?key= run', fill('&key=')],
  ['sk- prefixes', fill('sk-')],
  ['short sk- tokens', fill('sk-abc ')],
  ['GitHub prefixes', fill('ghp_')],
  ['Google prefixes', fill('AIza')],
  ['AWS prefixes', fill('AKIA')],
  ['credential alphabet', fill('abcdefgh1234/+=')],
];

function elapsedMs(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('redaction runs in linear time on adversarial input', () => {
  it.each(ADVERSARIAL)('redactString handles 256 KB of %s in < 100 ms', (_name, input) => {
    redactString(input.slice(0, 1024)); // warm up the regex compiler

    const ms = elapsedMs(() => redactString(input));

    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it.each(ADVERSARIAL)('looksLikeSecret handles 256 KB of %s in < 100 ms', (_name, input) => {
    looksLikeSecret(input.slice(0, 1024));

    const ms = elapsedMs(() => looksLikeSecret(input));

    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Oracle: the previous (lookahead-based) implementation, verbatim except for being collapsed into one function.
// Kept here only; it is quadratic on long adversarial input, so it is fed short strings.

const OLD_NB = '(?<![A-Za-z0-9])';
const OLD_Q = `(?:\\\\?["'])?`;
const OLD_CRED = 'A-Za-z0-9_\\-+/=.~';
const OLD_CREDENTIAL_VALUE = `(?!\\[REDACTED)(?=[${OLD_CRED}]*\\d)(?=[${OLD_CRED}]*[A-Za-z])[${OLD_CRED}]{16,}(?![${OLD_CRED}(])`;
const OLD_LOOSE_VALUE = `(?!\\[REDACTED)[^\\s"'\\\\,;{}()\\[\\]<>]{8,}(?![^\\s"'\\\\,;{}\\[\\]<>)])`;
const OLD_API_KEY_NAME = `(?<keep>(?:api[_-]?key|x-api-key)${OLD_Q}\\s*[:=]\\s*${OLD_Q})`;
const OLD_AUTHZ_NAME = `\\bauthorization${OLD_Q}\\s*[:=]\\s*${OLD_Q}`;

type OldKind = 'sk' | 'akia' | 'pem' | 'plain';
interface OldRule {
  readonly re: RegExp;
  readonly label: OldKind;
  readonly redact?: boolean;
  readonly detect?: boolean;
}

const OLD_RULES: readonly OldRule[] = [
  { re: new RegExp(`${OLD_NB}sk-ant-(?:api|admin)\\d\\d-[A-Za-z0-9_-]{10,}`, 'g'), label: 'sk' },
  { re: new RegExp(`${OLD_NB}sk-ant-[A-Za-z0-9_-]{10,}`, 'g'), label: 'sk' },
  { re: new RegExp(`${OLD_NB}sk-proj-[A-Za-z0-9_-]{16,}`, 'g'), label: 'sk' },
  { re: new RegExp(`${OLD_NB}sk-svcacct-[A-Za-z0-9_-]{16,}`, 'g'), label: 'sk' },
  { re: new RegExp(`${OLD_NB}sk-[A-Za-z0-9_-]{16,}`, 'g'), label: 'sk' },
  { re: new RegExp(`${OLD_NB}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`, 'g'), label: 'plain' },
  { re: new RegExp(`${OLD_NB}AIza[0-9A-Za-z_-]{35}`, 'g'), label: 'plain' },
  { re: /(?<keep>[?&]key=)(?!\[REDACTED)(?<secret>[A-Za-z0-9_\-.~%]{20,})/g, label: 'plain' },
  {
    re: new RegExp(`(?<keep>${OLD_AUTHZ_NAME}(?:basic|bearer|token)\\s+)(?!\\[REDACTED)(?<secret>[${OLD_CRED}]{8,})`, 'gi'),
    label: 'plain',
  },
  { re: new RegExp(`(?<keep>${OLD_AUTHZ_NAME})(?<secret>${OLD_CREDENTIAL_VALUE})`, 'gi'), label: 'plain' },
  { re: new RegExp(`(?<keep>\\bBearer\\s+)(?!\\[REDACTED)(?<secret>[${OLD_CRED}]{16,})`, 'gi'), label: 'plain' },
  { re: new RegExp(`${OLD_API_KEY_NAME}(?<secret>${OLD_LOOSE_VALUE})`, 'gi'), label: 'plain', detect: false },
  { re: new RegExp(`${OLD_API_KEY_NAME}(?<secret>${OLD_CREDENTIAL_VALUE})`, 'gi'), label: 'plain', redact: false },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: 'pem' },
  { re: /AKIA[0-9A-Z]{16}/g, label: 'akia' },
];

function oldTail(secret: string): string {
  return secret.length >= 12 ? secret.slice(-4) : '';
}

function oldLabel(kind: OldKind, secret: string): string {
  if (kind === 'sk') {
    const trimmed = secret.trim();
    return `${trimmed.startsWith('sk-') ? 'sk-' : ''}…${oldTail(trimmed)}`;
  }
  if (kind === 'akia') return `AKIA…${oldTail(secret)}`;
  if (kind === 'pem') return 'private-key';
  return `…${oldTail(secret)}`;
}

function oldRedactString(s: string): string {
  let out = s;
  for (const rule of OLD_RULES.filter((r) => r.redact !== false)) {
    out = out.replace(rule.re, (match: string, ...rest: unknown[]) => {
      const last = rest.at(-1);
      const groups = (typeof last === 'object' && last !== null ? last : {}) as Partial<Record<'keep' | 'secret', string>>;
      const keep = groups.keep ?? '';
      const secret = groups.secret ?? match.slice(keep.length);
      return `${keep}[REDACTED:${oldLabel(rule.label, secret)}]`;
    });
  }
  return out;
}

function oldLooksLikeSecret(text: string): boolean {
  return OLD_RULES.filter((r) => r.detect !== false).some((r) => new RegExp(r.re.source, r.re.flags.replace('g', '')).test(text));
}

// ---------------------------------------------------------------------------------------------------------------

/** Fragments that exercise every rule's prefix, delimiters, value alphabet, and boundary chars. */
const FRAGMENTS = [
  'authorization', 'Authorization', 'AUTHORIZATION', 'api_key', 'api-key', 'apikey', 'apiKey', 'x-api-key', 'X-Api-Key',
  ':', '=', ': ', ' = ', '"', "'", '\\"', ' ', '\t', '\n', '(', ')', ',', ';', '{', '}', '[', ']', '<', '>',
  'bearer ', 'Bearer ', 'basic ', 'token ', 'Token\t',
  'abcdefgh', 'ABCDEFGH', '12345678', 'a1b2c3d4', 'Zz9_', '-', '_', '/', '+', '.', '~', '%', 'x', '7',
  'sk-', 'sk-ant-', 'sk-ant-api03-', 'sk-ant-admin01-', 'sk-proj-', 'sk-svcacct-', 'risk-', 'task-',
  'ghp_', 'gho_', 'github_pat_', 'AIza', '?key=', '&key=', 'AKIA', 'QWERTYUIOPASDFGH',
  '-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----',
  '-----END PRIVATE KEY-----', '-----BEGIN ', 'MIIEvQ', '[REDACTED:…a1F9]', '[REDACTED',
] as const;

const mixed = fc
  .array(fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...FRAGMENTS) }, { weight: 1, arbitrary: fc.string({ maxLength: 4 }) }), {
    maxLength: 24,
  })
  .map((parts) => parts.join(''));

describe('redaction matches the previous implementation exactly', () => {
  it('redactString agrees with the old lookahead implementation on random credential-like strings', () => {
    fc.assert(
      fc.property(mixed, (s) => {
        expect(redactString(s)).toBe(oldRedactString(s));
      }),
      { numRuns: 5000 },
    );
  });

  it('looksLikeSecret agrees with the old lookahead implementation on random credential-like strings', () => {
    fc.assert(
      fc.property(mixed, (s) => {
        expect(looksLikeSecret(s)).toBe(oldLooksLikeSecret(s));
      }),
      { numRuns: 5000 },
    );
  });

  it.each([
    'authorization: abcdefghijklmnopqrst',
    'authorization: abcdefghijklmnop1234(',
    'authorization: abcdefghijklmnop1234',
    'authorization: authorization: abc123abc123abc123',
    'x-api-key: abcdefgh(',
    'api_key=api_key=abc123abc123abc123',
    'apiKey: "abcdefgh12345678"',
    '-----BEGIN RSA PRIVATE KEY-----\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
  ])('agrees on the boundary case %j', (s) => {
    expect(redactString(s)).toBe(oldRedactString(s));
    expect(looksLikeSecret(s)).toBe(oldLooksLikeSecret(s));
  });
});
