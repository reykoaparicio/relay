// Redaction (02 §B8, 00b §6). Applies to logs, event payloads, error details, and stored raw provider responses ONLY.
// Never applied to validated output artifacts (findings/plan/patch/review/report canonical JSON) or input_file
// snapshots: rewriting a diff or source file would corrupt it. Secrets in project files are kept out of context by the
// 05 E2 `secret` exclusion, not by redaction.

/** Every `sk-` pattern starts with this lookbehind so words like "risk-assessment-…" or "task-…" never match. */
const NB = '(?<![A-Za-z0-9])';

/** Canonical secret patterns (00b §6). All are global regexes; use them only with `String.prototype.replace`. */
export const SECRET_PATTERNS: readonly RegExp[] = [
  new RegExp(`${NB}sk-ant-(?:api|admin)\\d\\d-[A-Za-z0-9_-]{10,}`, 'g'), // Anthropic API / admin keys
  new RegExp(`${NB}sk-ant-[A-Za-z0-9_-]{10,}`, 'g'), // other Anthropic-shaped keys
  new RegExp(`${NB}sk-proj-[A-Za-z0-9_-]{16,}`, 'g'), // OpenAI project keys
  new RegExp(`${NB}sk-svcacct-[A-Za-z0-9_-]{16,}`, 'g'), // OpenAI service-account keys
  new RegExp(`${NB}sk-[A-Za-z0-9_-]{16,}`, 'g'), // generic / legacy sk- keys
  /Bearer\s+[A-Za-z0-9._-]{10,}/gi,
  /(?:api[_-]?key|x-api-key|authorization)["']?\s*[:=]\s*["']?(?!\[REDACTED)[^"'\s,}]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /AKIA[0-9A-Z]{16}/g,
];

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

function replacement(match: string): string {
  if (match.startsWith('-----BEGIN')) return '[REDACTED:private-key]';
  if (/^Bearer\s/i.test(match)) return `Bearer [REDACTED:…${tail(match)}]`;
  const kv = /^([^:=]*[:=]\s*["']?)([\s\S]*)$/.exec(match);
  if (kv !== null && !match.startsWith('sk-') && !match.startsWith('AKIA')) {
    const [, key = '', value = ''] = kv;
    return `${key}[REDACTED:…${tail(value)}]`;
  }
  if (match.startsWith('AKIA')) return `[REDACTED:AKIA…${tail(match)}]`;
  return `[REDACTED:${redactedLabel(match)}]`;
}

/** Replaces every secret-looking substring, e.g. `sk-ant-api03-…a1F9` → `[REDACTED:sk-…a1F9]`. Idempotent. */
export function redactString(s: string): string {
  let out = s;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** True when `text` contains anything that matches a secret pattern (memory secret guard, §5.5). */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => new RegExp(p.source, p.flags.replace('g', '')).test(text));
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

function redactValue(value: unknown, drop: ReadonlySet<string>, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v: unknown) => redactValue(v, drop, seen));
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!drop.has(normalizeKey(k))) {
      out[k] = redactValue(v, drop, seen);
    }
  }
  return out;
}

/**
 * Deep copy with secret-looking strings redacted and sensitive keys removed at any depth
 * (`apiKey`, `authorization`, `x-api-key`, `headers`, and by default `content`). Errors become `{ name, message }`.
 */
export function redactDeep<T>(value: T, opts?: RedactDeepOptions): T {
  const drop = new Set([...ALWAYS_DROPPED_KEYS, ...(opts?.dropKeys ?? DEFAULT_DROP_KEYS)].map(normalizeKey));
  return redactValue(value, drop, new WeakSet()) as T;
}

/** "~/code/x" for paths under `homeDir`; the renderer never sees the raw home path. POSIX paths only. */
export function toDisplayPath(absPath: string, homeDir: string): string {
  const home = homeDir.endsWith('/') && homeDir.length > 1 ? homeDir.slice(0, -1) : homeDir;
  if (home === '' || home === '/') return absPath;
  if (absPath === home) return '~';
  if (absPath.startsWith(`${home}/`)) return `~${absPath.slice(home.length)}`;
  return absPath;
}
