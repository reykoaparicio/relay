import { assertNever } from './assert.js';

// Redaction (02 §B8, 00b §6). Applies to logs, event payloads, error details, and stored raw provider responses ONLY.
// Never applied to validated output artifacts (findings/plan/patch/review/report canonical JSON) or input_file
// snapshots: rewriting a diff or source file would corrupt it. Secrets in project files are kept out of context by the
// 05 E2 `secret` exclusion, not by redaction.

/** Every `sk-` pattern starts with this lookbehind so words like "risk-assessment-…" or "task-…" never match. */
const NB = '(?<![A-Za-z0-9])';
/**
 * Left boundary for the distinctive-prefix rules (sk-ant-, sk-proj-, sk-svcacct-, gh*_/github_pat_, AIza): {@link NB},
 * or right after a JSON escape whose last char is a letter or digit — `\n` / `\t` / `\r` (e.g. `"Key
 * rejected:\nsk-ant-…"`, audit F3), `\b` / `\f`, or a complete `\uXXXX` (round-3 B6: `x\u003csk-ant-…`, which
 * `JSON.stringify` writes for control characters) — or a `%XX` URL escape (`%22sk-ant-…`). The generic `sk-` rule
 * keeps plain {@link NB}: after `%2D` or `\n` in random text it would over-match. Each alternative is a fixed-length
 * lookbehind (2, 6 or 3 chars) checked once per start position: still linear.
 */
const NB_ESC = `(?:${NB}|(?<=\\\\[nrtbf]|\\\\u[0-9A-Fa-f]{4}|%[0-9A-Fa-f]{2}))`;
/** An optional quote around a JSON key or value, possibly backslash-escaped (`"`, `'`, `\"`). */
const Q = `(?:\\\\?["'])?`;
/** Characters of a credential-shaped token (base64/base64url, JWT, and API key alphabets). */
const CRED = 'A-Za-z0-9_\\-+/=.~';
// Value patterns are plain greedy runs with nothing after them, so each match is the maximal run and never backtracks.
// The conditions that used to be lookaheads (a letter and a digit somewhere in the run; not followed by `(`) are
// checked in code after the match ({@link SecretRule.value}). As lookaheads they rescanned the rest of the run from
// every start position, so 256 KB of `authorization=` or `api_key=…(` took seconds to minutes (quadratic), and such
// text can arrive in provider error bodies. A failed check rejects the whole run, which is exactly what the
// lookaheads did: every later start inside the run sees a suffix of it, with the same next char and fewer letters.

/**
 * A credential-token run: ≥ 16 credential chars. With `value: 'credential'` it must also contain a letter and a
 * digit and not be followed by `(` (so identifiers and calls like `getAuthorizationHeader(req)` never match). Used
 * where only the key name hints at a secret (02 §B8; memory guard false positives, §5.5).
 */
const CREDENTIAL_VALUE = `(?!\\[REDACTED)[${CRED}]{16,}`;
/** A value of any shape after an explicit API-key name: ≥ 8 chars. With `value: 'delimited'`, not followed by `(`. */
const LOOSE_VALUE = `(?!\\[REDACTED)[^\\s"'\\\\,;{}()\\[\\]<>]{8,}`;
/**
 * Explicit API-key names, as literals so {@link resumeBack} can bound their length. No `\\b` before them (unlike
 * `authorization`), so a name may start anywhere, even inside a word: the resume bound below covers that worst case.
 */
const API_KEY_NAMES = ['api_key', 'api-key', 'apikey', 'x-api-key'] as const;
const AUTHZ_NAMES = ['authorization'] as const;
const API_KEY_NAME = `(?<keep>(?:${API_KEY_NAMES.join('|')})${Q}\\s*[:=]\\s*${Q})`;
const AUTHZ_NAME = `\\b(?:${AUTHZ_NAMES.join('|')})${Q}\\s*[:=]\\s*${Q}`;

type LabelKind = 'sk' | 'akia' | 'pem' | 'plain';

/**
 * A post-match check on the `secret` group: `delimited` = not followed by `(`; `credential` = that plus a letter and
 * a digit in the value. `keyNames` are the literal key names the regex starts with; they bound where scanning resumes
 * after a rejected value ({@link resumeBack}). Absent: the regex match is final.
 */
type ValueCheck =
  | { readonly value: 'credential' | 'delimited'; readonly keyNames: readonly string[] }
  | { readonly value?: undefined; readonly keyNames?: undefined };

/**
 * One secret rule. A regex may name a `keep` group (kept verbatim, e.g. `Authorization: Bearer `) and a `secret` group
 * (the redacted part); without them the whole match is the secret.
 */
type SecretRule = ValueCheck & {
  readonly re: RegExp;
  readonly label: LabelKind;
  /** Applied by {@link redactString} (default true). */
  readonly redact?: boolean;
  /** Applied by {@link looksLikeSecret} (default true). */
  readonly detect?: boolean;
  /** Finds the next match at or after `from` in code instead of with `re` (for rules a regex cannot keep linear). */
  readonly find?: (text: string, from: number) => Span | null;
};

/** A match found by {@link SecretRule.find}: `text.slice(start, end)` is the secret. */
interface Span {
  readonly start: number;
  readonly end: number;
}

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * The next PEM private-key block: the first BEGIN line at or after `from`, through the first END line after it,
 * which is exactly what `BEGIN[\s\S]*?END` matches. That regex retried every later BEGIN line when no END followed
 * (quadratic); here, when the first BEGIN has no END after it, no later BEGIN can have one either, so the search stops.
 */
function findPemBlock(text: string, from: number): Span | null {
  PEM_BEGIN.lastIndex = from;
  const begin = PEM_BEGIN.exec(text);
  if (begin === null) return null;
  PEM_END.lastIndex = begin.index + begin[0].length;
  const end = PEM_END.exec(text);
  return end === null ? null : { start: begin.index, end: end.index + end[0].length };
}

const RULES: readonly SecretRule[] = [
  { re: new RegExp(`${NB_ESC}sk-ant-(?:api|admin)\\d\\d-[A-Za-z0-9_-]{10,}`, 'g'), label: 'sk' }, // Anthropic API / admin keys
  { re: new RegExp(`${NB_ESC}sk-ant-[A-Za-z0-9_-]{10,}`, 'g'), label: 'sk' }, // other Anthropic-shaped keys
  { re: new RegExp(`${NB_ESC}sk-proj-[A-Za-z0-9_-]{16,}`, 'g'), label: 'sk' }, // OpenAI project keys
  { re: new RegExp(`${NB_ESC}sk-svcacct-[A-Za-z0-9_-]{16,}`, 'g'), label: 'sk' }, // OpenAI service-account keys
  { re: new RegExp(`${NB}sk-[A-Za-z0-9_-]{16,}`, 'g'), label: 'sk' }, // generic / legacy sk- keys
  // GitHub classic (ghp_/gho_/ghu_/ghs_/ghr_) and fine-grained (github_pat_) tokens.
  { re: new RegExp(`${NB_ESC}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`, 'g'), label: 'plain' },
  { re: new RegExp(`${NB_ESC}AIza[0-9A-Za-z_-]{35}`, 'g'), label: 'plain' }, // Google / Gemini API keys
  { re: /(?<keep>[?&]key=)(?!\[REDACTED)(?<secret>[A-Za-z0-9_\-.~%]{20,})/g, label: 'plain' }, // Gemini `?key=` param
  // Authorization header/key with a scheme: the whole credential after the scheme is secret.
  {
    re: new RegExp(
      `(?<keep>${AUTHZ_NAME}(?:basic|bearer|token)\\s+)(?!\\[REDACTED)(?<secret>[${CRED}]{8,})`,
      'gi',
    ),
    label: 'plain',
  },
  // Authorization header/key with a raw credential-shaped value.
  {
    re: new RegExp(`(?<keep>${AUTHZ_NAME})(?<secret>${CREDENTIAL_VALUE})`, 'gi'),
    label: 'plain',
    value: 'credential',
    keyNames: AUTHZ_NAMES,
  },
  { re: new RegExp(`(?<keep>\\bBearer\\s+)(?!\\[REDACTED)(?<secret>[${CRED}]{16,})`, 'gi'), label: 'plain' },
  // Explicit API-key names: logs redact any delimited value; the memory guard needs a credential-shaped one.
  {
    re: new RegExp(`${API_KEY_NAME}(?<secret>${LOOSE_VALUE})`, 'gi'),
    label: 'plain',
    detect: false,
    value: 'delimited',
    keyNames: API_KEY_NAMES,
  },
  {
    re: new RegExp(`${API_KEY_NAME}(?<secret>${CREDENTIAL_VALUE})`, 'gi'),
    label: 'plain',
    redact: false,
    value: 'credential',
    keyNames: API_KEY_NAMES,
  },
  // PEM private keys. redactString/looksLikeSecret use findPemBlock (same matches, linear time); this regex is the
  // SECRET_PATTERNS candidate for scanners, and its body never crosses another BEGIN line so it is linear too.
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----BEGIN )[\s\S])*?-----END [A-Z ]*PRIVATE KEY-----/g, label: 'pem', find: findPemBlock },
  { re: /AKIA[0-9A-Z]{16}/g, label: 'akia' },
];

const REDACT_RULES = RULES.filter((r) => r.redact !== false);
const DETECT_RULES = RULES.filter((r) => r.detect !== false);

/**
 * Canonical redaction patterns (00b §6). All are global regexes. They are candidate finders: some rules add a
 * post-match check that looks one char past the match, and a run rejected by that check can hide a later key name,
 * so do not `matchAll` them; scanners use {@link findSecretMatches}, then confirm a hit with {@link looksLikeSecret}
 * on the match plus its next char (as `check:secrets` does).
 */
export const SECRET_PATTERNS: readonly RegExp[] = REDACT_RULES.map((r) => r.re);

/** Non-global copies (no `lastIndex` state) for rules without a post-match check: `test` stops at the first hit. */
const DETECT_PATTERNS: ReadonlyMap<SecretRule, RegExp> = new Map(
  DETECT_RULES.map((r) => [r, new RegExp(r.re.source, r.re.flags.replace('g', ''))]),
);

const LAST_CHARS = 4;
const MIN_LABEL_SOURCE = 12;

/** Last 4 chars of a secret (for recognizability), or '' when the secret is too short to reveal any. */
function tail(secret: string): string {
  return secret.length >= MIN_LABEL_SOURCE ? secret.slice(-LAST_CHARS) : '';
}

/** "sk-…a1F9" for `sk-` keys, "…a1F9" otherwise (never more than the last 4 chars; ≤ 40 chars). */
export function redactedLabel(apiKey: string): string {
  const trimmed = apiKey.trim();
  const prefix = trimmed.startsWith('sk-') ? 'sk-' : '';
  return `${prefix}…${tail(trimmed)}`;
}

function label(kind: LabelKind, secret: string): string {
  switch (kind) {
    case 'sk':
      return redactedLabel(secret);
    case 'akia':
      return `AKIA…${tail(secret)}`;
    case 'pem':
      return 'private-key';
    case 'plain':
      return `…${tail(secret)}`;
    default:
      return assertNever(kind);
  }
}

type Groups = Partial<Record<'keep' | 'secret', string>>;

/** A letter and a digit somewhere in `value`. */
function isCredentialShaped(value: string): boolean {
  return /\d/.test(value) && /[A-Za-z]/.test(value);
}

/** The post-match half of a rule; `next` is the char right after the match ('' at the end of the text). */
function passesValueCheck(rule: SecretRule, secret: string, next: string): boolean {
  if (rule.value === undefined) return true;
  if (next === '(') return false;
  return rule.value === 'delimited' || isCredentialShaped(secret);
}

function replacer(kind: LabelKind): (match: string, ...rest: unknown[]) => string {
  return (match, ...rest) => {
    // With named groups the trailing replacer args are (…captures, offset, input, groups).
    const last = rest.at(-1);
    const groups: Groups = typeof last === 'object' && last !== null ? last : {};
    const keep = groups.keep ?? '';
    const secret = groups.secret ?? match.slice(keep.length);
    return `${keep}[REDACTED:${label(kind, secret)}]`;
  };
}

function replaceSpans(text: string, rule: SecretRule, find: (text: string, from: number) => Span | null): string {
  let out = '';
  let at = 0;
  for (let span = find(text, 0); span !== null; span = find(text, at)) {
    out += `${text.slice(at, span.start)}[REDACTED:${label(rule.label, text.slice(span.start, span.end))}]`;
    at = span.end;
  }
  return at === 0 ? text : out + text.slice(at);
}

function matchPasses(rule: SecretRule, m: RegExpExecArray, text: string): boolean {
  const secret = m.groups?.['secret'] ?? m[0];
  return passesValueCheck(rule, secret, text.charAt(m.index + m[0].length));
}

/**
 * How far before the end of a rejected value scanning resumes: the longest key name plus one.
 *
 * The old lookahead regex retried at every position after a rejected start; this skips the positions that cannot
 * match, which keeps the scan linear. A rule's value is the maximal run of its value alphabet, and a match is rejected
 * only for its next char (`(`) or for lacking a letter or digit, so any match whose value starts inside the rejected
 * run [vs, ve) sees a suffix of it (same next char, fewer chars) and is rejected too. A later match must therefore put
 * its value at or after `ve`. Its key name is made of value-alphabet chars (letters, `_`, `-`), and of the chars
 * between name and value (`Q`, `\s`, `[:=]`, `Q`) only `:`/`=` can be value chars, so such a name either ends at
 * `ve` or at `ve - 1` with the separator as the run's last char: it starts at or after `ve - (longest name + 1)`.
 * A name cannot start inside the rejected match's own name or separators either (no name is a suffix-prefix overlap
 * of another, except `api-key` inside `x-api-key`, which reaches the same value). The missing `\b` before API-key
 * names lets them start mid-word, but that only matters inside the window above, which counts the full name.
 */
function resumeBack(rule: SecretRule): number {
  return Math.max(0, ...(rule.keyNames ?? []).map((n) => n.length)) + 1;
}

/** Private global copies (scanning sets `lastIndex`; the exported patterns are never touched) and their resume bounds. */
const SCANNERS: ReadonlyMap<SecretRule, { readonly re: RegExp; readonly back: number }> = new Map(
  RULES.map((r) => [r, { re: new RegExp(r.re.source, r.re.flags), back: resumeBack(r) }]),
);

/**
 * The first match of `rule.re` at or after `from` that passes the rule's value check: exactly the next match of the
 * old lookahead regex. A rejected match resumes at `max(start + 1, valueEnd - back)` (see {@link resumeBack}).
 */
function nextMatch(rule: SecretRule, text: string, from: number): RegExpExecArray | null {
  const scanner = SCANNERS.get(rule);
  if (scanner === undefined) return null;
  const { re, back } = scanner;
  for (let at = from; at <= text.length; ) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (m === null || matchPasses(rule, m, text)) return m;
    at = Math.max(m.index + 1, m.index + m[0].length - back);
  }
  return null;
}

/** Every passing match of `rule.re` in `text`, non-overlapping and in order (what `replace` with the old regex saw). */
function ruleMatches(rule: SecretRule, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  for (let m = nextMatch(rule, text, 0); m !== null; m = nextMatch(rule, text, m.index + m[0].length)) out.push(m);
  return out;
}

function redactMatches(text: string, rule: SecretRule): string {
  let out = '';
  let at = 0;
  for (const m of ruleMatches(rule, text)) {
    const keep = m.groups?.['keep'] ?? '';
    const secret = m.groups?.['secret'] ?? m[0].slice(keep.length);
    out += `${text.slice(at, m.index)}${keep}[REDACTED:${label(rule.label, secret)}]`;
    at = m.index + m[0].length;
  }
  return at === 0 ? text : out + text.slice(at);
}

function redactRule(text: string, rule: SecretRule): string {
  if (rule.find !== undefined) return replaceSpans(text, rule, rule.find);
  if (rule.value !== undefined) return redactMatches(text, rule);
  return text.replace(rule.re, replacer(rule.label));
}

/** Replaces every secret-looking substring, e.g. `sk-ant-api03-…a1F9` → `[REDACTED:sk-…a1F9]`. Idempotent. */
export function redactString(s: string): string {
  let out = s;
  for (const rule of REDACT_RULES) out = redactRule(out, rule);
  return out;
}

function ruleDetects(rule: SecretRule, text: string): boolean {
  if (rule.find !== undefined) return rule.find(text, 0) !== null;
  if (rule.value === undefined) return DETECT_PATTERNS.get(rule)?.test(text) ?? false;
  return nextMatch(rule, text, 0) !== null;
}

/** A secret candidate: `text.slice(index, index + match.length)` matched a rule's pattern and passed its value check. */
export interface SecretMatch {
  readonly index: number;
  readonly match: string;
}

/**
 * Candidate secrets for scanners: every match of every rule (redaction and detection-only rules alike, each by its
 * {@link SECRET_PATTERNS}-style regex) that passes the rule's own value check, in rule order then text order. Unlike
 * `matchAll` over SECRET_PATTERNS, a run rejected by a value check never hides a later key name. Confirm each with
 * {@link looksLikeSecret} on the match plus its next char: a redaction-only candidate (any value after an API-key
 * name) is not necessarily credential-shaped.
 */
export function findSecretMatches(text: string): SecretMatch[] {
  return RULES.flatMap((rule) => ruleMatches(rule, text).map((m) => ({ index: m.index, match: m[0] })));
}

/**
 * True when `text` contains a secret (memory secret guard, §5.5). Stricter than {@link redactString} for bare
 * key/value pairs: the value must look like a credential, so prose such as "read apiKey: fromVault()" passes.
 */
export function looksLikeSecret(text: string): boolean {
  return DETECT_RULES.some((rule) => ruleDetects(rule, text));
}

/** Keys that are always removed by {@link redactDeep} (case-insensitive, `-`/`_` ignored). */
export const ALWAYS_DROPPED_KEYS = ['apiKey', 'authorization', 'xApiKey', 'headers'] as const;
/** Keys removed by default in addition to {@link ALWAYS_DROPPED_KEYS}; replaceable via `opts.dropKeys`. */
export const DEFAULT_DROP_KEYS = ['content'] as const;

/** Options for {@link redactDeep}. */
export interface RedactDeepOptions {
  /** Extra keys to drop, replacing {@link DEFAULT_DROP_KEYS}. {@link ALWAYS_DROPPED_KEYS} are dropped regardless. */
  readonly dropKeys?: readonly string[];
}

const normalizeKey = (k: string): string => k.replace(/[-_]/g, '').toLowerCase();

type Primitive = string | number | boolean | bigint | symbol | undefined | null;

const isPrimitive = (v: unknown): v is Primitive =>
  v === null || (typeof v !== 'object' && typeof v !== 'function');

/** Values that are not plain containers: serialized to a readable, JSON-safe form (never walked as objects). */
function redactSpecial(
  value: object,
): { readonly hit: true; readonly out: unknown } | { readonly hit: false } {
  if (value instanceof Date) {
    return { hit: true, out: Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString() };
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return { hit: true, out: `[binary ${String(value.byteLength)} bytes]` };
  }
  if (value instanceof Error) {
    return { hit: true, out: { name: value.name, message: redactString(value.message) } };
  }
  return { hit: false };
}

/** Map → object of redacted entries when every key is primitive (dropped keys removed), else an array of pairs. */
function redactMap(
  map: ReadonlyMap<unknown, unknown>,
  walk: (v: unknown) => unknown,
  drop: ReadonlySet<string>,
): unknown {
  const entries = [...map.entries()];
  if (!entries.every(([k]) => isPrimitive(k))) {
    return entries.map(([k, v]) => [walk(k), walk(v)]);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    const key = String(k);
    if (!drop.has(normalizeKey(key))) out[key] = walk(v);
  }
  return out;
}

function redactObject(value: object, walk: (v: unknown) => unknown, drop: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (value instanceof Map) return redactMap(value, walk, drop);
  if (value instanceof Set) return [...value].map(walk);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!drop.has(normalizeKey(k))) out[k] = walk(v);
  }
  return out;
}

/** `ancestors` holds only the objects on the current path, so shared (non-cyclic) references are copied, not flagged. */
function redactValue(value: unknown, drop: ReadonlySet<string>, ancestors: Set<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object' || value === null) return value;
  const special = redactSpecial(value);
  if (special.hit) return special.out;
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    return redactObject(value, (v) => redactValue(v, drop, ancestors), drop);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Deep copy with secret-looking strings redacted and sensitive keys removed at any depth
 * (`apiKey`, `authorization`, `x-api-key`, `headers`, and by default `content`). Errors become `{ name, message }`,
 * Dates ISO strings, Maps objects (or `[key, value]` pairs when keys are objects), Sets arrays, and binary data
 * `'[binary N bytes]'`. Only true cycles become `'[Circular]'`; shared references are copied.
 */
export function redactDeep<T>(value: T, opts?: RedactDeepOptions): T {
  const drop = new Set([...ALWAYS_DROPPED_KEYS, ...(opts?.dropKeys ?? DEFAULT_DROP_KEYS)].map(normalizeKey));
  return redactValue(value, drop, new Set()) as T;
}

/** "~/code/x" for paths under `homeDir`; the renderer never sees the raw home path. POSIX paths only. */
export function toDisplayPath(absPath: string, homeDir: string): string {
  const home = homeDir.endsWith('/') && homeDir.length > 1 ? homeDir.slice(0, -1) : homeDir;
  if (home === '' || home === '/') return absPath;
  if (absPath === home) return '~';
  if (absPath.startsWith(`${home}/`)) return `~${absPath.slice(home.length)}`;
  return absPath;
}
