import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { errnoOf } from '@relay/contracts';
import type { Clock, EpochMs } from '@relay/contracts';
import { openNodeSqlite } from './driver-node-sqlite.js';
import { readInt } from './mappers.js';
import { createArtifactRepo } from './repos/artifacts.js';
import { backupStamp } from './stamp.js';
import type { ArtifactRow, Db } from './types.js';

/** `manifest.json` written next to the backup DB (03 §C7). Its presence marks a COMPLETE backup. */
export interface BackupManifest {
  readonly schemaVersion: number;
  readonly createdAt: EpochMs;
  readonly artifactCount: number;
  readonly sha256s: readonly string[];
  /** `auto` = rolling automatic backup (pruned to {@link AUTO_BACKUP_KEEP}); absent / `manual` = user-requested. */
  readonly kind?: BackupKind;
}

/** Who asked for the backup. Only `auto` backups are ever pruned. */
export type BackupKind = 'manual' | 'auto';

export interface BackupResult {
  /** Absolute backup directory (runner-internal; convert with `toDisplayPath` before it reaches the renderer). */
  readonly dir: string;
  readonly dbPath: string;
  readonly manifest: BackupManifest;
  /** Bytes of the DB snapshot plus the copied artifact files. */
  readonly sizeBytes: number;
}

export interface CreateBackupOptions {
  readonly db: Pick<Db, 'backupTo'>;
  readonly userDataDir: string;
  readonly clock: Clock;
  /** Default `manual`. An `auto` backup is named `<stamp>-auto` and pruned by {@link pruneAutoBackups}. */
  readonly kind?: BackupKind;
  /** Copy the referenced artifact files too (default true). Automatic backups skip them (artifacts are immutable). */
  readonly includeArtifacts?: boolean;
  /** Backups directory (default `<userDataDir>/backups`). */
  readonly backupsDir?: string;
}

/**
 * Automatic backups live in their own folder next to `backups/` (`<userData>/backups-auto/`), so pruning can never
 * reach a manual or pre-migration backup and `backups/` keeps only what the user (or a migration) asked for.
 */
export const AUTO_BACKUPS_DIRNAME = 'backups-auto';

/** Rolling automatic backups kept (E2 #4). */
export const AUTO_BACKUP_KEEP = 5;
/** Minimum age of the newest automatic backup before another is taken (daily). */
export const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
/** A `*.partial` directory older than this is a crashed backup and is removed by the next prune. */
const STALE_PARTIAL_MS = 60 * 60 * 1_000;

/** Only files under `artifacts/` are ever copied, so `secrets/` can never enter a backup (§18.4). */
const ARTIFACTS_PREFIX = 'artifacts/';
const PARTIAL_SUFFIX = '.partial';
const MANIFEST = 'manifest.json';
const DB_FILE = 'relay.sqlite';
/** `<stamp>[-n][-auto|-pre-vN]` directory names written by this module and by `migrate` (pre-migration backups). */
const BACKUP_DIR_RE = /^(\d{8}-\d{6})(?:-\d+)?(?:-(auto)|-pre-v\d+)?$/;
const AUTO_DIR_RE = /^\d{8}-\d{6}(?:-\d+)?-auto$/;
const PARTIAL_DIR_RE = /^\d{8}-\d{6}(?:-\d+)?(?:-auto)?\.partial$/;

function isMissing(e: unknown): boolean {
  return errnoOf(e) === 'ENOENT';
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (e) {
    if (isMissing(e)) return false;
    throw e;
  }
}

/**
 * Recursive delete restricted to a directory this module manages: `dir` must sit DIRECTLY inside `backupsDir` and its
 * name must match `nameRe`. Anything else is refused, so a wrong path can never remove user data (guarded delete).
 */
async function removeManagedDir(backupsDir: string, dir: string, nameRe: RegExp): Promise<void> {
  const root = resolve(backupsDir);
  const target = resolve(dir);
  if (dirname(target) !== root || !nameRe.test(basename(target))) {
    throw new Error('refusing to remove a directory that is not a managed backup directory');
  }
  await rm(target, { recursive: true, force: true, maxRetries: 3 });
}

/** Creates `<root>/<base>[-n]<suffix>.partial` exclusively and returns it with the final name it will be renamed to. */
async function reservePartial(root: string, base: string, suffix: string): Promise<{ partial: string; final: string }> {
  for (let n = 0; ; n += 1) {
    const name = `${n === 0 ? base : `${base}-${String(n)}`}${suffix}`;
    const final = join(root, name);
    if (await exists(final)) continue;
    const partial = `${final}${PARTIAL_SUFFIX}`;
    try {
      await mkdir(partial, { recursive: false });
      return { partial, final };
    } catch (e) {
      if (errnoOf(e) !== 'EEXIST') throw e;
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

async function copyArtifacts(userDataDir: string, dir: string, artifacts: readonly ArtifactRow[]): Promise<{ bytes: number; sha256s: string[] }> {
  let bytes = 0;
  const sha256s: string[] = [];
  for (const a of artifacts) {
    const src = a.relPath.startsWith(ARTIFACTS_PREFIX) ? contained(userDataDir, a.relPath) : null;
    const dest = contained(dir, a.relPath);
    if (src === null || dest === null) continue;
    try {
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
    } catch (e) {
      if (isMissing(e)) continue; // purged between listing and copying
      throw e;
    }
    bytes += a.sizeBytes;
    sha256s.push(a.sha256);
  }
  return { bytes, sha256s };
}

/**
 * Creates `backups/<YYYYMMDD-HHmmss>[-auto]/relay.sqlite` via the online backup API, then copies the unpurged artifact
 * files referenced by the snapshot's rows (immutable, so copying after the snapshot is consistent) and writes
 * `manifest.json` (03 §C7). Files that are already missing (e.g. purged between listing and copying) are skipped.
 *
 * Atomic (E2 #4): everything is written into `<name>.partial/` and renamed to `<name>/` only after the manifest is on
 * disk, so a backup directory without `.partial` is always complete. On any failure the partial directory is removed
 * (guarded: only the directory this call created) and the error is rethrown.
 */
export async function createBackup(opts: CreateBackupOptions): Promise<BackupResult> {
  const createdAt = opts.clock.now();
  const kind = opts.kind ?? 'manual';
  const root = opts.backupsDir ?? join(opts.userDataDir, 'backups');
  await mkdir(root, { recursive: true });
  const { partial, final } = await reservePartial(root, backupStamp(createdAt), kind === 'auto' ? '-auto' : '');
  try {
    const partialDb = join(partial, DB_FILE);
    await opts.db.backupTo(partialDb);
    let sizeBytes = (await stat(partialDb)).size;
    const snapshot = readSnapshot(partialDb);
    const copied = opts.includeArtifacts === false ? { bytes: 0, sha256s: [] } : await copyArtifacts(opts.userDataDir, partial, snapshot.artifacts);
    sizeBytes += copied.bytes;
    const manifest: BackupManifest = {
      schemaVersion: snapshot.schemaVersion, createdAt, artifactCount: copied.sha256s.length, sha256s: copied.sha256s,
      ...(kind === 'auto' ? { kind } : {}),
    };
    await writeFile(join(partial, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rename(partial, final);
    return { dir: final, dbPath: join(final, DB_FILE), manifest, sizeBytes };
  } catch (e) {
    await removeManagedDir(root, partial, PARTIAL_DIR_RE).catch(() => undefined);
    throw e;
  }
}

/** One complete backup on disk. */
export interface BackupEntry {
  readonly dir: string;
  readonly name: string;
  /** From the manifest when present, else from the directory stamp (pre-migration backups have no manifest). */
  readonly createdAt: number;
  readonly kind: BackupKind | 'pre_migration';
}

function stampMs(stamp: string): number {
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

async function readManifest(dir: string): Promise<BackupManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const createdAt = (parsed as { createdAt?: unknown }).createdAt;
    return typeof createdAt === 'number' ? (parsed as BackupManifest) : null;
  } catch {
    return null;
  }
}

/**
 * Complete backups in `backupsDir`, newest first. A directory counts when it holds `relay.sqlite` AND either a
 * `manifest.json` (written last by {@link createBackup}) or a `-pre-vN` name (migration backups). `*.partial` and
 * unrelated directories are ignored.
 */
export async function listBackups(backupsDir: string): Promise<BackupEntry[]> {
  let names: string[];
  try {
    names = await readdir(backupsDir);
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
  const out: BackupEntry[] = [];
  for (const name of names) {
    const m = BACKUP_DIR_RE.exec(name);
    if (m === null) continue;
    const dir = join(backupsDir, name);
    if (!(await exists(join(dir, DB_FILE)))) continue;
    const manifest = await readManifest(dir);
    const preMigration = name.includes('-pre-v');
    if (manifest === null && !preMigration) continue; // a manifest-less backup is incomplete
    const kind: BackupEntry['kind'] = preMigration ? 'pre_migration' : m[2] === 'auto' ? 'auto' : 'manual';
    out.push({ dir, name, createdAt: manifest?.createdAt ?? stampMs(m[1] ?? ''), kind });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
}

/**
 * Keeps the newest `keep` automatic backups and removes older ones; also removes `*.partial` directories older than an
 * hour (a crashed backup). Manual and pre-migration backups are never pruned. Returns the removed directory names.
 */
export async function pruneAutoBackups(backupsDir: string, now: number, keep = AUTO_BACKUP_KEEP): Promise<string[]> {
  const removed: string[] = [];
  const autos = (await listBackups(backupsDir)).filter((b) => b.kind === 'auto');
  for (const b of autos.slice(keep)) {
    await removeManagedDir(backupsDir, b.dir, AUTO_DIR_RE);
    removed.push(b.name);
  }
  let names: string[] = [];
  try {
    names = await readdir(backupsDir);
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
  for (const name of names.filter((n) => PARTIAL_DIR_RE.test(n))) {
    const dir = join(backupsDir, name);
    const st = await stat(dir).catch(() => null);
    if (st !== null && now - st.mtimeMs > STALE_PARTIAL_MS) {
      await removeManagedDir(backupsDir, dir, PARTIAL_DIR_RE);
      removed.push(name);
    }
  }
  return removed;
}

/** Options for {@link autoBackup}. */
export interface AutoBackupOptions {
  readonly db: Pick<Db, 'backupTo'>;
  readonly userDataDir: string;
  readonly backupsDir: string;
  readonly clock: Clock;
  /** Take one even when the newest automatic backup is younger than {@link AUTO_BACKUP_INTERVAL_MS} (clean shutdown). */
  readonly force?: boolean;
  readonly keep?: number;
  readonly intervalMs?: number;
}

/**
 * Rolling automatic backup (E2 #4): when forced (clean shutdown) or when the newest `auto` backup is older than a day,
 * takes a DB-only atomic backup (`<stamp>-auto`) and prunes to the newest `keep`. Returns the backup, or null when none
 * was due. Artifacts are not copied: they are immutable files that stay in `artifacts/`.
 */
export async function autoBackup(opts: AutoBackupOptions): Promise<BackupResult | null> {
  const now = opts.clock.now();
  const newest = (await listBackups(opts.backupsDir)).find((b) => b.kind === 'auto');
  if (opts.force !== true && newest !== undefined && now - newest.createdAt < (opts.intervalMs ?? AUTO_BACKUP_INTERVAL_MS)) return null;
  const made = await createBackup({ db: opts.db, userDataDir: opts.userDataDir, backupsDir: opts.backupsDir, clock: opts.clock, kind: 'auto', includeArtifacts: false });
  await pruneAutoBackups(opts.backupsDir, now, opts.keep ?? AUTO_BACKUP_KEEP);
  return made;
}

/** Result of {@link restoreLatestBackup}. */
export interface RestoreResult {
  /** Absolute backup directory restored from (main converts it to a display path). */
  readonly restoredFrom: string;
  readonly backupCreatedAt: number;
  readonly backupKind: BackupEntry['kind'];
  /** The previous `relay.sqlite` (+ `-wal` / `-shm`) were moved here, never deleted. Null when there was none. */
  readonly previousMovedTo: string | null;
  /** Artifact files restored from the backup because they were missing in `artifacts/`. */
  readonly restoredArtifacts: number;
}

/** True when the SQLite file at `path` opens read-only and passes `PRAGMA quick_check`. */
function backupDbIsHealthy(path: string): boolean {
  let driver: ReturnType<typeof openNodeSqlite> | null = null;
  try {
    driver = openNodeSqlite(path, { readOnly: true });
    const rows = driver.prepare('PRAGMA quick_check').all();
    const first = rows[0];
    return rows.length === 1 && typeof first === 'object' && first !== null && Object.values(first)[0] === 'ok';
  } catch {
    return false;
  } finally {
    driver?.close();
  }
}

async function restoreArtifacts(userDataDir: string, backupDir: string): Promise<number> {
  const root = join(backupDir, 'artifacts');
  if (!(await exists(root))) return 0;
  let restored = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = relative(backupDir, abs).split(sep).join('/');
      const dest = rel.startsWith(ARTIFACTS_PREFIX) ? contained(userDataDir, rel) : null;
      if (dest === null) continue;
      await mkdir(dirname(dest), { recursive: true });
      try {
        await copyFile(abs, dest, fsConstants.COPYFILE_EXCL); // never overwrite an existing artifact
        restored += 1;
      } catch (e) {
        if (errnoOf(e) !== 'EEXIST') throw e;
      }
    }
  };
  await walk(root);
  return restored;
}

/** Options for {@link restoreLatestBackup}. */
export interface RestoreOptions {
  readonly userDataDir: string;
  readonly clock: Clock;
  /** Folders searched (newest backup across all wins). Default `<userDataDir>/backups` and `<userDataDir>/backups-auto`. */
  readonly backupsDirs?: readonly string[];
}

/**
 * Restores the newest healthy backup into `<userDataDir>/relay.sqlite` (E2 #4). Runner-independent: it never opens
 * the live database, so it works when that file is corrupt, locked by a crashed runner's WAL, or from a newer schema.
 * MUST be called only while no runner is running (main stops / has not started it).
 *
 * Steps: pick the newest complete backup whose `relay.sqlite` passes `quick_check` (damaged ones are skipped) → move
 * the current `relay.sqlite`, `-wal`, `-shm` aside into `relay.sqlite.before-restore-<stamp>/` (never deleted) → copy
 * the backup DB to `relay.sqlite.partial` and rename it into place (atomic) → copy back artifact files that are
 * missing (never overwriting). Returns null when there is no usable backup (nothing is changed).
 */
export async function restoreLatestBackup(opts: RestoreOptions): Promise<RestoreResult | null> {
  const dirs = opts.backupsDirs ?? [join(opts.userDataDir, 'backups'), join(opts.userDataDir, AUTO_BACKUPS_DIRNAME)];
  const all = (await Promise.all(dirs.map((d) => listBackups(d)))).flat().sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
  const candidate = all.find((b) => backupDbIsHealthy(join(b.dir, DB_FILE)));
  if (candidate === undefined) return null;
  const live = join(opts.userDataDir, DB_FILE);
  const staged = `${live}${PARTIAL_SUFFIX}`;
  await copyFile(join(candidate.dir, DB_FILE), staged);
  let previousMovedTo: string | null = null;
  const present: string[] = [];
  for (const suffix of ['', '-wal', '-shm']) if (await exists(`${live}${suffix}`)) present.push(suffix);
  if (present.length > 0) {
    const { partial: aside } = await reservePartial(opts.userDataDir, `${DB_FILE}.before-restore-${backupStamp(opts.clock.now())}`, '');
    const finalAside = aside.slice(0, -PARTIAL_SUFFIX.length);
    for (const suffix of present) await rename(`${live}${suffix}`, join(aside, `${DB_FILE}${suffix}`));
    await rename(aside, finalAside);
    previousMovedTo = finalAside;
  }
  await rename(staged, live);
  const restoredArtifacts = await restoreArtifacts(opts.userDataDir, candidate.dir);
  return { restoredFrom: candidate.dir, backupCreatedAt: candidate.createdAt, backupKind: candidate.kind, previousMovedTo, restoredArtifacts };
}
