import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { errnoOf } from '@relay/contracts';
import type { Clock, EpochMs } from '@relay/contracts';
import { openNodeSqlite } from './driver-node-sqlite.js';
import { readInt } from './mappers.js';
import { createArtifactRepo } from './repos/artifacts.js';
import { backupStamp } from './stamp.js';
import type { ArtifactRow, Db } from './types.js';

/** `manifest.json` written next to the backup DB (03 §C7). */
export interface BackupManifest {
  readonly schemaVersion: number;
  readonly createdAt: EpochMs;
  readonly artifactCount: number;
  readonly sha256s: readonly string[];
}

export interface BackupResult {
  /** Absolute backup directory (runner-internal; convert with `toDisplayPath` before it reaches the renderer). */
  readonly dir: string;
  readonly dbPath: string;
  readonly manifest: BackupManifest;
  /** Bytes of the DB snapshot plus the copied artifact files. */
  readonly sizeBytes: number;
}

export interface CreateBackupOptions {
  readonly db: Db;
  readonly userDataDir: string;
  readonly clock: Clock;
}

/** Only files under `artifacts/` are ever copied, so `secrets/` can never enter a backup (§18.4). */
const ARTIFACTS_PREFIX = 'artifacts/';

function isMissing(e: unknown): boolean {
  return errnoOf(e) === 'ENOENT';
}

async function uniqueDir(root: string, stamp: string): Promise<string> {
  for (let n = 0; ; n += 1) {
    const dir = join(root, n === 0 ? stamp : `${stamp}-${String(n)}`);
    try {
      await mkdir(dir, { recursive: false });
      return dir;
    } catch (e) {
      if (errnoOf(e) !== 'EEXIST') {
        throw e;
      }
    }
  }
}

/**
 * Reads the artifact list and schema version from the SNAPSHOT (not the live DB), so the manifest describes exactly
 * what the backup contains even if the live DB changes after `backupTo` returns.
 */
function readSnapshot(dbPath: string): { artifacts: readonly ArtifactRow[]; schemaVersion: number } {
  const snap = openNodeSqlite(dbPath, { readOnly: true });
  try {
    const artifacts = createArtifactRepo(snap).listWhere({ unpurgedOnly: true });
    const schemaVersion = readInt(
      'schema_migrations',
      snap.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get(),
      'v',
    );
    return { artifacts, schemaVersion };
  } finally {
    snap.close();
  }
}

/** Resolves `relPath` under `root`, or null if it would escape it. */
function contained(root: string, relPath: string): string | null {
  const abs = resolve(root, relPath);
  return abs.startsWith(`${resolve(root)}${sep}`) ? abs : null;
}

/**
 * Creates `backups/<YYYYMMDD-HHmmss>/relay.sqlite` via the online backup API, then copies the unpurged artifact files
 * referenced by the snapshot's rows (immutable, so copying after the snapshot is consistent) and writes `manifest.json` (03 §C7).
 * Files that are already missing (e.g. purged between listing and copying) are skipped.
 */
export async function createBackup(opts: CreateBackupOptions): Promise<BackupResult> {
  const createdAt = opts.clock.now();
  await mkdir(join(opts.userDataDir, 'backups'), { recursive: true });
  const dir = await uniqueDir(join(opts.userDataDir, 'backups'), backupStamp(createdAt));
  const dbPath = join(dir, 'relay.sqlite');
  await opts.db.backupTo(dbPath);
  let sizeBytes = (await stat(dbPath)).size;
  const snapshot = readSnapshot(dbPath);
  const sha256s: string[] = [];
  for (const a of snapshot.artifacts) {
    const src = a.relPath.startsWith(ARTIFACTS_PREFIX) ? contained(opts.userDataDir, a.relPath) : null;
    const dest = contained(dir, a.relPath);
    if (src === null || dest === null) {
      continue;
    }
    try {
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
    } catch (e) {
      if (isMissing(e)) {
        continue;
      }
      throw e;
    }
    sizeBytes += a.sizeBytes;
    sha256s.push(a.sha256);
  }
  const manifest: BackupManifest = { schemaVersion: snapshot.schemaVersion, createdAt, artifactCount: sha256s.length, sha256s };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { dir, dbPath, manifest, sizeBytes };
}
