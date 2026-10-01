import fs from 'node:fs';
import path from 'node:path';
import type { AppError, ArtifactId, Clock, EpochMs, RelPath, Result, RunId, Sha256 } from '@relay/contracts';
import { INPUT_CAPS, err, errnoDetails, errnoOf, errors, idBodyPattern, isIdOf, ok } from '@relay/contracts';
import { FILE_MODE_READONLY, fsyncDir, isErrno, unlinkTemp, unlinkWritable, writeReadOnlyTemp } from './artifact-fs.js';
import { TOMBSTONE_SUFFIX, ensureTombstone, purgedAtOf, readTombstone } from './artifact-tombstones.js';
import type { TombstoneDeps } from './artifact-tombstones.js';
import { sha256Hex } from './hash.js';

/** Store-relative scope directory: `artifacts/<runId|projectId>`. */
export type ScopeDir = `artifacts/${string}`;

/** A stored input-file snapshot as referenced by the `artifacts` row (id, rel_path, sha256). */
export interface InputFileRef {
  readonly artifactId: ArtifactId;
  readonly storeRelPath: string;
  readonly sha256: Sha256;
}

/** One project file's intake snapshot (§11.2). Identical content within a run shares one ref. */
export interface InputFileSnapshot extends InputFileRef {
  readonly relPath: RelPath;
  readonly sizeBytes: number;
  readonly mediaType: typeof INPUT_FILE_MEDIA_TYPE;
}

/** Input to {@link ArtifactStore.put}. */
export interface PutInput {
  readonly scopeDir: ScopeDir;
  readonly artifactId: ArtifactId;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/** Immutable, crash-safe artifact store under `userData/artifacts/` (§12.3, §7.5). */
export interface ArtifactStore {
  put(input: PutInput): Promise<Result<{ relPath: string; sha256: Sha256; sizeBytes: number }>>;
  /** Never throws. Purged → `NOT_FOUND` with `details = { purged: true, purgedAt }`; fs failure → `NOT_FOUND` + `details.errno`. */
  read(relPath: string, maxBytes: number): Promise<Result<Uint8Array>>;
  exists(relPath: string): Promise<boolean>;
  purge(relPath: string): Promise<Result<{ purgedAt: EpochMs }>>;
  snapshotInputFiles(
    runId: RunId,
    files: readonly { relPath: RelPath; bytes: Uint8Array; sha256: Sha256 }[],
    newId: () => ArtifactId,
  ): Promise<Result<InputFileSnapshot[]>>;
  readSnapshot(ref: InputFileRef): Promise<Result<{ content: string; sha256: Sha256 }>>;
  sweepOrphans(knownRelPaths: ReadonlySet<string>): Promise<{ removed: number }>;
}

/**
 * Test-only fault injection / interleaving hooks. A {@link FaultInjected} throw propagates uncaught, simulating a crash
 * (no cleanup runs). Hooks may be async so tests can force exact interleavings of concurrent `put`/`purge` calls.
 * - `afterTempWrite`: temp file written + fsynced, before chmod/link.
 * - `beforeLink`: temp file is `0o444`, right before `link(tmp, final)`.
 * - `afterCommit`: final path linked, before the post-commit tombstone re-check.
 * - `afterTombstone`: purge wrote the tombstone, before it unlinks the file.
 */
export interface ArtifactStoreFaults {
  readonly afterTempWrite?: () => void | Promise<void>;
  readonly beforeLink?: () => void | Promise<void>;
  readonly afterCommit?: () => void | Promise<void>;
  readonly afterTombstone?: () => void | Promise<void>;
}

/** Thrown by fault-injection hooks to simulate a crash; {@link ArtifactStore.put} never swallows it. */
export class FaultInjected extends Error {
  constructor() {
    super('fault injected');
    this.name = 'FaultInjected';
  }
}

/** Options for {@link createArtifactStore}. */
export interface ArtifactStoreOptions {
  readonly userDataDir: string;
  readonly clock: Clock;
  /** Structured log sink for invariant breaches (00b §3 logger); optional. */
  readonly log?: (event: string, fields: Readonly<Record<string, unknown>>) => void;
  readonly faults?: ArtifactStoreFaults;
}

/** Media type of input-file snapshots. */
export const INPUT_FILE_MEDIA_TYPE = 'text/plain; charset=utf-8';
/** §7.4: an orphan (file without a committed row) is swept at runner boot only once older than 1 h. */
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
const SCOPE_DIR_RE = new RegExp(`^artifacts/(${idBodyPattern('run')}|${idBodyPattern('project')})$`);

function invalidRelPath(): AppError {
  return errors.validationFailed([{ path: 'relPath', message: 'Not a valid artifact path.', code: 'invalid_artifact_path' }]);
}

/** Validates `artifacts/<scope>/<artifactId>`. */
function isArtifactRelPath(relPath: string): boolean {
  const slash = relPath.lastIndexOf('/');
  return SCOPE_DIR_RE.test(relPath.slice(0, slash)) && isIdOf('artifact', relPath.slice(slash + 1));
}

async function readAll(file: string, maxBytes: number): Promise<Result<Uint8Array> | 'missing'> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return 'missing';
    return err(errors.notFound('artifact', {}, { details: errnoDetails(e) }));
  }
  try {
    const st = await fh.stat();
    if (st.size > maxBytes) {
      return err(errors.validationFailed([{ path: 'maxBytes', message: 'The artifact is larger than allowed.', code: 'too_large' }]));
    }
    const buf = await fh.readFile();
    return ok(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  } finally {
    await fh.close();
  }
}

/** Lists every file two levels under `artifacts/` (`<scope>/<name>`), relative to userData, POSIX separators. */
async function listStoreFiles(artifactsDir: string): Promise<string[]> {
  const scopes = await fs.promises.readdir(artifactsDir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    scopes
      .filter((s) => s.isDirectory())
      .map(async (s) => {
        const files = await fs.promises.readdir(path.join(artifactsDir, s.name), { withFileTypes: true });
        return files.filter((f) => f.isFile()).map((f) => `artifacts/${s.name}/${f.name}`);
      }),
  );
  return nested.flat();
}

/**
 * Creates the store (05 E6). It only ever writes under `userDataDir/artifacts/`.
 *
 * Put/purge ordering (B9–B12), which makes every interleaving of a concurrent `put` and `purge` end with the file
 * gone and `put` failing `purged` (or `put` fully before `purge`):
 * - `put`: tombstone check → write tmp + fsync → chmod tmp `0o444` → `link(tmp, final)` (never replaces: `EEXIST`
 *   compares hashes — same bytes are idempotent, different bytes fail) → unlink tmp → fsync dir → re-check the
 *   tombstone; if it appeared, unlink the file and fail `purged`.
 * - `purge`: write the tombstone (tmp + fsync + `link`, repairing an empty/garbled one) → THEN unlink the file.
 * - `read`/`exists`: tombstone first; a present tombstone (even a broken one, which is repaired) means purged.
 * Since `purge` publishes the tombstone before unlinking and `put` links before re-checking, either `put`'s re-check
 * sees the tombstone, or the tombstone was written after the link and `purge`'s unlink removes the file.
 */
export function createArtifactStore(opts: ArtifactStoreOptions): ArtifactStore {
  const abs = (relPath: string): string => path.join(opts.userDataDir, ...relPath.split('/'));
  const log = opts.log ?? (() => undefined);
  const tombstones: TombstoneDeps = {
    now: () => opts.clock.now(),
    log,
    ...(opts.faults?.afterTempWrite === undefined ? {} : { afterTempWrite: opts.faults.afterTempWrite }),
  };

  /** Existing final file: same bytes → idempotent ok (restoring `0o444`, B12); different bytes → failure. */
  async function checkExisting(finalPath: string, relPath: string, sha: Sha256): Promise<Result<true> | null> {
    const existing = await readAll(finalPath, Number.MAX_SAFE_INTEGER);
    if (existing === 'missing') return null;
    if (existing.ok && sha256Hex(existing.value) === sha) {
      const st = await fs.promises.stat(finalPath);
      if ((st.mode & 0o777) !== FILE_MODE_READONLY) await fs.promises.chmod(finalPath, FILE_MODE_READONLY);
      return ok(true);
    }
    log('artifact.put.hash_mismatch', { relPath });
    return err(errors.artifactWriteFailed({ details: { reason: 'hash_mismatch' } }));
  }

  const purgedError = () => err(errors.artifactWriteFailed({ details: { reason: 'purged' } }));

  /** Commits a new file (B9): `link` never replaces, so two concurrent puts with different bytes cannot both win. */
  async function commitNew(finalPath: string, relPath: string, bytes: Uint8Array, sha: Sha256): Promise<Result<true>> {
    const tmp = await writeReadOnlyTemp(finalPath, bytes, opts.faults?.afterTempWrite);
    let linked = false;
    try {
      await opts.faults?.beforeLink?.();
      try {
        await fs.promises.link(tmp, finalPath);
        linked = true;
      } catch (e) {
        if (!isErrno(e, 'EEXIST')) throw e;
      }
    } finally {
      await unlinkTemp(tmp);
    }
    if (!linked) return (await checkExisting(finalPath, relPath, sha)) ?? err(errors.artifactWriteFailed());
    await fsyncDir(path.dirname(finalPath));
    await opts.faults?.afterCommit?.();
    // B10: a purge that ran concurrently published its tombstone before unlinking; if we linked after its unlink, the
    // tombstone is visible now, so remove what we resurrected.
    if ((await readTombstone(finalPath)).kind !== 'absent') {
      await unlinkWritable(finalPath);
      return purgedError();
    }
    return ok(true);
  }

  const put: ArtifactStore['put'] = async (input) => {
    if (!SCOPE_DIR_RE.test(input.scopeDir) || !isIdOf('artifact', input.artifactId)) return err(invalidRelPath());
    const relPath = `${input.scopeDir}/${input.artifactId}`;
    const finalPath = abs(relPath);
    const sha = sha256Hex(input.bytes);
    const done = ok({ relPath, sha256: sha, sizeBytes: input.bytes.byteLength });
    try {
      await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
      if ((await purgedAtOf(finalPath, tombstones)) !== null) return purgedError();
      const existing = await checkExisting(finalPath, relPath, sha);
      if (existing !== null) return existing.ok ? done : existing;
      const committed = await commitNew(finalPath, relPath, input.bytes, sha);
      return committed.ok ? done : committed;
    } catch (e) {
      if (e instanceof FaultInjected) throw e;
      log('artifact.put.failed', { relPath, code: errnoOf(e) });
      return err(errors.artifactWriteFailed());
    }
  };

  const readChecked = async (relPath: string, maxBytes: number): Promise<Result<Uint8Array>> => {
    if (!isArtifactRelPath(relPath)) return err(invalidRelPath());
    const file = abs(relPath);
    // Tombstone FIRST (B10): a file mid-purge (tombstone written, unlink pending) is already purged.
    const purgedAt = await purgedAtOf(file, tombstones).catch(() => null);
    if (purgedAt !== null) return err(errors.notFound('artifact', { purged: true }, { details: { purgedAt } }));
    const r = await readAll(file, maxBytes);
    return r === 'missing' ? err(errors.notFound('artifact')) : r;
  };

  /** Never throws: an fs failure after open (EIO, EISDIR, …) is `NOT_FOUND` with `details.errno` (code only). */
  const read: ArtifactStore['read'] = async (relPath, maxBytes) => {
    try {
      return await readChecked(relPath, maxBytes);
    } catch (e) {
      log('artifact.read.failed', { relPath, code: errnoOf(e) });
      return err(errors.notFound('artifact', {}, { details: errnoDetails(e) }));
    }
  };

  const exists: ArtifactStore['exists'] = async (relPath) => {
    if (!isArtifactRelPath(relPath)) return false;
    const file = abs(relPath);
    if ((await readTombstone(file)).kind !== 'absent') return false;
    return fs.promises.access(file).then(
      () => true,
      () => false,
    );
  };

  const purge: ArtifactStore['purge'] = async (relPath) => {
    if (!isArtifactRelPath(relPath)) return err(invalidRelPath());
    const file = abs(relPath);
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      // Tombstone BEFORE unlink (B10): a concurrent put's post-commit re-check then always sees it. Idempotent: an
      // existing valid tombstone keeps its purgedAt, and the unlink is repeated (crash between the two steps is safe).
      const purgedAt = await ensureTombstone(file, tombstones);
      await opts.faults?.afterTombstone?.();
      await unlinkWritable(file);
      return ok({ purgedAt });
    } catch (e) {
      if (e instanceof FaultInjected) throw e;
      log('artifact.purge.failed', { relPath });
      return err(errors.artifactWriteFailed());
    }
  };

  const snapshotInputFiles: ArtifactStore['snapshotInputFiles'] = async (runId, files, newId) => {
    const refs = new Map<Sha256, InputFileRef>();
    for (const f of files) {
      if (refs.has(f.sha256)) continue;
      if (sha256Hex(f.bytes) !== f.sha256) {
        log('artifact.snapshot.hash_mismatch', { runId });
        return err(errors.internal(undefined, 'snapshot_input_hash_mismatch'));
      }
      const artifactId = newId();
      const stored = await put({ scopeDir: `artifacts/${runId}`, artifactId, bytes: f.bytes, mediaType: INPUT_FILE_MEDIA_TYPE });
      if (!stored.ok) return stored;
      refs.set(f.sha256, { artifactId, storeRelPath: stored.value.relPath, sha256: f.sha256 });
    }
    return ok(
      files.map((f): InputFileSnapshot => {
        const ref = refs.get(f.sha256);
        if (ref === undefined) throw new Error('snapshot ref missing for a hashed file'); // unreachable
        return { ...ref, relPath: f.relPath, sizeBytes: f.bytes.byteLength, mediaType: INPUT_FILE_MEDIA_TYPE };
      }),
    );
  };

  const readSnapshot: ArtifactStore['readSnapshot'] = async (ref) => {
    const r = await read(ref.storeRelPath, INPUT_CAPS.maxFileBytes);
    if (!r.ok) return r;
    const breach = (reason: 'snapshot_hash_mismatch' | 'snapshot_not_utf8') => {
      log('artifact.snapshot.invariant_breach', { reason, artifactId: ref.artifactId });
      return err(errors.internal(undefined, reason));
    };
    if (sha256Hex(r.value) !== ref.sha256) return breach('snapshot_hash_mismatch');
    try {
      return ok({ content: new TextDecoder('utf-8', { fatal: true }).decode(r.value), sha256: ref.sha256 });
    } catch {
      return breach('snapshot_not_utf8');
    }
  };

  const sweepOrphans: ArtifactStore['sweepOrphans'] = async (knownRelPaths) => {
    const now = opts.clock.now();
    let removed = 0;
    for (const relPath of await listStoreFiles(abs('artifacts'))) {
      if (relPath.endsWith(TOMBSTONE_SUFFIX) || knownRelPaths.has(relPath)) continue;
      const st = await fs.promises.lstat(abs(relPath)).catch(() => null);
      if (st === null || now - st.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
      await unlinkWritable(abs(relPath)).then(
        () => (removed += 1),
        () => undefined,
      );
    }
    return { removed };
  };

  return { put, read, exists, purge, snapshotInputFiles, readSnapshot, sweepOrphans };
}
