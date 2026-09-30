import type { AppError, ExclusionReason, RelPath, Result, Sha256 } from '@relay/contracts';
import { INPUT_CAPS, err, errors, ok } from '@relay/contracts';
import type { ClassifyContext } from './exclusions.js';
import { classifyByContent, classifyByName, compileUserPatterns, sniffBytes } from './exclusions.js';
import { loadGitignoresForPaths, makeGitignoreMatcher } from './gitignore.js';
import { sha256Hex } from './hash.js';
import type { ProjectRoot } from './paths.js';
import { normalizeRelPath, readConfined, realRelPath, resolveInside } from './paths.js';
import type { InputCaps } from './scan.js';

/** Options for {@link readSelected}. */
export interface ReadOptions {
  readonly caps?: InputCaps;
  readonly exclusions?: readonly string[];
  readonly respectGitignore?: boolean;
}

/** One file read at intake. `sha256` is computed over exactly `bytes` (feeds `run_input_files` and the context hash). */
export interface SelectedFile {
  readonly relPath: RelPath;
  readonly content: string;
  readonly bytes: Uint8Array;
  readonly sha256: Sha256;
  readonly size: number;
}

/** Why one selected path was refused. */
export type DenialReason = ExclusionReason | 'outside_root' | 'not_regular_file';

/** One refused path in a `PERMISSION_DENIED` from {@link readSelected}. */
export interface Denial {
  readonly relPath: string;
  readonly reason: DenialReason;
}

type Outcome =
  | { readonly kind: 'file'; readonly file: SelectedFile }
  | { readonly kind: 'denied'; readonly denial: Denial }
  | { readonly kind: 'error'; readonly error: AppError };

function denied(relPath: string, reason: DenialReason): Outcome {
  return { kind: 'denied', denial: { relPath, reason } };
}

function denialFromReadError(relPath: string, e: AppError): Outcome {
  if (e.code !== 'PERMISSION_DENIED') return { kind: 'error', error: e };
  const exclusion = e.details?.['exclusion'];
  if (exclusion === 'too_large') return denied(relPath, 'too_large');
  if (exclusion === 'not_regular_file') return denied(relPath, 'not_regular_file');
  return denied(relPath, 'outside_root');
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/** normalize → resolveInside → classify (requested and resolved names) → readConfined → sniff/decode. */
async function readOne(root: ProjectRoot, rel: RelPath, ctx: ClassifyContext): Promise<Outcome> {
  const byName = classifyByName(rel, false, ctx);
  if (byName !== null) return denied(rel, byName);
  const resolved = await resolveInside(root, rel);
  if (!resolved.ok) return denialFromReadError(rel, resolved.error);
  const byRealName = classifyByName(realRelPath(root, resolved.value.real), false, ctx);
  if (byRealName !== null) return denied(rel, byRealName);
  const read = await readConfined(root, rel, ctx.maxFileBytes);
  if (!read.ok) return denialFromReadError(rel, read.error);
  const { bytes } = read.value;
  const sniffed = classifyByContent({ isDirectory: false, size: bytes.byteLength }, sniffBytes(bytes), ctx);
  if (sniffed !== null) return denied(rel, sniffed);
  const content = decodeUtf8(bytes);
  if (content === null) return denied(rel, 'binary'); // invalid UTF-8 is treated as binary (05 E4)
  return { kind: 'file', file: { relPath: rel, content, bytes, sha256: sha256Hex(bytes), size: bytes.byteLength } };
}

function normalizeAll(relPaths: readonly string[]): Result<RelPath[]> {
  const out: RelPath[] = [];
  for (const p of relPaths) {
    // `.git/…` is allowed through normalization so it is refused below as `vcs_internal` with the other denials.
    const r = normalizeRelPath(p, { allowGitSegment: true });
    if (!r.ok) return r;
    if (!out.includes(r.value)) out.push(r.value);
  }
  return ok(out);
}

async function buildContext(root: ProjectRoot, rels: readonly RelPath[], opts: ReadOptions): Promise<ClassifyContext> {
  const caps = opts.caps ?? INPUT_CAPS;
  const base: ClassifyContext = { maxFileBytes: caps.maxFileBytes, isUserExcluded: compileUserPatterns(opts.exclusions ?? []) };
  if (opts.respectGitignore === false) return base;
  return { ...base, isGitignored: makeGitignoreMatcher(await loadGitignoresForPaths(root, rels)) };
}

function deniedError(denials: readonly Denial[]): AppError {
  const allOutside = denials.every((d) => d.reason === 'outside_root');
  return errors.permissionDenied(allOutside ? 'outside_root' : 'excluded', {
    userMessage: `${String(denials.length)} selected file(s) cannot be read. Nothing was read; see the listed reasons.`,
    details: { denied: denials.map((d) => ({ ...d })) },
  });
}

/**
 * Reads the files a run selected (05 E4). Every path goes through normalize → resolveInside → classify →
 * readConfined; any denial aborts the WHOLE read with `PERMISSION_DENIED` listing every offending relPath and reason
 * (no partial silent reads, §10.2). Content is UTF-8 with `fatal: true`; raw `bytes` are returned for snapshotting.
 */
export async function readSelected(
  root: ProjectRoot,
  relPaths: readonly string[],
  opts: ReadOptions = {},
): Promise<Result<{ files: SelectedFile[] }>> {
  const normalized = normalizeAll(relPaths);
  if (!normalized.ok) return normalized;
  const caps = opts.caps ?? INPUT_CAPS;
  const ctx = await buildContext(root, normalized.value, opts);
  const files: SelectedFile[] = [];
  const denials: Denial[] = [];
  let includedBytes = 0;
  for (const rel of normalized.value) {
    const capsCtx = { ...ctx, caps: { ...caps, includedBytes, includedFiles: files.length } };
    const outcome = await readOne(root, rel, capsCtx);
    if (outcome.kind === 'error') return err(outcome.error);
    if (outcome.kind === 'denied') {
      denials.push(outcome.denial);
      continue;
    }
    files.push(outcome.file);
    includedBytes += outcome.file.size;
  }
  if (denials.length > 0) return err(deniedError(denials));
  return ok({ files });
}

/** Live-disk hash of one selected path; `null` = missing, refused, or no longer readable (treat as changed). */
export interface LiveHash {
  readonly relPath: RelPath;
  readonly sha256: Sha256 | null;
}

/**
 * Hashes the live files for the stale check before approval / implement (06 F6 `PROJECT_CHANGED`). This is the ONLY
 * post-intake read of the live disk; content consumers use `ArtifactStore.readSnapshot`.
 */
export async function hashFiles(root: ProjectRoot, relPaths: readonly string[], caps: InputCaps = INPUT_CAPS): Promise<Result<LiveHash[]>> {
  const normalized = normalizeAll(relPaths);
  if (!normalized.ok) return normalized;
  const ctx: ClassifyContext = { maxFileBytes: caps.maxFileBytes };
  const hashes = await Promise.all(
    normalized.value.map(async (rel): Promise<LiveHash> => {
      if (classifyByName(rel, false, ctx) !== null) return { relPath: rel, sha256: null };
      const read = await readConfined(root, rel, caps.maxFileBytes);
      return { relPath: rel, sha256: read.ok ? sha256Hex(read.value.bytes) : null };
    }),
  );
  return ok(hashes);
}
