import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RelPath, Result } from '@relay/contracts';
import { err, errors, ok, relPathSchema, toValidationIssues } from '@relay/contracts';

/**
 * The contracts {@link RelPath} schema (02 primitives). It already brands its output, so this is an alias rather than
 * a second definition of the path rules. Mint a `RelPath` only via {@link normalizeRelPath} or `relPathBrand.parse`.
 */
export const relPathBrand = relPathSchema;
export type { RelPath };

/** An opened, validated project root (§11.2). `realpath` is the canonical absolute path; never shown to users. */
export interface ProjectRoot {
  readonly realpath: string;
  readonly caseInsensitive: boolean;
}

/** Where `child` sits relative to `parent`. */
export type PathRelation = 'equal' | 'inside' | 'outside';

/** System directories that can never be a project root nor contain one (05 E1; 08 applies the same list main-side). */
const SYSTEM_DIRS = ['/System', '/Library', '/usr', '/bin', '/etc'] as const;

/**
 * Pure containment test using `path.relative`, never a string prefix (§11.2). Both inputs must be absolute and already
 * canonical (realpath'd). With `caseInsensitive`, both are compared lowercased.
 */
export function relationOf(parent: string, child: string, caseInsensitive: boolean): PathRelation {
  const p = caseInsensitive ? parent.toLowerCase() : parent;
  const c = caseInsensitive ? child.toLowerCase() : child;
  const rel = path.relative(p, c);
  if (rel === '') return 'equal';
  const escapes = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return escapes ? 'outside' : 'inside';
}

function isErrno(e: unknown, ...codes: string[]): boolean {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' && codes.includes(e.code);
}

/** realpath that falls back to `path.resolve` when the path does not exist (e.g. a userData dir not created yet). */
async function realpathOrResolve(p: string): Promise<string> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

function toggleCase(s: string): string {
  let out = '';
  for (const ch of s) {
    const lower = ch.toLowerCase();
    out += ch === lower ? ch.toUpperCase() : lower;
  }
  return out;
}

/**
 * Detects a case-insensitive volume (APFS default): stat the path and its case-toggled twin; the same inode means
 * insensitive. Toggles the last segment, or the whole path when the last segment has no letters.
 */
export async function detectCaseInsensitive(realDir: string): Promise<boolean> {
  const base = path.basename(realDir);
  const toggledBase = toggleCase(base);
  const probe = toggledBase !== base ? path.join(path.dirname(realDir), toggledBase) : toggleCase(realDir);
  if (probe === realDir) return false;
  try {
    const [a, b] = await Promise.all([fs.promises.stat(realDir), fs.promises.stat(probe)]);
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

async function isUnsafeRoot(real: string, caseInsensitive: boolean, userDataDir: string): Promise<boolean> {
  if (path.parse(real).root === real) return true;
  const [home, userData, systemDirs] = await Promise.all([
    realpathOrResolve(os.homedir()),
    realpathOrResolve(userDataDir),
    Promise.all(SYSTEM_DIRS.map(realpathOrResolve)),
  ]);
  if (relationOf(home, real, caseInsensitive) === 'equal') return true;
  // The userData dir itself, anything inside it, or any ancestor that contains it.
  if (relationOf(real, userData, caseInsensitive) !== 'outside') return true;
  if (relationOf(userData, real, caseInsensitive) !== 'outside') return true;
  const systemCandidates = [...SYSTEM_DIRS, ...systemDirs];
  return systemCandidates.some((dir) => relationOf(dir, real, caseInsensitive) !== 'outside');
}

/**
 * Opens a project root (§11.2, 05 E1): realpath, must be a directory, and must not be an unsafe root ('/', the home
 * dir itself, the userData dir or anything inside/containing it, system dirs). Subdirectories of `os.tmpdir()` are
 * valid roots. This is the runner-side re-check of 08 `pickDirectory`.
 */
export async function openProjectRoot(absPath: string, opts: { userDataDir: string }): Promise<Result<ProjectRoot>> {
  if (!path.isAbsolute(absPath)) {
    return err(
      errors.validationFailed([{ path: 'rootPath', message: 'The project folder path must be absolute.', code: 'not_absolute' }]),
    );
  }
  let real: string;
  try {
    real = await fs.promises.realpath(absPath);
  } catch {
    return err(errors.notFound('project_root'));
  }
  const st = await fs.promises.stat(real);
  if (!st.isDirectory()) {
    return err(errors.validationFailed([{ path: 'rootPath', message: 'The project path is not a folder.', code: 'not_directory' }]));
  }
  const caseInsensitive = await detectCaseInsensitive(real);
  if (await isUnsafeRoot(real, caseInsensitive, opts.userDataDir)) {
    return err(
      errors.permissionDenied('unsafe_root', {
        userMessage: 'This folder cannot be used as a project. Choose a specific project folder instead.',
      }),
    );
  }
  return ok({ realpath: real, caseInsensitive });
}

/** Options for {@link normalizeRelPath}. */
export interface NormalizeOptions {
  /** Allow `.git` segments (callers that classify them as `vcs_internal` themselves). Default false. */
  readonly allowGitSegment?: boolean;
}

function invalidPath(message: string, code: string) {
  return err(errors.validationFailed([{ path: 'relPath', message, code }]));
}

/**
 * Normalizes user- or diff-supplied text into a {@link RelPath} (05 E1). Rejects empty, absolute (POSIX, win32 drive,
 * UNC), NUL, any `..` segment, and `.git` segments unless allowed; converts `\` to `/`, strips leading `./`, and applies
 * `path.posix.normalize`. The final check is the contracts `relPathSchema`, so the rules are not duplicated.
 */
export function normalizeRelPath(input: string, opts: NormalizeOptions = {}): Result<RelPath> {
  if (input.length === 0) return invalidPath('The path is empty.', 'empty');
  if (input.includes('\0')) return invalidPath('The path contains a NUL byte.', 'nul');
  if (/^[A-Za-z]:/.test(input) || input.startsWith('/') || input.startsWith('\\')) {
    return invalidPath('The path must be relative to the project folder.', 'absolute');
  }
  const slashed = input.replaceAll('\\', '/');
  if (slashed.split('/').includes('..')) {
    return invalidPath('The path must not contain "..".', 'dot_dot');
  }
  let normalized = path.posix.normalize(slashed);
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (normalized === '' || normalized === '.') return invalidPath('The path is empty.', 'empty');
  if (opts.allowGitSegment !== true && normalized.split('/').some((seg) => seg.toLowerCase() === '.git')) {
    return invalidPath('Paths inside .git are not allowed.', 'vcs_internal');
  }
  const parsed = relPathBrand.safeParse(normalized);
  if (!parsed.success) return err(errors.validationFailed(toValidationIssues(parsed.error.issues)));
  return ok(parsed.data);
}

/**
 * Resolves `rel` under `root` and verifies containment after resolving ALL symlinks (symlink escape defense, §11.2).
 * Returns `NOT_FOUND` when the path does not exist and `PERMISSION_DENIED { reason: 'outside_root' }` when it escapes.
 * Error messages never include absolute paths.
 */
export async function resolveInside(root: ProjectRoot, rel: RelPath): Promise<Result<{ abs: string; real: string }>> {
  const abs = path.join(root.realpath, rel);
  let real: string;
  try {
    real = await fs.promises.realpath(abs);
  } catch (e) {
    if (isErrno(e, 'ELOOP')) return err(errors.permissionDenied('outside_root', { details: { relPath: rel } }));
    return err(errors.notFound('file', {}, { details: { relPath: rel } }));
  }
  if (relationOf(root.realpath, real, root.caseInsensitive) !== 'inside') {
    return err(
      errors.permissionDenied('outside_root', {
        userMessage: 'This path points outside the project folder.',
        details: { relPath: rel },
      }),
    );
  }
  return ok({ abs, real });
}

/** Project-relative POSIX form of an already-contained real path. */
export function realRelPath(root: ProjectRoot, real: string): string {
  return path.relative(root.realpath, real).split(path.sep).join('/');
}

/** Result of {@link readConfined}. */
export interface ConfinedRead {
  readonly bytes: Uint8Array;
  readonly size: number;
  /** Real path (internal use only; never put into user-facing errors). */
  readonly real: string;
}

async function readHandle(fh: fs.promises.FileHandle, size: number): Promise<Uint8Array> {
  const buf = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await fh.read(buf, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, offset);
}

/**
 * Reads a confined file (05 E1): resolve → `open(real, O_RDONLY | O_NOFOLLOW)` → `fstat` (regular file, size ≤
 * `maxBytes`) → read from the same handle. One handle for check and read narrows the TOCTOU window; hard links and a
 * parent swapped between realpath and open remain undetectable (documented; this is not an OS sandbox, §6.5).
 */
export async function readConfined(root: ProjectRoot, rel: RelPath, maxBytes: number): Promise<Result<ConfinedRead>> {
  const resolved = await resolveInside(root, rel);
  if (!resolved.ok) return resolved;
  const { real } = resolved.value;
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if (isErrno(e, 'ELOOP')) return err(errors.permissionDenied('outside_root', { details: { relPath: rel } }));
    return err(errors.notFound('file', {}, { details: { relPath: rel } }));
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      return err(errors.permissionDenied('excluded', { details: { relPath: rel, exclusion: 'not_regular_file' } }));
    }
    if (st.size > maxBytes) {
      return err(errors.permissionDenied('excluded', { details: { relPath: rel, exclusion: 'too_large' } }));
    }
    const bytes = await readHandle(fh, st.size);
    return ok({ bytes, size: bytes.byteLength, real });
  } finally {
    await fh.close();
  }
}
