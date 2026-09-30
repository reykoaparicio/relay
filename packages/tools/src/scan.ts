import fs from 'node:fs';
import path from 'node:path';
import type { Ignore } from 'ignore';
import type { ExclusionReason, RelPath, Result, Sha256 } from '@relay/contracts';
import { INPUT_CAPS, assertNever, ok } from '@relay/contracts';
import type { ClassifyContext, Sniff } from './exclusions.js';
import { SNIFF_BYTES, classifyByContent, classifyByName, compileUserPatterns, sniffBytes } from './exclusions.js';
import { loadGitignore, makeGitignoreMatcher } from './gitignore.js';
import type { ProjectRoot } from './paths.js';
import { normalizeRelPath, realRelPath, resolveInside } from './paths.js';

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
  | { readonly kind: 'dir'; readonly relPath: string }
  | { readonly kind: 'file'; readonly relPath: RelPath; readonly size: number; readonly sniff: Sniff }
  | { readonly kind: 'skip' };

const SKIP: Inspected = { kind: 'skip' };

/**
 * The on-disk name as a RelPath, or null when the RelPath rules cannot express it exactly (e.g. a name containing
 * `\`, which normalization would turn into a different path): such entries are not selectable and are skipped.
 */
function asExactRelPath(relPath: string): RelPath | null {
  const rel = normalizeRelPath(relPath);
  return rel.ok && rel.value === relPath ? rel.value : null;
}

/** Reads at most {@link SNIFF_BYTES} from a regular file without following a final symlink. */
async function readHead(abs: string): Promise<Uint8Array | null> {
  try {
    const fh = await fs.promises.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const buf = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function inspectFile(relPath: string, abs: string, ctx: ClassifyContext, realRel?: string): Promise<Inspected> {
  const byName = classifyByName(relPath, false, ctx) ?? (realRel === undefined ? null : classifyByName(realRel, false, ctx));
  if (byName !== null) return { kind: 'excluded', relPath, reason: byName, isDirectory: false };
  const rel = asExactRelPath(relPath);
  if (rel === null) return SKIP;
  const [st, head] = await Promise.all([fs.promises.stat(abs).catch(() => null), readHead(abs)]);
  if (st === null || head === null || !st.isFile()) return SKIP;
  return { kind: 'file', relPath: rel, size: st.size, sniff: sniffBytes(head) };
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

async function inspectEntry(root: ProjectRoot, dirent: fs.Dirent, relPath: string, ctx: ClassifyContext): Promise<Inspected> {
  const abs = path.join(root.realpath, relPath);
  if (dirent.isSymbolicLink()) return inspectSymlink(root, relPath, ctx);
  if (dirent.isDirectory()) {
    const reason = classifyByName(relPath, true, ctx);
    return reason === null ? { kind: 'dir', relPath } : { kind: 'excluded', relPath, reason, isDirectory: true };
  }
  if (dirent.isFile()) return inspectFile(relPath, abs, ctx);
  return SKIP; // sockets, FIFOs, devices
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
  readonly queue: string[];
  includedBytes: number;
}

function applyInspected(item: Inspected, state: ScanState, ctx: ClassifyContext, caps: InputCaps): void {
  switch (item.kind) {
    case 'skip':
      return;
    case 'dir':
      state.queue.push(item.relPath);
      return;
    case 'excluded':
      state.excluded.push({ relPath: item.relPath, reason: item.reason, isDirectory: item.isDirectory });
      return;
    case 'file': {
      const totals = { ...caps, includedBytes: state.includedBytes, includedFiles: state.included.length };
      const reason = classifyByContent({ isDirectory: false, size: item.size }, item.sniff, { ...ctx, caps: totals });
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
 * Cap overflow is listed as `cap_exceeded`, never silently dropped.
 */
export async function scanProject(root: ProjectRoot, opts: ScanOptions = {}): Promise<Result<ScanResult>> {
  const caps = opts.caps ?? INPUT_CAPS;
  const isUserExcluded = compileUserPatterns(opts.exclusions ?? []);
  const gitRules = new Map<string, Ignore>();
  let ctx: ClassifyContext = { maxFileBytes: caps.maxFileBytes, isUserExcluded };
  const state: ScanState = { included: [], excluded: [], queue: [''], includedBytes: 0 };
  while (state.queue.length > 0) {
    opts.signal?.throwIfAborted();
    const dirRel = state.queue.shift() ?? '';
    if (opts.respectGitignore !== false) {
      const ig = await loadGitignore(root, dirRel);
      if (ig !== null) {
        gitRules.set(dirRel, ig);
        ctx = { ...ctx, isGitignored: makeGitignoreMatcher(gitRules) };
      }
    }
    const dirents = await listDir(path.join(root.realpath, dirRel));
    const itemCtx = ctx;
    const items = await Promise.all(
      dirents.map((d) => inspectEntry(root, d, dirRel === '' ? d.name : `${dirRel}/${d.name}`, itemCtx)),
    );
    for (const item of items) applyInspected(item, state, ctx, caps);
  }
  const included = [...state.included].sort(byRelPath);
  const excluded = [...state.excluded].sort(byRelPath);
  return ok({
    included,
    excluded,
    totals: { includedFiles: included.length, includedBytes: state.includedBytes, excludedEntries: excluded.length },
  });
}
