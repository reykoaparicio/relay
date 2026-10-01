import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExclusionReason, RelPath, Result } from '@relay/contracts';
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

/**
 * System directories that can never be a project root, contain one, or be contained by one (05 E1; 08 applies the same
 * list main-side): a root equal to, inside, or an ancestor of any of these is refused.
 */
const SYSTEM_DIRS = ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private/etc'] as const;
/**
 * Directories that may CONTAIN a valid root (e.g. `os.tmpdir()` lives under `/private/var`, `/Volumes/x/code` is a
 * normal project) but may never be a root themselves nor be contained by one: a root equal to or an ancestor of these
 * is refused (B5).
 */
const CONTAINER_DIRS = ['/private', '/private/var', '/opt', '/Volumes', '/Users'] as const;
/**
 * Credential directories (B4). A root whose realpath passes through one of these is refused, and every classification
 * under such a root is `secret` (defense in depth). Multi-segment entries match consecutive segments.
 */
export const SECRET_ROOT_SEGMENTS: readonly (readonly string[])[] = [
  ['.aws'],
  ['.ssh'],
  ['.gnupg'],
  ['keychains'],
  ['.config', 'gcloud'],
  ['.kube'],
  ['.docker'],
];

/** True when `absPath` has a credential-directory segment run (case-insensitive, NFC). */
export function isSecretRootPath(absPath: string): boolean {
  const segments = absPath
    .normalize('NFC')
    .toLowerCase()
    .split(/[\\/]/)
    .filter((s) => s.length > 0);
  return SECRET_ROOT_SEGMENTS.some((run) =>
    segments.some((_, i) => run.every((seg, j) => segments[i + j] === seg)),
  );
}

/**
 * Pure containment test using `path.relative`, never a string prefix (§11.2). Both inputs must be absolute and already
 * canonical (realpath'd). With `caseInsensitive`, both are compared lowercased.
 */
export function relationOf(parent: string, child: string, caseInsensitive: boolean): PathRelation {
  // APFS is normalization-insensitive: compare NFC forms so an NFD spelling cannot dodge containment (B3).
  const p = caseInsensitive ? parent.normalize('NFC').toLowerCase() : parent.normalize('NFC');
  const c = caseInsensitive ? child.normalize('NFC').toLowerCase() : child.normalize('NFC');
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

async function isUnsafeRoot(real: string, caseInsensitive: boolean, userDataDir: string, homeDir: string): Promise<boolean> {
  if (path.parse(real).root === real) return true;
  if (isSecretRootPath(real)) return true;
  const [home, userData, systemDirs, containerDirs] = await Promise.all([
    realpathOrResolve(homeDir),
    realpathOrResolve(userDataDir),
    Promise.all(SYSTEM_DIRS.map(realpathOrResolve)),
    Promise.all(CONTAINER_DIRS.map(realpathOrResolve)),
  ]);
  const homeLibrary = path.join(home, 'Library');
  const rel = (parent: string, child: string) => relationOf(parent, child, caseInsensitive);
  // Never-inside dirs: the root may not equal, contain, or sit inside them.
  const sealed = [userData, homeLibrary, ...SYSTEM_DIRS, ...systemDirs];
  if (sealed.some((dir) => rel(real, dir) !== 'outside' || rel(dir, real) !== 'outside')) return true;
  // Container dirs (and the home dir): the root may sit inside them but may not equal or contain them.
  const containers = [home, ...CONTAINER_DIRS, ...containerDirs];
  return containers.some((dir) => rel(real, dir) !== 'outside');
}

/** Options for {@link openProjectRoot}. */
export interface OpenRootOptions {
  readonly userDataDir: string;
  /** The user's home dir; defaults to `os.homedir()` (overridable for tests). */
  readonly homeDir?: string;
}

/**
 * Opens a project root (§11.2, 05 E1): realpath, must be a directory, and must not be an unsafe root: '/', the home
 * dir or any ancestor of it, `~/Library` (and anything inside it, e.g. Keychains), the userData dir or anything
 * inside/containing it, system dirs (equal, inside, or containing), `/private`, `/private/var`, `/opt`, `/Volumes`
 * (equal or containing), and any path through a credential directory (`.aws`, `.ssh`, `.gnupg`, `Keychains`,
 * `.config/gcloud`, `.kube`, `.docker`). Subdirectories of `os.tmpdir()` and e.g. `~/code/x` are valid roots. This is
 * the runner-side re-check of 08 `pickDirectory`.
 */
export async function openProjectRoot(absPath: string, opts: OpenRootOptions): Promise<Result<ProjectRoot>> {
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
  const st = await fs.promises.stat(real).catch(() => null);
  if (st === null) return err(errors.notFound('project_root'));
  if (!st.isDirectory()) {
    return err(errors.validationFailed([{ path: 'rootPath', message: 'The project path is not a folder.', code: 'not_directory' }]));
  }
  const caseInsensitive = await detectCaseInsensitive(real);
  if (await isUnsafeRoot(real, caseInsensitive, opts.userDataDir, opts.homeDir ?? os.homedir())) {
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
 * Normalizes user- or diff-supplied text into an NFC {@link RelPath} (05 E1). Rejects empty, absolute (POSIX, win32 drive,
 * UNC), NUL, any `..` segment, and `.git` segments unless allowed; converts `\` to `/`, strips leading `./`, and applies
 * `path.posix.normalize`. The final check is the contracts `relPathSchema`, so the rules are not duplicated.
 */
export function normalizeRelPath(rawInput: string, opts: NormalizeOptions = {}): Result<RelPath> {
  // NFC first: every RelPath is NFC so classification, patterns, and dedupe see one spelling (B3). APFS is
  // normalization-insensitive, so fs calls with the NFC form still find an NFD-named file.
  const input = rawInput.normalize('NFC');
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

/** Project-relative POSIX form of an already-contained real path (NFC, like every RelPath). */
export function realRelPath(root: ProjectRoot, real: string): string {
  return path.relative(root.realpath, real).split(path.sep).join('/').normalize('NFC');
}

/**
 * Where a not-yet-existing path (a diff add) would land (B2): the nearest existing ancestor is resolved with realpath
 * (a symlinked or dangling ancestor is followed, never skipped), must be inside or equal to the root, and the missing
 * segments are appended. Returns the would-be real path, or `PERMISSION_DENIED outside_root` on an escape or an
 * ancestor that exists but cannot be resolved. Existing paths should use {@link resolveInside}.
 */
export async function resolveWouldBe(root: ProjectRoot, rel: RelPath): Promise<Result<{ real: string }>> {
  const segments = rel.split('/');
  const denied = err(
    errors.permissionDenied('outside_root', {
      userMessage: 'This path points outside the project folder.',
      details: { relPath: rel },
    }),
  );
  for (let i = segments.length; i >= 0; i -= 1) {
    const ancestor = path.join(root.realpath, ...segments.slice(0, i));
    try {
      await fs.promises.lstat(ancestor);
    } catch (e) {
      if (isErrno(e, 'ENOENT')) continue;
      return denied;
    }
    let ancestorReal: string;
    try {
      ancestorReal = await fs.promises.realpath(ancestor);
    } catch {
      return denied; // exists but cannot be resolved (dangling or looping symlink): never guess where it points
    }
    if (relationOf(root.realpath, ancestorReal, root.caseInsensitive) === 'outside') return denied;
    const wouldBe = path.join(ancestorReal, ...segments.slice(i));
    if (relationOf(root.realpath, wouldBe, root.caseInsensitive) !== 'inside') return denied;
    return ok({ real: wouldBe });
  }
  return denied; // the root itself vanished
}

/** Result of {@link readConfined}. */
export interface ConfinedRead {
  readonly bytes: Uint8Array;
  readonly size: number;
  /** Real path (internal use only; never put into user-facing errors). */
  readonly real: string;
}

/**
 * Classifies the project-relative real path that is about to be (and, after the identity check, actually was) opened.
 * Returning a reason denies the read with `PERMISSION_DENIED excluded` and `details.exclusion = reason`.
 */
export type RealPathCheck = (realRelPath: string) => ExclusionReason | null;

/** Test-only hooks for forcing interleavings in {@link readConfined} (never set in production code). */
export interface ConfinedReadHooks {
  afterResolve?: (real: string) => Promise<void> | void;
  afterOpen?: (real: string) => Promise<void> | void;
}
/** Mutable test hook slot; production code never assigns it. */
export const confinedReadHooks: ConfinedReadHooks = {};

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

function excluded(rel: RelPath, exclusion: string) {
  return err(errors.permissionDenied('excluded', { details: { relPath: rel, exclusion } }));
}

/**
 * After `open`, prove the handle is the file that was classified (B1): the real path must still resolve to itself (no
 * symlink swapped into any component since resolution) and `lstat(real)` must be the same inode (dev + ino) as
 * `fstat(fd)`. A swap before the open is caught by the realpath comparison or the inode mismatch; a swap after the
 * open is caught by the inode mismatch. Hard links remain undetectable (documented; not an OS sandbox, §6.5).
 */
async function verifyIdentity(root: ProjectRoot, real: string, st: fs.Stats): Promise<boolean> {
  try {
    const again = await fs.promises.realpath(real);
    if (relationOf(real, again, root.caseInsensitive) !== 'equal') return false;
    if (relationOf(root.realpath, again, root.caseInsensitive) !== 'inside') return false;
    const lst = await fs.promises.lstat(real);
    return lst.isFile() && lst.dev === st.dev && lst.ino === st.ino;
  } catch {
    return false;
  }
}

/**
 * Reads a confined file (05 E1, B1): resolve ONCE → classify the real path (`check`) → `open(real, O_RDONLY |
 * O_NOFOLLOW | O_NONBLOCK)` → `fstat` (regular file, size ≤ `maxBytes`) → identity check (see {@link verifyIdentity})
 * → read from the same handle. The path is never re-resolved between classification and open, so a symlink swapped
 * in between cannot redirect the read to an unclassified file. Any mismatch denies (`exclusion: 'changed_during_read'`).
 */
export async function readConfined(
  root: ProjectRoot,
  rel: RelPath,
  maxBytes: number,
  check?: RealPathCheck,
): Promise<Result<ConfinedRead>> {
  const resolved = await resolveInside(root, rel);
  if (!resolved.ok) return resolved;
  const { real } = resolved.value;
  const reason = check?.(realRelPath(root, real)) ?? null;
  if (reason !== null) return excluded(rel, reason);
  await confinedReadHooks.afterResolve?.(real);
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    if (isErrno(e, 'ELOOP')) return err(errors.permissionDenied('outside_root', { details: { relPath: rel } }));
    return err(errors.notFound('file', {}, { details: { relPath: rel } }));
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return excluded(rel, 'not_regular_file');
    await confinedReadHooks.afterOpen?.(real);
    if (!(await verifyIdentity(root, real, st))) return excluded(rel, 'changed_during_read');
    if (st.size > maxBytes) return excluded(rel, 'too_large');
    const bytes = await readHandle(fh, st.size);
    return ok({ bytes, size: bytes.byteLength, real });
  } catch {
    return err(errors.notFound('file', {}, { details: { relPath: rel } }));
  } finally {
    await fh.close();
  }
}
