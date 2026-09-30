import picomatch from 'picomatch';
import type { ExclusionReason } from '@relay/contracts';

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
  /** Project `exclusions` globs, compiled by {@link compileUserPatterns}. */
  readonly isUserExcluded?: (relPath: string) => boolean;
  /** Project `.gitignore` matcher (see `gitignore.ts`); omitted when `respectGitignore` is off. */
  readonly isGitignored?: (relPath: string, isDirectory: boolean) => boolean;
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
const SECRET_DIRS = new Set(['.aws', '.ssh', '.gnupg']);
const SECRET_NAMES = new Set(['.env', '.npmrc', '.pypirc', '.netrc']);
/** Secret name patterns; matched case-insensitively against every segment (§11.1: fail closed). */
const SECRET_PATTERNS: readonly RegExp[] = [
  /^\.env\..+$/,
  /\.(pem|key|p12|pfx|keystore)$/,
  /^id_rsa/,
  /^id_ed25519/,
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
  return SECRET_NAMES.has(s) || SECRET_DIRS.has(s) || SECRET_PATTERNS.some((re) => re.test(s));
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
export function classifyByName(relPath: string, isDirectory: boolean, ctx: ClassifyContext): ExclusionReason | null {
  const segments = relPath.split('/');
  const name = segments[segments.length - 1] ?? relPath;
  // Directory-only rules apply to ancestors always, and to the entry itself when it is a directory.
  const dirSegments = isDirectory ? segments : segments.slice(0, -1);
  if (segments.some(isSecretSegment)) return 'secret';
  if (segments.some((s) => VCS_DIRS.has(s.toLowerCase()))) return 'vcs_internal';
  if (dirSegments.some((s) => DEPENDENCY_DIRS.has(s))) return 'dependency_dir';
  if (dirSegments.some((s) => BUILD_DIRS.has(s)) || (!isDirectory && BUILD_FILE.test(name))) return 'build_output';
  if (!isDirectory && isOsFile(name)) return 'os_file';
  const prefixes = prefixesOf(segments);
  const { isUserExcluded, isGitignored } = ctx;
  if (isUserExcluded !== undefined && prefixes.some((p) => isUserExcluded(p))) return 'user_pattern';
  if (isGitignored !== undefined) {
    const last = prefixes.length - 1;
    if (prefixes.some((p, i) => isGitignored(p, i < last || isDirectory))) return 'gitignored';
  }
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

function isNonTextByte(b: number): boolean {
  // Control characters other than \t \n \v \f \r and ESC; bytes >= 0x80 count as text (UTF-8).
  return (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b) || b === 0x7f);
}

/** Sniffs the first {@link SNIFF_BYTES} of `bytes` for NUL and the non-text ratio. Pure. */
export function sniffBytes(bytes: Uint8Array): Sniff {
  const window = bytes.subarray(0, SNIFF_BYTES);
  if (window.length === 0) return { hasNul: false, nonTextRatio: 0 };
  let nonText = 0;
  let hasNul = false;
  for (const b of window) {
    if (b === 0) hasNul = true;
    if (isNonTextByte(b)) nonText += 1;
  }
  return { hasNul, nonTextRatio: nonText / window.length };
}

/** Compiles project `exclusions` globs (picomatch, `dot: true`). No globs → matches nothing. */
export function compileUserPatterns(globs: readonly string[]): (relPath: string) => boolean {
  if (globs.length === 0) return () => false;
  const isMatch = picomatch([...globs], { dot: true });
  return (relPath) => isMatch(relPath);
}
