import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findSecretMatches, looksLikeSecret, redactString } from './redaction.js';

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
  // Near-miss key names inside one long rejected run: a rescan from every name after a rejection is quadratic, so
  // these pin the resume rule (scanning restarts near the end of a rejected value, not after its key name).
  ['authorization names inside a letters-only run', `authorization=${fill('.authorization=')}`],
  ['authorization names inside a run ending in a call', `authorization=${fill('.authorization=a1', '(')}`],
  ['API-key names inside a run ending in a call', fill('api_key=a1-x-api-key:', '(')],
  ['API-key names inside a letters-only run', fill('apikey=x-api-key=')],
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

  it.each(ADVERSARIAL)('findSecretMatches handles 256 KB of %s in < 100 ms', (_name, input) => {
    findSecretMatches(input.slice(0, 1024));

    const ms = elapsedMs(() => findSecretMatches(input));

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

/**
 * The scanners' PEM candidate deliberately changed with the linear rewrite (it no longer spans a second BEGIN line, so
 * it starts at the last BEGIN before the END); findSecretMatches is compared against it, not the old quadratic one.
 */
const PEM_CANDIDATE = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----BEGIN )[\s\S])*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** Every match of every old rule (what a scanner's `matchAll` over the old patterns saw), in rule then text order. */
function oldSecretMatches(text: string): { index: number; match: string }[] {
  return OLD_RULES.flatMap((r) =>
    [...text.matchAll(r.label === 'pem' ? PEM_CANDIDATE : r.re)].map((m) => ({ index: m.index, match: m[0] })),
  );
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

/**
 * Adjacent and overlapping key-name/value sequences (impr bug-hunt finding 1). After a value fails its post-match
 * check, a second key name can sit inside or at the end of the rejected run; the old lookahead regex retried there.
 * The vocabulary is every key-name alternative (API-key names, `authorization`, the Bearer and scheme words), the
 * separators that may sit between a name and its value (some of which are also value chars), and credential runs.
 */
const KEY_NAMES = [
  'authorization', 'Authorization', 'AUTHORIZATION', 'api_key', 'api-key', 'apikey', 'x-api-key', 'API_KEY', 'Api-Key',
  'apiKey', 'X-Api-Key', 'Bearer', 'bearer', 'basic', 'token',
] as const;
const SEPARATORS = [
  '=', ':', '"', "'", '\\', ' ', '\t', '.', '-', '(', '\\"', ': ', ' = ', '= ', '="', "='", '"="', ':\t',
] as const;
const CRED_CHARS = ['a', 'Z', '0', '9', '_', '-', '+', '/', '=', '.', '~'];
const credRun = fc.oneof(
  fc.string({ unit: fc.constantFrom(...CRED_CHARS), minLength: 1, maxLength: 24 }),
  fc.string({ unit: fc.constantFrom('a', 'b', 'Z', '-', '.', '_'), minLength: 1, maxLength: 24 }), // never credential-shaped
  fc.constantFrom('abcd1234efgh5678ijkl', 'abcdefghijklmnopqrst', '12345678901234567890', 'no-token-configured', 'use-the-env-var-'),
);
const adjacentKeys = fc.oneof(
  {
    weight: 1,
    arbitrary: fc
      .array(fc.oneof(fc.constantFrom(...KEY_NAMES), fc.constantFrom(...SEPARATORS), credRun), { minLength: 1, maxLength: 10 })
      .map((parts) => parts.join('')),
  },
  {
    weight: 2,
    arbitrary: fc
      .array(fc.tuple(fc.constantFrom(...KEY_NAMES), fc.constantFrom(...SEPARATORS), credRun), { minLength: 2, maxLength: 4 })
      .map((triples) => triples.flat().join('')),
  },
);

/** ≥ 20k runs: with the resume fix reverted, this finds a counterexample within ~1k runs on every seed tried. */
const ADJACENT_RUNS = 20_000;

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

  it('redactString, looksLikeSecret and findSecretMatches agree with the old implementation on adjacent key names', () => {
    fc.assert(
      fc.property(adjacentKeys, (s) => {
        expect(redactString(s)).toBe(oldRedactString(s));
        expect(looksLikeSecret(s)).toBe(oldLooksLikeSecret(s));
        expect(findSecretMatches(s)).toEqual(oldSecretMatches(s));
      }),
      { numRuns: ADJACENT_RUNS },
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
    // A second key name ending inside / at the end of a rejected value run (impr bug-hunt finding 1).
    'authorization=no-token-configured.authorization: abcd1234efgh5678ijkl',
    'api_key=use-the-env-var-api_key: sk9f8a7s6d5f4g3h2j1kzz',
    'authorization=no-token-configured.authorization"=abcd1234efgh5678ijkl',
    // The separator `=` is itself a value char: the name ends one char before the rejected run does.
    'authorization=no-token-configured.authorization= abcd1234efgh5678ijkl',
    'authorization=no-token-configured.authorization="abcd1234efgh5678ijkl"',
    'api_key=use-the-env-var-x-api-key= "sk9f8a7s6d5f4g3h2j1kzz"',
    'apikey=no-token-configuredapi_key"="abcd1234efgh5678ijkl',
    '-----BEGIN RSA PRIVATE KEY-----\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
  ])('agrees on the boundary case %j', (s) => {
    expect(redactString(s)).toBe(oldRedactString(s));
    expect(looksLikeSecret(s)).toBe(oldLooksLikeSecret(s));
    expect(findSecretMatches(s)).toEqual(oldSecretMatches(s));
  });
});

describe('a key name hidden in a rejected value is still found (impr bug-hunt finding 1)', () => {
  it('redacts the authorization value after a rejected letters-only value', () => {
    const s = 'authorization=no-token-configured.authorization: abcd1234efgh5678ijkl';

    expect(redactString(s)).toBe('authorization=no-token-configured.authorization: [REDACTED:…ijkl]');
    expect(looksLikeSecret(s)).toBe(true);
  });

  it('detects the API key after a rejected value, exactly as the old implementation did', () => {
    const s = 'api_key=use-the-env-var-api_key: sk9f8a7s6d5f4g3h2j1kzz';

    expect(looksLikeSecret(s)).toBe(true);
    // Redaction is unchanged from the old implementation: the loose rule takes `use-the-env-var-api_key:` as the value.
    expect(redactString(s)).toBe('api_key=[REDACTED:…key:] sk9f8a7s6d5f4g3h2j1kzz');
    expect(findSecretMatches(s)).toContainEqual({ index: 24, match: 'api_key: sk9f8a7s6d5f4g3h2j1kzz' });
  });
});
