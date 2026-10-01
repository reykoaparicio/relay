import picomatch from 'picomatch';
import type { ExclusionReason } from '@relay/contracts';
import { SECRET_ROOT_SEGMENTS } from './paths.js';

/** §3.4: the binary sniff looks at the first 8 KiB of a file. */
export const SNIFF_BYTES = 8 * 1024;
/** §3.4: more than 30% non-text bytes in the sniff window means binary. */
export const BINARY_NON_TEXT_RATIO = 0.3;

/** Pre-read stat data for {@link classify} (kept minimal so classify stays pure). */
export interface EntryStat {
  readonly isDirectory: boolean;
  readonly size: number;
}

/** Pre-read content sniff for {@link classify} (see {@link sniffBytes}). */
export interface Sniff {
  readonly hasNul: boolean;
  readonly nonTextRatio: number;
}

/** Everything {@link classify} needs besides the entry itself. All members are pure functions or plain data. */
export interface ClassifyContext {
  /** Per-file cap (`INPUT_CAPS.maxFileBytes`). */
  readonly maxFileBytes: number;
  /** The project root's realpath passes through a credential dir (B4 defense in depth): everything is `secret`. */
  readonly rootIsSecret?: boolean;
  /** Project `exclusions` globs, compiled by {@link compileUserPatterns}. */
  readonly isUserExcluded?: (relPath: string) => boolean;
  /** Project `.gitignore` matcher (see `gitignore.ts`); omitted when `respectGitignore` is off. */
  readonly isGitignored?: (relPath: string, isDirectory: boolean) => boolean;
  /**
   * Every ancestor directory of the entry was already classified with this context and was NOT excluded, so the
   * user-pattern and gitignore rules need checking for the entry itself only. Set ONLY by `scanProject`, whose walk
   * never descends into an excluded directory. Direct reads (`readSelected`) never set it: a requested path's
   * ancestors have not been vetted, so every prefix is checked.
   */
  readonly ancestorsVetted?: boolean;
  /** Totals caps (`INPUT_CAPS.maxTotalBytes` / `maxFiles`) and the running totals already included. */
  readonly caps?: {
    readonly maxTotalBytes: number;
    readonly maxFiles: number;
    readonly includedBytes: number;
    readonly includedFiles: number;
  };
}

/** Output of {@link classify}. */
export type Classification = { readonly included: true } | { readonly included: false; readonly reason: ExclusionReason };

const DEPENDENCY_DIRS = new Set(['node_modules', 'vendor', '.pnpm-store', 'bower_components', '.venv', 'venv', '__pycache__', 'target']);
const BUILD_DIRS = new Set(['dist', 'build', 'out', '.next', '.nuxt', 'coverage', '.turbo']);
const BUILD_FILE = /(\.min\.js|\.map|\.bundle\.js)$/;
const VCS_DIRS = new Set(['.git', '.hg', '.svn']);
/** Credential directories: the same runs that `paths.ts` refuses as roots (multi-segment runs match consecutively). */
const SECRET_DIR_RUNS = SECRET_ROOT_SEGMENTS;
const SECRET_NAMES = new Set([
  '.env',
  '.envrc',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.pgpass',
  '.git-credentials',
  '.dev.vars',
  '.yarnrc.yml',
]);
/** Secret name patterns; matched case-insensitively against every segment (§11.1: fail closed). */
const SECRET_PATTERNS: readonly RegExp[] = [
  /^\.env[._-].+$/,
  /\.env$/,
  /\.(pem|key|p12|pfx|keystore|jks|tfvars)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /^credentials/,
  /secret/,
  /^service-account.*\.json$/,
];
const SECRET_ALLOWED = new Set(['.env.example']);
const OS_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const BINARY_EXTENSIONS = new Set(
  'png jpg jpeg gif webp ico pdf zip gz tar 7z jar exe dll so dylib wasm mp4 mov woff woff2 ttf otf sqlite db'.split(' '),
);

function isSecretSegment(segment: string): boolean {
  const s = segment.toLowerCase();
  if (SECRET_ALLOWED.has(s)) return false;
  return SECRET_NAMES.has(s) || SECRET_PATTERNS.some((re) => re.test(s));
}

/** True when the segments contain a credential-directory run (`.aws`, `.config/gcloud`, …), case-insensitive. */
function hasSecretDirRun(segments: readonly string[]): boolean {
  const lower = segments.map((x) => x.toLowerCase());
  return SECRET_DIR_RUNS.some((run) => lower.some((_, i) => run.every((seg, j) => lower[i + j] === seg)));
}

function isOsFile(name: string): boolean {
  return OS_FILES.has(name) || name.startsWith('._');
}

function hasBinaryExtension(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** `a/b/c` → `['a', 'a/b', 'a/b/c']`. */
function prefixesOf(segments: readonly string[]): string[] {
  return segments.map((_, i) => segments.slice(0, i + 1).join('/'));
}

/** Rules that need only the path (secret → vcs → dependency → build → os → user → gitignored → binary extension). */
export function classifyByName(rawRelPath: string, isDirectory: boolean, ctx: ClassifyContext): ExclusionReason | null {
  if (ctx.rootIsSecret === true) return 'secret';
  // Classification is always on NFC so an NFD spelling on disk (or in a request) cannot dodge a pattern (B3).
  const relPath = rawRelPath.normalize('NFC');
  const segments = relPath.split('/');
  const name = segments[segments.length - 1] ?? relPath;
  // Directory-only rules apply to ancestors always, and to the entry itself when it is a directory.
  const dirSegments = isDirectory ? segments : segments.slice(0, -1);
  if (segments.some(isSecretSegment) || hasSecretDirRun(segments)) return 'secret';
  if (segments.some((s) => VCS_DIRS.has(s.toLowerCase()))) return 'vcs_internal';
  if (dirSegments.some((s) => DEPENDENCY_DIRS.has(s))) return 'dependency_dir';
  if (dirSegments.some((s) => BUILD_DIRS.has(s)) || (!isDirectory && BUILD_FILE.test(name))) return 'build_output';
  if (!isDirectory && isOsFile(name)) return 'os_file';
  // Directory-ness per prefix: every proper prefix is a directory; the entry itself is what the caller says.
  const prefixes = ctx.ancestorsVetted === true ? [relPath] : prefixesOf(segments);
  const last = prefixes.length - 1;
  const { isUserExcluded, isGitignored } = ctx;
  if (isUserExcluded !== undefined && prefixes.some((p) => isUserExcluded(p))) return 'user_pattern';
  if (isGitignored !== undefined && prefixes.some((p, i) => isGitignored(p, i < last || isDirectory))) return 'gitignored';
  if (!isDirectory && hasBinaryExtension(name)) return 'binary';
  return null;
}

/** Rules that need content or totals (binary sniff → too_large → cap_exceeded). Files only. */
export function classifyByContent(stat: EntryStat, sniff: Sniff | null, ctx: ClassifyContext): ExclusionReason | null {
  if (stat.isDirectory) return null;
  if (sniff !== null && (sniff.hasNul || sniff.nonTextRatio > BINARY_NON_TEXT_RATIO)) return 'binary';
  if (stat.size > ctx.maxFileBytes) return 'too_large';
  const { caps } = ctx;
  if (caps !== undefined) {
    const overFiles = caps.includedFiles + 1 > caps.maxFiles;
    const overBytes = caps.includedBytes + stat.size > caps.maxTotalBytes;
    if (overFiles || overBytes) return 'cap_exceeded';
  }
  return null;
}

/**
 * Classifies one entry (§3.4, §11.1). Pure: stat and sniff are pre-read. Fixed order, first match wins:
 * secret → vcs → dependency → build → os → user → gitignored → binary → size → cap. Secrets are never readable,
 * even when explicitly selected (P0 has no override).
 */
export function classify(relPath: string, stat: EntryStat, sniff: Sniff | null, ctx: ClassifyContext): Classification {
  const reason = classifyByName(relPath, stat.isDirectory, ctx) ?? classifyByContent(stat, sniff, ctx);
  return reason === null ? { included: true } : { included: false, reason };
}

/**
 * 1 for a non-text byte, else 0: control characters other than \t \n \v \f \r and ESC, plus DEL. Bytes >= 0x80
 * count as text (UTF-8). A table lookup keeps the hot loop branch-free.
 */
const NON_TEXT_BYTE: Uint8Array = Uint8Array.from({ length: 256 }, (_, b) =>
  b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b) || b === 0x7f ? 1 : 0,
);

/** Sniffs the first {@link SNIFF_BYTES} of `bytes` for NUL and the non-text ratio. Pure. */
export function sniffBytes(bytes: Uint8Array): Sniff {
  const window = bytes.subarray(0, SNIFF_BYTES);
  const n = window.length;
  if (n === 0) return { hasNul: false, nonTextRatio: 0 };
  let nonText = 0;
  for (let i = 0; i < n; i += 1) nonText += NON_TEXT_BYTE[window[i] ?? 0] ?? 0;
  return { hasNul: window.includes(0), nonTextRatio: nonText / n };
}

/** Compiles project `exclusions` globs (picomatch, `dot: true`). Globs and paths are matched in NFC (B3). */
export function compileUserPatterns(globs: readonly string[]): (relPath: string) => boolean {
  if (globs.length === 0) return () => false;
  const isMatch = picomatch(
    globs.map((g) => g.normalize('NFC')),
    { dot: true },
  );
  return (relPath) => isMatch(relPath.normalize('NFC'));
}
