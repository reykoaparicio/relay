import fs from 'node:fs';
import path from 'node:path';
import type { Ignore } from 'ignore';
import type { ExclusionReason, RelPath, Result, Sha256 } from '@relay/contracts';
import { INPUT_CAPS, assertNever, err, errors, ok } from '@relay/contracts';
import type { ClassifyContext, Sniff } from './exclusions.js';
import { SNIFF_BYTES, classifyByContent, classifyByName, compileUserPatterns, sniffBytes } from './exclusions.js';
import { loadGitignore, makeGitignoreMatcher } from './gitignore.js';
import type { ProjectRoot } from './paths.js';
import { isSecretRootPath, normalizeRelPath, realRelPath, resolveInside } from './paths.js';

/** Input caps used by scan and read (defaults: contracts `INPUT_CAPS`). */
export interface InputCaps {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
}

/** One included file in a scan preview. `sha256` is filled lazily by `hashFiles`, never during preview. */
export interface FileEntry {
  readonly relPath: RelPath;
  readonly size: number;
  readonly sha256?: Sha256;
}

/** One excluded entry; an excluded directory is collapsed into one row and never descended into. */
export interface ExcludedEntry {
  readonly relPath: string;
  readonly reason: ExclusionReason;
  readonly isDirectory: boolean;
}

/** Scan totals (included files and bytes count toward the caps). */
export interface ScanTotals {
  readonly includedFiles: number;
  readonly includedBytes: number;
  readonly excludedEntries: number;
}

/** Output of {@link scanProject}, sorted by relPath. */
export interface ScanResult {
  readonly included: readonly FileEntry[];
  readonly excluded: readonly ExcludedEntry[];
  /**
   * Entries that exist but could not be read or stat'ed (EACCES, vanished mid-scan, …): neither included nor excluded
   * (contracts `EXCLUSION_REASONS` has no fitting reason). Never selectable; never contains absolute paths (B7).
   */
  readonly unreadable: readonly RelPath[];
  readonly totals: ScanTotals;
}

/** Options for {@link scanProject}. */
export interface ScanOptions {
  readonly exclusions?: readonly string[];
  readonly respectGitignore?: boolean;
  readonly caps?: InputCaps;
  /** Aborting throws the signal's reason (caller-initiated cancellation, not an expected failure). */
  readonly signal?: AbortSignal;
}

type Inspected =
  | { readonly kind: 'excluded'; readonly relPath: string; readonly reason: ExclusionReason; readonly isDirectory: boolean }
  | { readonly kind: 'dir'; readonly dir: QueuedDir }
  | { readonly kind: 'file'; readonly relPath: RelPath; readonly size: number; readonly sniff: Sniff; readonly utf8: boolean }
  | { readonly kind: 'unreadable'; readonly relPath: string }
  | { readonly kind: 'skip' };

/** A directory to list: `disk` is the on-disk spelling (for fs calls), `rel` its NFC RelPath form (for classification). */
interface QueuedDir {
  readonly disk: string;
  readonly rel: string;
}

const SKIP: Inspected = { kind: 'skip' };
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * The NFC relPath as a RelPath, or null when the RelPath rules cannot express it exactly (e.g. a name containing `\`,
 * which normalization would turn into a different path): such entries are not selectable and are skipped.
 */
function asExactRelPath(relPath: string): RelPath | null {
  const rel = normalizeRelPath(relPath);
  return rel.ok && rel.value === relPath ? rel.value : null;
}

function errnoOf(e: unknown): string | undefined {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
}

/** Vanished or swapped mid-scan: nothing to show. Anything else (EACCES, EPERM, EIO, …) is reported as unreadable. */
function isGone(e: unknown): boolean {
  const code = errnoOf(e);
  return code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR';
}

interface FileProbe {
  readonly size: number;
  readonly sniff: Sniff;
  /** Whole-file UTF-8 validity for files within the cap; `true` for over-cap files (they are `too_large` anyway). */
  readonly utf8: boolean;
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    utf8Decoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens a regular file without following a final symlink and probes it from ONE handle: `fstat` size, the binary
 * sniff, and — for files within `maxFileBytes` — a fatal UTF-8 decode of the whole file, so the preview agrees with
 * `readSelected` (invalid UTF-8 → `binary`, B8). Returns null for a non-regular file.
 */
async function probeFile(abs: string, maxFileBytes: number): Promise<FileProbe | null> {
  const fh = await fs.promises.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const want = st.size <= maxFileBytes ? st.size : Math.min(st.size, SNIFF_BYTES);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, want - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    const bytes = buf.subarray(0, got);
    return { size: st.size, sniff: sniffBytes(bytes), utf8: st.size > maxFileBytes || isValidUtf8(bytes) };
  } finally {
    await fh.close();
  }
}

async function inspectFile(relPath: string, abs: string, ctx: ClassifyContext, realRel?: string): Promise<Inspected> {
  const byName = classifyByName(relPath, false, ctx) ?? (realRel === undefined ? null : classifyByName(realRel, false, ctx));
  if (byName !== null) return { kind: 'excluded', relPath, reason: byName, isDirectory: false };
  const rel = asExactRelPath(relPath);
  if (rel === null) return SKIP;
  const probe = await probeFile(abs, ctx.maxFileBytes);
  if (probe === null) return SKIP;
  return { kind: 'file', relPath: rel, ...probe };
}

/** Symlinked files are resolved and checked by E1; directory symlinks are never followed. */
async function inspectSymlink(root: ProjectRoot, relPath: string, ctx: ClassifyContext): Promise<Inspected> {
  const rel = asExactRelPath(relPath);
  if (rel === null) return SKIP;
  const resolved = await resolveInside(root, rel);
  if (!resolved.ok) {
    return resolved.error.code === 'PERMISSION_DENIED'
      ? { kind: 'excluded', relPath, reason: 'symlink_outside', isDirectory: false }
      : SKIP; // dangling link: nothing to read
  }
  const st = await fs.promises.stat(resolved.value.real);
  if (!st.isFile()) return SKIP;
  return inspectFile(relPath, resolved.value.real, ctx, realRelPath(root, resolved.value.real));
}

async function inspectEntry(root: ProjectRoot, dirent: fs.Dirent, parent: QueuedDir, ctx: ClassifyContext): Promise<Inspected> {
  // The on-disk name drives fs access; its NFC form drives classification and output (B3).
  const disk = parent.disk === '' ? dirent.name : `${parent.disk}/${dirent.name}`;
  const nfcName = dirent.name.normalize('NFC');
  const relPath = parent.rel === '' ? nfcName : `${parent.rel}/${nfcName}`;
  try {
    const abs = path.join(root.realpath, disk);
    if (dirent.isSymbolicLink()) return await inspectSymlink(root, relPath, ctx);
    if (dirent.isDirectory()) {
      const reason = classifyByName(relPath, true, ctx);
      return reason === null ? { kind: 'dir', dir: { disk, rel: relPath } } : { kind: 'excluded', relPath, reason, isDirectory: true };
    }
    if (dirent.isFile()) return await inspectFile(relPath, abs, ctx);
    return SKIP; // sockets, FIFOs, devices
  } catch (e) {
    // Never throw on one bad entry (B7): permission errors are listed, vanished entries dropped.
    return isGone(e) ? SKIP : { kind: 'unreadable', relPath };
  }
}

async function listDir(abs: string): Promise<fs.Dirent[]> {
  const dir = await fs.promises.opendir(abs);
  const out: fs.Dirent[] = [];
  for await (const d of dir) out.push(d);
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const byRelPath = (a: { relPath: string }, b: { relPath: string }): number =>
  a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;

/** Mutable builder local to one scan. */
interface ScanState {
  readonly included: FileEntry[];
  readonly excluded: ExcludedEntry[];
  readonly unreadable: RelPath[];
  readonly queue: QueuedDir[];
  includedBytes: number;
}

function addUnreadable(state: ScanState, relPath: string): void {
  const rel = asExactRelPath(relPath);
  if (rel !== null) state.unreadable.push(rel);
}

function applyInspected(item: Inspected, state: ScanState, ctx: ClassifyContext, caps: InputCaps): void {
  switch (item.kind) {
    case 'skip':
      return;
    case 'dir':
      state.queue.push(item.dir);
      return;
    case 'unreadable':
      addUnreadable(state, item.relPath);
      return;
    case 'excluded':
      state.excluded.push({ relPath: item.relPath, reason: item.reason, isDirectory: item.isDirectory });
      return;
    case 'file': {
      const totals = { ...caps, includedBytes: state.includedBytes, includedFiles: state.included.length };
      const reason =
        classifyByContent({ isDirectory: false, size: item.size }, item.sniff, { ...ctx, caps: totals }) ??
        (item.utf8 ? null : 'binary'); // invalid UTF-8 is binary, exactly as readSelected decides (05 E4, B8)
      if (reason !== null) {
        state.excluded.push({ relPath: item.relPath, reason, isDirectory: false });
        return;
      }
      state.included.push({ relPath: item.relPath, size: item.size });
      state.includedBytes += item.size;
      return;
    }
    default:
      assertNever(item);
  }
}

/**
 * Previews a project (FR-01, §3.4): iterative breadth-first walk with `opendir`. Excluded directories are never
 * descended into (keeps `node_modules` fast); directory symlinks are not followed; symlinked files are confined by E1.
 * Cap overflow is listed as `cap_exceeded`, never silently dropped. Per-entry fs errors never throw: such entries are
 * listed in `unreadable` (B7). Only an unreadable root is an error (`NOT_FOUND` / `PERMISSION_DENIED`).
 */
export async function scanProject(root: ProjectRoot, opts: ScanOptions = {}): Promise<Result<ScanResult>> {
  const caps = opts.caps ?? INPUT_CAPS;
  const isUserExcluded = compileUserPatterns(opts.exclusions ?? []);
  const gitRules = new Map<string, Ignore>();
  let ctx: ClassifyContext = { maxFileBytes: caps.maxFileBytes, isUserExcluded, rootIsSecret: isSecretRootPath(root.realpath) };
  const state: ScanState = { included: [], excluded: [], unreadable: [], queue: [{ disk: '', rel: '' }], includedBytes: 0 };
  while (state.queue.length > 0) {
    opts.signal?.throwIfAborted();
    const dir = state.queue.shift() ?? { disk: '', rel: '' };
    let dirents: fs.Dirent[];
    try {
      dirents = await listDir(path.join(root.realpath, dir.disk));
    } catch (e) {
      if (dir.disk === '') {
        return errnoOf(e) === 'ENOENT'
          ? err(errors.notFound('project_root'))
          : err(errors.permissionDenied('unsafe_root', { userMessage: 'The project folder cannot be read. Check its permissions.' }));
      }
      if (!isGone(e)) addUnreadable(state, dir.rel);
      continue;
    }
    if (opts.respectGitignore !== false) {
      const ig = await loadGitignore(root, dir.disk);
      if (ig !== null) {
        gitRules.set(dir.rel, ig);
        ctx = { ...ctx, isGitignored: makeGitignoreMatcher(gitRules) };
      }
    }
    const itemCtx = ctx;
    const items = await Promise.all(dirents.map((d) => inspectEntry(root, d, dir, itemCtx)));
    for (const item of items) applyInspected(item, state, ctx, caps);
  }
  const included = [...state.included].sort(byRelPath);
  const excluded = [...state.excluded].sort(byRelPath);
  const unreadable = [...state.unreadable].sort();
  return ok({
    included,
    excluded,
    unreadable,
    totals: { includedFiles: included.length, includedBytes: state.includedBytes, excludedEntries: excluded.length },
  });
}
