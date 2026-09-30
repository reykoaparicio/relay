import { assertNever } from './assert.js';

// Redaction (02 §B8, 00b §6). Applies to logs, event payloads, error details, and stored raw provider responses ONLY.
// Never applied to validated output artifacts (findings/plan/patch/review/report canonical JSON) or input_file
// snapshots: rewriting a diff or source file would corrupt it. Secrets in project files are kept out of context by the
// 05 E2 `secret` exclusion, not by redaction.

/** Every `sk-` pattern starts with this lookbehind so words like "risk-assessment-…" or "task-…" never match. */
const NB = '(?<![A-Za-z0-9])';
/** An optional quote around a JSON key or value, possibly backslash-escaped (`"`, `'`, `\"`). */
const Q = `(?:\\\\?["'])?`;
/** Characters of a credential-shaped token (base64/base64url, JWT, and API key alphabets). */
const CRED = 'A-Za-z0-9_\\-+/=.~';
/**
 * A credential-shaped value: ≥ 16 credential chars with at least one letter and one digit, not followed by more
 * token chars or `(` (so identifiers and calls like `getAuthorizationHeader(req)` never match). Used where only the
 * key name hints at a secret (02 §B8; memory guard false positives, §5.5).
 */
const CREDENTIAL_VALUE = `(?!\\[REDACTED)(?=[${CRED}]*\\d)(?=[${CRED}]*[A-Za-z])[${CRED}]{16,}(?![${CRED}(])`;
/** A value of any shape after an explicit API-key name: ≥ 8 chars, ended by a delimiter (not `(`, so calls never match). */
const LOOSE_VALUE = `(?!\\[REDACTED)[^\\s"'\\\\,;{}()\\[\\]<>]{8,}(?![^\\s"'\\\\,;{}\\[\\]<>)])`;
const API_KEY_NAME = `(?<keep>(?:api[_-]?key|x-api-key)${Q}\\s*[:=]\\s*${Q})`;
const AUTHZ_NAME = `\\bauthorization${Q}\\s*[:=]\\s*${Q}`;

type LabelKind = 'sk' | 'akia' | 'pem' | 'plain';

/**
 * One secret rule. A regex may name a `keep` group (kept verbatim, e.g. `Authorization: Bearer `) and a `secret` group
 * (the redacted part); without them the whole match is the secret.
 */
interface SecretRule {
  readonly re: RegExp;
  readonly label: LabelKind;
  /** Applied by {@link redactString} (default true). */
  readonly redact?: boolean;
  /** Applied by {@link looksLikeSecret} (default true). */
  readonly detect?: boolean;
}

const RULES: readonly SecretRule[] = [
  { re: new RegExp(`${NB}sk-ant-(?:api|admin)\\d\\d-[A-Za-z0-9_-]{10,}`, 'g'), label: 'sk' }, // Anthropic API / admin keys
  { re: new RegExp(`${NB}sk-ant-[A-Za-z0-9_-]{10,}`, 'g'), label: 'sk' }, // other Anthropic-shaped keys
  { re: new RegExp(`${NB}sk-proj-[A-Za-z0-9_-]{16,}`, 'g'), label: 'sk' }, // OpenAI project keys
  { re: new RegExp(`${NB}sk-svcacct-[A-Za-z0-9_-]{16,}`, 'g'), label: 'sk' }, // OpenAI service-account keys
  { re: new RegExp(`${NB}sk-[A-Za-z0-9_-]{16,}`, 'g'), label: 'sk' }, // generic / legacy sk- keys
  // GitHub classic (ghp_/gho_/ghu_/ghs_/ghr_) and fine-grained (github_pat_) tokens.
  { re: new RegExp(`${NB}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`, 'g'), label: 'plain' },
  { re: new RegExp(`${NB}AIza[0-9A-Za-z_-]{35}`, 'g'), label: 'plain' }, // Google / Gemini API keys
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
  { re: new RegExp(`(?<keep>${AUTHZ_NAME})(?<secret>${CREDENTIAL_VALUE})`, 'gi'), label: 'plain' },
  { re: new RegExp(`(?<keep>\\bBearer\\s+)(?!\\[REDACTED)(?<secret>[${CRED}]{16,})`, 'gi'), label: 'plain' },
  // Explicit API-key names: logs redact any delimited value; the memory guard needs a credential-shaped one.
  { re: new RegExp(`${API_KEY_NAME}(?<secret>${LOOSE_VALUE})`, 'gi'), label: 'plain', detect: false },
  { re: new RegExp(`${API_KEY_NAME}(?<secret>${CREDENTIAL_VALUE})`, 'gi'), label: 'plain', redact: false },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: 'pem' },
  { re: /AKIA[0-9A-Z]{16}/g, label: 'akia' },
];

/** Canonical redaction patterns (00b §6). All are global regexes; use them only with `String.prototype.replace`. */
export const SECRET_PATTERNS: readonly RegExp[] = RULES.filter((r) => r.redact !== false).map((r) => r.re);

const REDACT_RULES = RULES.filter((r) => r.redact !== false);
/** Non-global copies (no `lastIndex` state) for {@link looksLikeSecret}. */
const DETECT_PATTERNS: readonly RegExp[] = RULES.filter((r) => r.detect !== false).map(
  (r) => new RegExp(r.re.source, r.re.flags.replace('g', '')),
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

function replacer(kind: LabelKind): (match: string, ...rest: unknown[]) => string {
  return (match, ...rest) => {
    const last = rest.at(-1);
    const groups: Groups = typeof last === 'object' && last !== null ? last : {};
    const keep = groups.keep ?? '';
    const secret = groups.secret ?? match.slice(keep.length);
    return `${keep}[REDACTED:${label(kind, secret)}]`;
  };
}

/** Replaces every secret-looking substring, e.g. `sk-ant-api03-…a1F9` → `[REDACTED:sk-…a1F9]`. Idempotent. */
export function redactString(s: string): string {
  let out = s;
  for (const rule of REDACT_RULES) {
    out = out.replace(rule.re, replacer(rule.label));
  }
  return out;
}

/**
 * True when `text` contains a secret (memory secret guard, §5.5). Stricter than {@link redactString} for bare
 * key/value pairs: the value must look like a credential, so prose such as "read apiKey: fromVault()" passes.
 */
export function looksLikeSecret(text: string): boolean {
  return DETECT_PATTERNS.some((p) => p.test(text));
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
