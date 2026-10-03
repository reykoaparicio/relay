import type { AppError, ExclusionReason, RelPath, Result, Sha256 } from '@relay/contracts';
import { INPUT_CAPS, err, errors, exclusionReasonSchema, ok } from '@relay/contracts';
import type { ClassifyContext } from './exclusions.js';
import { classifyByContent, classifyByName, compileUserPatterns, sniffBytes } from './exclusions.js';
import { loadGitignoresForPaths, makeGitignoreMatcher } from './gitignore.js';
import { sha256Hex } from './hash.js';
import type { ProjectRoot } from './paths.js';
import { isSecretRootPath, normalizeRelPath, readConfined } from './paths.js';
import type { InputCaps } from './scan.js';
import type { SuspectedSecretLabel } from './secret-scan.js';
import { unacknowledgedSuspectedSecret } from './secret-scan.js';

/** Options for {@link readSelected}. */
export interface ReadOptions {
  readonly caps?: InputCaps;
  readonly exclusions?: readonly string[];
  readonly respectGitignore?: boolean;
  /**
   * E2 #11 (intake): refuse files whose content looks like a credential (`suspected_secret`) unless their relPath is in
   * `acknowledged` (the run input's `acknowledgedSuspectedSecrets`). Omitted = no content check.
   */
  readonly secretCheck?: { readonly acknowledged: readonly string[] };
}

/** One file read at intake. `sha256` is computed over exactly `bytes` (feeds `run_input_files` and the context hash). */
export interface SelectedFile {
  readonly relPath: RelPath;
  readonly content: string;
  readonly bytes: Uint8Array;
  readonly sha256: Sha256;
  readonly size: number;
}

/** Why one selected path was refused. `hard_link` is an ExclusionReason (E2 #13). */
export type DenialReason = ExclusionReason | 'outside_root' | 'not_regular_file' | 'unreadable' | 'suspected_secret';

/** One refused path in a `PERMISSION_DENIED` from {@link readSelected}. */
export interface Denial {
  readonly relPath: string;
  readonly reason: DenialReason;
  /** `suspected_secret` only: what it looks like and where (never the value). */
  readonly secretLabel?: SuspectedSecretLabel;
  readonly secretLine?: number;
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
  if (e.details?.['reason'] === 'unreadable') return denied(relPath, 'unreadable'); // E2 #8
  const exclusion = e.details?.['exclusion'];
  if (exclusion === 'not_regular_file') return denied(relPath, 'not_regular_file');
  const reason = exclusionReasonSchema.safeParse(exclusion);
  if (reason.success) return denied(relPath, reason.data);
  return denied(relPath, 'outside_root'); // escapes and `changed_during_read` (a swap raced the read)
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Classify the requested name, then read through {@link readConfined} with the real-name classifier: the path is
 * resolved once, the real name classified, and the opened handle identity-checked against it (B1), so what is read is
 * exactly what was classified.
 */
async function readClassified(root: ProjectRoot, rel: RelPath, ctx: ClassifyContext) {
  const byName = classifyByName(rel, false, ctx);
  if (byName !== null) return err(errors.permissionDenied('excluded', { details: { relPath: rel, exclusion: byName } }));
  return readConfined(root, rel, ctx.maxFileBytes, (realRel) => classifyByName(realRel, false, ctx));
}

/**
 * normalize → classify requested name → resolve once → classify real name → open + identity check → sniff/decode →
 * (intake) content check for credentials.
 */
async function readOne(root: ProjectRoot, rel: RelPath, ctx: ClassifyContext, secretCheck?: ReadOptions['secretCheck']): Promise<Outcome> {
  const read = await readClassified(root, rel, ctx);
  if (!read.ok) return denialFromReadError(rel, read.error);
  const { bytes } = read.value;
  const sniffed = classifyByContent({ isDirectory: false, size: bytes.byteLength }, sniffBytes(bytes), ctx);
  if (sniffed !== null) return denied(rel, sniffed);
  const content = decodeUtf8(bytes);
  if (content === null) return denied(rel, 'binary'); // invalid UTF-8 is treated as binary (05 E4)
  if (secretCheck !== undefined) {
    const hit = unacknowledgedSuspectedSecret({ relPath: rel, content }, secretCheck.acknowledged);
    if (hit !== null) return { kind: 'denied', denial: { relPath: rel, reason: 'suspected_secret', secretLabel: hit.label, secretLine: hit.line } };
  }
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
  const base: ClassifyContext = {
    maxFileBytes: caps.maxFileBytes,
    isUserExcluded: compileUserPatterns(opts.exclusions ?? []),
    rootIsSecret: isSecretRootPath(root.realpath),
  };
  if (opts.respectGitignore === false) return base;
  return { ...base, isGitignored: makeGitignoreMatcher(await loadGitignoresForPaths(root, rels)) };
}

/** Top-level PERMISSION_DENIED reason when every denial shares a reason that has its own recovery. */
const OWN_REASONS = ['outside_root', 'unreadable', 'suspected_secret', 'hard_link'] as const;

function deniedMessage(reason: string, denials: readonly Denial[]): string {
  const first = denials[0]?.relPath ?? '';
  const names = denials.length === 1 ? first : `${first} and ${String(denials.length - 1)} more`;
  switch (reason) {
    case 'unreadable':
      return `Relay cannot read ${names}. Check the file permissions, or exclude it from this run.`;
    case 'suspected_secret':
      return `${names} looks like it contains a credential. Exclude it, or include it explicitly to send it anyway.`;
    case 'hard_link':
      return `${names} is a hard link and may be a file from outside the project. Exclude it, or replace it with a copy.`;
    default:
      return `${String(denials.length)} selected file(s) cannot be read. Nothing was read; see the listed reasons.`;
  }
}

function deniedError(denials: readonly Denial[]): AppError {
  const shared = OWN_REASONS.find((r) => denials.every((d) => d.reason === r));
  const reason = shared ?? 'excluded';
  const only = denials.length === 1 ? denials[0] : undefined;
  return errors.permissionDenied(reason, {
    userMessage: deniedMessage(reason, denials).slice(0, 400),
    details: { denied: denials.map((d) => ({ ...d })), ...(only === undefined ? {} : { relPath: only.relPath }) },
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
    const outcome = await readOne(root, rel, capsCtx, opts.secretCheck);
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
  const ctx: ClassifyContext = { maxFileBytes: caps.maxFileBytes, rootIsSecret: isSecretRootPath(root.realpath) };
  const hashes = await Promise.all(
    normalized.value.map(async (rel): Promise<LiveHash> => {
      // Same pipeline as readSelected (B6): requested AND real names classified, identity-checked handle.
      const read = await readClassified(root, rel, ctx);
      return { relPath: rel, sha256: read.ok ? sha256Hex(read.value.bytes) : null };
    }),
  );
  return ok(hashes);
}
