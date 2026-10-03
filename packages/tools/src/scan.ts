import { isUtf8 } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import type { AppError, ExclusionReason, RelPath, Result, Sha256 } from '@relay/contracts';
import { INPUT_CAPS, assertNever, err, errnoDetails, errnoOf, errors, ok } from '@relay/contracts';
import type { ClassifyContext, Sniff } from './exclusions.js';
import { SNIFF_BYTES, classifyByContent, classifyByName, compileUserPatterns, sniffBytes } from './exclusions.js';
import { createIncrementalGitignore, loadGitignore } from './gitignore.js';
import { sha256Hex } from './hash.js';
import type { ProjectRoot } from './paths.js';
import { isSecretRootPath, normalizeRelPath, realRelPath, resolveInside } from './paths.js';
import type { SuspectedSecret } from './secret-scan.js';
import { detectSuspectedSecret } from './secret-scan.js';

/** Input caps used by scan and read (defaults: contracts `INPUT_CAPS`). */
export interface InputCaps {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
}

/**
 * One included file in a scan preview. `sha256` is filled lazily by `hashFiles` — except for a suspected secret, whose
 * bytes the preview already read: it carries their hash (round-3 M4: what a confirmation to send it is bound to).
 */
export interface FileEntry {
  readonly relPath: RelPath;
  readonly size: number;
  readonly sha256?: Sha256;
  /** E2 #11: the content looks like a credential (label + line only). Shown, but not selected by default. */
  readonly suspectedSecret?: SuspectedSecret;
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
  /** Run the E2 #11 content check on every included text file (default true). */
  readonly detectSecrets?: boolean;
}

type Inspected =
  | { readonly kind: 'excluded'; readonly relPath: string; readonly reason: ExclusionReason; readonly isDirectory: boolean }
  | { readonly kind: 'dir'; readonly dir: QueuedDir }
  | { readonly kind: 'file'; readonly relPath: RelPath; readonly abs: string; readonly probe: FileProbe }
  | { readonly kind: 'unreadable'; readonly relPath: string }
  | { readonly kind: 'skip' };

/** A directory to list: `disk` is the on-disk spelling (for fs calls), `rel` its NFC RelPath form (for classification). */
interface QueuedDir {
  readonly disk: string;
  readonly rel: string;
}

const SKIP: Inspected = { kind: 'skip' };
/** At most this many entries of one directory are inspected (opened) concurrently: bounds open file handles. */
const DIR_FAN_OUT = 64;
const GITIGNORE = '.gitignore';

/**
 * The NFC relPath as a RelPath, or null when the RelPath rules cannot express it exactly (e.g. a name containing `\`,
 * which normalization would turn into a different path): such entries are not selectable and are skipped.
 */
function asExactRelPath(relPath: string): RelPath | null {
  const rel = normalizeRelPath(relPath);
  return rel.ok && rel.value === relPath ? rel.value : null;
}

/** Vanished or swapped mid-scan: nothing to show. Anything else (EACCES, EPERM, EIO, …) is reported as unreadable. */
function isGone(e: unknown): boolean {
  const code = errnoOf(e);
  return code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR';
}

interface FileProbe {
  readonly size: number;
  readonly sniff: Sniff;
  /** Hard-link count (E2 #13: > 1 is refused). */
  readonly nlink: number;
  /** The whole file, when the sniff window already holds it (reused by the content check). */
  readonly bytes?: Buffer;
  /**
   * Whole-file UTF-8 validity when the sniff window already holds the whole file; `undefined` when only a prefix was
   * read (decided later, only for files the caps admit: {@link isUtf8File}).
   */
  readonly utf8?: boolean;
}

const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/** Reads up to `want` bytes from the start of an open file. */
async function readPrefix(fh: fs.promises.FileHandle, want: number): Promise<Buffer> {
  const buf = Buffer.alloc(want);
  let got = 0;
  while (got < want) {
    const { bytesRead } = await fh.read(buf, got, want - got, got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

/**
 * Opens a regular file without following a final symlink and probes it from ONE handle: `fstat` size and the binary
 * sniff of the first {@link SNIFF_BYTES}. Returns null for a non-regular file.
 */
async function probeFile(abs: string): Promise<FileProbe | null> {
  const fh = await fs.promises.open(abs, OPEN_FLAGS);
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const bytes = await readPrefix(fh, Math.min(st.size, SNIFF_BYTES));
    const whole = bytes.byteLength === st.size;
    return { size: st.size, nlink: st.nlink, sniff: sniffBytes(bytes), ...(whole ? { utf8: isUtf8(bytes), bytes } : {}) };
  } finally {
    await fh.close();
  }
}

/** The first `size` bytes (the probed size) of a file the caps admit (UTF-8 validity and the content check). */
async function readWhole(abs: string, size: number): Promise<Buffer> {
  const fh = await fs.promises.open(abs, OPEN_FLAGS);
  try {
    return await readPrefix(fh, size);
  } finally {
    await fh.close();
  }
}

async function inspectFile(relPath: string, abs: string, ctx: ClassifyContext, realRel?: string): Promise<Inspected> {
  // The real name of a symlinked file was never vetted by the walk: classify it with every prefix.
  const byName = classifyByName(relPath, false, ctx) ?? (realRel === undefined ? null : classifyByName(realRel, false, { ...ctx, ancestorsVetted: false }));
  if (byName !== null) return { kind: 'excluded', relPath, reason: byName, isDirectory: false };
  const rel = asExactRelPath(relPath);
  if (rel === null) return SKIP;
  const probe = await probeFile(abs);
  if (probe === null) return SKIP;
  if (probe.nlink > 1) return { kind: 'excluded', relPath, reason: 'hard_link', isDirectory: false };
  return { kind: 'file', relPath: rel, abs, probe };
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

/** `.gitignore`, as the volume spells it (a case-insensitive volume also opens `.GITIGNORE` by that path). */
function isGitignoreName(name: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? name.toLowerCase() === GITIGNORE : name === GITIGNORE;
}

/** `fn` over `items` with at most `limit` in flight; results in input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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
  /** Breadth-first queue; `head` is the next index (no O(n) `shift`). */
  readonly queue: QueuedDir[];
  head: number;
  includedBytes: number;
}

function addUnreadable(state: ScanState, relPath: string): void {
  const rel = asExactRelPath(relPath);
  if (rel !== null) state.unreadable.push(rel);
}

type FileVerdict =
  | { readonly reason: ExclusionReason }
  | { readonly reason: null; readonly suspectedSecret: SuspectedSecret | null; readonly sha256?: Sha256 };

/**
 * The content verdict of a probed file: binary sniff → too_large → caps; then UTF-8 validity (read only if admitted);
 * then, for an included text file, the E2 #11 content check (same bytes, no extra read).
 */
async function fileReason(item: Extract<Inspected, { kind: 'file' }>, state: ScanState, ctx: ClassifyContext, caps: InputCaps, detectSecrets: boolean): Promise<FileVerdict> {
  const totals = { ...caps, includedBytes: state.includedBytes, includedFiles: state.included.length };
  const reason = classifyByContent({ isDirectory: false, size: item.probe.size }, item.probe.sniff, { ...ctx, caps: totals });
  if (reason !== null) return { reason };
  // Invalid UTF-8 is binary, exactly as readSelected decides (05 E4, B8). Only admitted files pay for the full read.
  const needBytes = item.probe.utf8 === undefined || detectSecrets;
  const bytes = needBytes ? (item.probe.bytes ?? (await readWhole(item.abs, item.probe.size))) : null;
  const utf8 = item.probe.utf8 ?? (bytes !== null && isUtf8(bytes));
  if (!utf8) return { reason: 'binary' };
  const suspectedSecret = detectSecrets && bytes !== null ? detectSuspectedSecret(bytes.toString('utf8')) : null;
  // Round-3 M4: a flagged file carries the hash of the bytes just checked, so a confirmation to send it can be bound
  // to exactly this content (intake honours it only while the file still has this hash). Only flagged files pay.
  return suspectedSecret === null || bytes === null ? { reason: null, suspectedSecret } : { reason: null, suspectedSecret, sha256: sha256Hex(bytes) };
}

async function applyInspected(item: Inspected, state: ScanState, ctx: ClassifyContext, caps: InputCaps, detectSecrets: boolean): Promise<void> {
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
      let verdict: FileVerdict;
      try {
        verdict = await fileReason(item, state, ctx, caps, detectSecrets);
      } catch (e) {
        // The file vanished or became unreadable between the probe and the UTF-8 read (B7: never throw).
        if (!isGone(e)) addUnreadable(state, item.relPath);
        return;
      }
      if (verdict.reason !== null) {
        state.excluded.push({ relPath: item.relPath, reason: verdict.reason, isDirectory: false });
        return;
      }
      const flagged = verdict.suspectedSecret;
      state.included.push({ relPath: item.relPath, size: item.probe.size,
        ...(flagged === null ? {} : { suspectedSecret: flagged, ...(verdict.sha256 === undefined ? {} : { sha256: verdict.sha256 }) }) });
      state.includedBytes += item.probe.size;
      return;
    }
    default:
      assertNever(item);
  }
}

function unreadableRoot(e: unknown): AppError {
  const code = errnoOf(e);
  return code === 'ENOENT' || code === 'ENOTDIR'
    ? errors.projectRootMissing({ details: errnoDetails(e) }) // E2 #7: moved / renamed / deleted between open and scan
    : errors.permissionDenied('unsafe_root', { userMessage: 'The project folder cannot be read. Check its permissions.', details: errnoDetails(e) });
}

/**
 * Previews a project (FR-01, §3.4): iterative breadth-first walk with `opendir`. Excluded directories are never
 * descended into (keeps `node_modules` fast); directory symlinks are not followed; symlinked files are confined by E1.
 * Cap overflow is listed as `cap_exceeded`, never silently dropped. Per-entry fs errors never throw: such entries are
 * listed in `unreadable` (B7). Only an unreadable root is an error (`PROJECT_ROOT_MISSING` / `PERMISSION_DENIED`).
 * Hard-linked files are excluded (`hard_link`, E2 #13); included text files whose content looks like a credential carry
 * `suspectedSecret` (E2 #11).
 */
export async function scanProject(root: ProjectRoot, opts: ScanOptions = {}): Promise<Result<ScanResult>> {
  const caps = opts.caps ?? INPUT_CAPS;
  const gitignore = opts.respectGitignore === false ? null : createIncrementalGitignore();
  // ancestorsVetted: a directory is only queued after classifyByName passed it, so its entries skip the prefix walk.
  const ctx: ClassifyContext = {
    maxFileBytes: caps.maxFileBytes,
    isUserExcluded: compileUserPatterns(opts.exclusions ?? []),
    rootIsSecret: isSecretRootPath(root.realpath),
    ancestorsVetted: true,
    ...(gitignore === null ? {} : { isGitignored: gitignore.isGitignored }),
  };
  const state: ScanState = { included: [], excluded: [], unreadable: [], queue: [{ disk: '', rel: '' }], head: 0, includedBytes: 0 };
  for (let dir = state.queue[0]; dir !== undefined; dir = state.queue[state.head]) {
    state.head += 1;
    opts.signal?.throwIfAborted();
    let dirents: fs.Dirent[];
    try {
      dirents = await listDir(path.join(root.realpath, dir.disk));
    } catch (e) {
      if (dir.disk === '') return err(unreadableRoot(e));
      if (!isGone(e)) addUnreadable(state, dir.rel);
      continue;
    }
    // Rules of this directory apply to its entries; loaded (through the confined reader) only when the file exists.
    if (gitignore !== null && dirents.some((d) => isGitignoreName(d.name, root.caseInsensitive))) {
      const ig = await loadGitignore(root, dir.disk);
      if (ig !== null) gitignore.add(dir.rel, ig);
    }
    const parent = dir;
    const items = await mapLimit(dirents, DIR_FAN_OUT, (d) => inspectEntry(root, d, parent, ctx));
    for (const item of items) await applyInspected(item, state, ctx, caps, opts.detectSecrets !== false);
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
