import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppError, ArtifactId, Clock, EpochMs, RelPath, Result, RunId, Sha256 } from '@relay/contracts';
import { INPUT_CAPS, ULID_PATTERN, appError, err, errors, isIdOf, ok } from '@relay/contracts';
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
  /** Purged → `NOT_FOUND` with `details = { purged: true, purgedAt }`. */
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

/** Test-only fault injection. `afterTempWrite` runs after the temp file is fsynced and before rename; a throw there
 * propagates uncaught, simulating a crash (no cleanup runs). */
export interface ArtifactStoreFaults {
  readonly afterTempWrite?: () => void;
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
const FILE_MODE_READONLY = 0o444;
const FILE_MODE_WRITABLE = 0o644;
const TOMBSTONE_SUFFIX = '.purged';
const SCOPE_DIR_RE = new RegExp(`^artifacts/(run|prj)_${ULID_PATTERN}$`);

function isErrno(e: unknown, code: string): boolean {
  return e instanceof Error && 'code' in e && e.code === code;
}

function invalidRelPath(): AppError {
  return errors.validationFailed([{ path: 'relPath', message: 'Not a valid artifact path.', code: 'invalid_artifact_path' }]);
}

/** Validates `artifacts/<scope>/<artifactId>`. */
function isArtifactRelPath(relPath: string): boolean {
  const slash = relPath.lastIndexOf('/');
  return SCOPE_DIR_RE.test(relPath.slice(0, slash)) && isIdOf('artifact', relPath.slice(slash + 1));
}

async function fsyncDir(dir: string): Promise<void> {
  const fh = await fs.promises.open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function readTombstone(file: string): Promise<EpochMs | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(`${file}${TOMBSTONE_SUFFIX}`, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'purgedAt' in parsed && typeof parsed.purgedAt === 'number') {
      return parsed.purgedAt as EpochMs;
    }
    return null;
  } catch {
    return null;
  }
}

async function readAll(file: string, maxBytes: number): Promise<Result<Uint8Array> | 'missing'> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return 'missing';
    return err(errors.notFound('artifact'));
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

async function unlinkWritable(file: string): Promise<void> {
  await fs.promises.chmod(file, FILE_MODE_WRITABLE).catch(() => undefined);
  await fs.promises.unlink(file).catch((e: unknown) => {
    if (!isErrno(e, 'ENOENT')) throw e;
  });
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

/** Creates the store (05 E6). It only ever writes under `userDataDir/artifacts/`. */
export function createArtifactStore(opts: ArtifactStoreOptions): ArtifactStore {
  const abs = (relPath: string): string => path.join(opts.userDataDir, ...relPath.split('/'));
  const log = opts.log ?? (() => undefined);

  async function writeNew(finalPath: string, bytes: Uint8Array): Promise<void> {
    const tmp = `${finalPath}.tmp-${randomBytes(6).toString('hex')}`;
    const fh = await fs.promises.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, FILE_MODE_WRITABLE);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    opts.faults?.afterTempWrite?.();
    await fs.promises.rename(tmp, finalPath);
    await fsyncDir(path.dirname(finalPath));
    await fs.promises.chmod(finalPath, FILE_MODE_READONLY);
  }

  async function checkExisting(finalPath: string, relPath: string, sha: Sha256): Promise<Result<true> | null> {
    const existing = await readAll(finalPath, Number.MAX_SAFE_INTEGER);
    if (existing === 'missing') return null;
    if (existing.ok && sha256Hex(existing.value) === sha) return ok(true);
    log('artifact.put.hash_mismatch', { relPath });
    return err(errors.artifactWriteFailed({ details: { reason: 'hash_mismatch' } }));
  }

  const put: ArtifactStore['put'] = async (input) => {
    if (!SCOPE_DIR_RE.test(input.scopeDir) || !isIdOf('artifact', input.artifactId)) return err(invalidRelPath());
    const relPath = `${input.scopeDir}/${input.artifactId}`;
    const finalPath = abs(relPath);
    const sha = sha256Hex(input.bytes);
    const done = ok({ relPath, sha256: sha, sizeBytes: input.bytes.byteLength });
    try {
      await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
      if ((await readTombstone(finalPath)) !== null) {
        return err(errors.artifactWriteFailed({ details: { reason: 'purged' } }));
      }
      const existing = await checkExisting(finalPath, relPath, sha);
      if (existing !== null) return existing.ok ? done : existing;
      await writeNew(finalPath, input.bytes);
      return done;
    } catch (e) {
      if (e instanceof FaultInjected) throw e;
      log('artifact.put.failed', { relPath, code: e instanceof Error && 'code' in e ? e.code : undefined });
      return err(errors.artifactWriteFailed());
    }
  };

  const read: ArtifactStore['read'] = async (relPath, maxBytes) => {
    if (!isArtifactRelPath(relPath)) return err(invalidRelPath());
    const file = abs(relPath);
    const r = await readAll(file, maxBytes);
    if (r !== 'missing') return r;
    const purgedAt = await readTombstone(file);
    if (purgedAt === null) return err(errors.notFound('artifact'));
    return err(errors.notFound('artifact', { purged: true }, { details: { purgedAt } }));
  };

  const exists: ArtifactStore['exists'] = async (relPath) => {
    if (!isArtifactRelPath(relPath)) return false;
    return fs.promises.access(abs(relPath)).then(
      () => true,
      () => false,
    );
  };

  const purge: ArtifactStore['purge'] = async (relPath) => {
    if (!isArtifactRelPath(relPath)) return err(invalidRelPath());
    const file = abs(relPath);
    const tombstone = `${file}${TOMBSTONE_SUFFIX}`;
    try {
      await unlinkWritable(file);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const purgedAt = opts.clock.now();
      try {
        await fs.promises.writeFile(tombstone, JSON.stringify({ purgedAt }), { flag: 'wx', mode: FILE_MODE_WRITABLE });
      } catch (e) {
        if (!isErrno(e, 'EEXIST')) throw e;
        const previous = await readTombstone(file);
        if (previous === null) throw e;
        return ok({ purgedAt: previous });
      }
      await fs.promises.chmod(tombstone, FILE_MODE_READONLY);
      return ok({ purgedAt });
    } catch {
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
        return err(appError('INTERNAL', { runId, details: { reason: 'snapshot_input_hash_mismatch' } }));
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
    const breach = (reason: string) => {
      log('artifact.snapshot.invariant_breach', { reason, artifactId: ref.artifactId });
      return err(appError('INTERNAL', { details: { reason } }));
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
