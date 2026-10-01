// 13 §M3: path guards and ownership-guarded recursive deletes for the demo scripts (§18.4: a demo reset must never
// erase unrelated user data). Every recursive delete in scripts/demo-* and scripts/evaluate.ts goes through
// `removeScratchDir` (dirs this process created under os.tmpdir()) or `removePreviousDemoDir` (an exact
// `Relay-Demo.previous-<stamp>` sibling that carries the reset marker). Nothing else here deletes recursively.
import { lstat, mkdtemp, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** The only directory name demo reset may replace. */
export const DEMO_DIR_NAME = 'Relay-Demo';
/** Kept previous demo dirs: `Relay-Demo.previous-YYYYMMDD-HHmmss-SSS`. */
export const PREVIOUS_DIR_RE = /^Relay-Demo\.previous-\d{8}-\d{6}-\d{3}$/;
/** Written by demo-reset into every dir it creates; a previous dir without it is never deleted. */
export const RESET_MARKER = '.relay-demo-reset.json';
/** Written by demo-reset into the restored sample copy; a sample dir without it is never moved. */
export const SAMPLE_MARKER = '.relay-demo-sample.json';
/** Name of the restored sample project dir inside the samples dir. */
export const SAMPLE_DIR_NAME = 'sample-api';

/** Where a demo target came from. */
export type TargetSource = 'env' | 'arg' | 'default';

/** A validated demo userData target. `target` = realpath(parent)/Relay-Demo (it may not exist yet). */
export interface DemoTarget {
  readonly target: string;
  readonly parent: string;
  readonly source: TargetSource;
}

/** Thrown for every refused path; the message says why. */
export class DemoPathRefused extends Error {
  override readonly name = 'DemoPathRefused';
}

/** `~/Library/Application Support` for `home`. */
export function applicationSupportDir(home: string): string {
  return join(home, 'Library', 'Application Support');
}

async function lstatOrNull(p: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(p);
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return null;
    throw e;
  }
}

/** True when `e` is a Node errno error with `code`. */
export function isErrno(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === code;
}

/** True when `p` exists (lstat: a dangling symlink exists). */
export async function exists(p: string): Promise<boolean> {
  return (await lstatOrNull(p)) !== null;
}

/**
 * Resolves and validates the demo userData dir (13 §M3). Precedence: `RELAY_USER_DATA_DIR`, then `--dir`, then
 * `~/Library/Application Support/Relay-Demo`. Refuses:
 * - a relative path, or any basename other than exactly `Relay-Demo` (so `/`, `$HOME`, the temp dir and
 *   `Relay-Demo-x` are all refused);
 * - a target that is a symlink (it could point anywhere) or exists but is not a directory;
 * - a parent that does not exist;
 * - unless `RELAY_USER_DATA_DIR` names it explicitly, a parent other than `~/Library/Application Support` (compared
 *   after realpath).
 * @throws DemoPathRefused
 */
export async function resolveDemoTarget(o: { envDir?: string | undefined; argDir?: string | undefined; home: string }): Promise<DemoTarget> {
  const envDir = o.envDir?.trim() ?? '';
  const argDir = o.argDir?.trim() ?? '';
  const source: TargetSource = envDir !== '' ? 'env' : argDir !== '' ? 'arg' : 'default';
  const raw = source === 'env' ? envDir : source === 'arg' ? argDir : join(applicationSupportDir(o.home), DEMO_DIR_NAME);
  if (!isAbsolute(raw)) throw new DemoPathRefused(`refusing ${raw}: the demo dir must be an absolute path`);
  const requested = resolve(raw);
  if (basename(requested) !== DEMO_DIR_NAME) {
    throw new DemoPathRefused(`refusing ${requested}: only a directory named exactly "${DEMO_DIR_NAME}" can be reset`);
  }
  let parent: string;
  try {
    parent = await realpath(dirname(requested));
  } catch {
    throw new DemoPathRefused(`refusing ${requested}: its parent directory does not exist`);
  }
  const target = join(parent, DEMO_DIR_NAME);
  const st = await lstatOrNull(target);
  if (st?.isSymbolicLink() === true) {
    const to = await readlink(target).catch(() => '?');
    throw new DemoPathRefused(`refusing ${target}: it is a symlink (→ ${to}); demo reset only replaces a real directory`);
  }
  if (st !== null && !st.isDirectory()) throw new DemoPathRefused(`refusing ${target}: it exists and is not a directory`);
  if (source !== 'env') {
    const appSupport = await realpath(applicationSupportDir(o.home)).catch(() => applicationSupportDir(o.home));
    if (parent !== appSupport) {
      throw new DemoPathRefused(
        `refusing ${target}: its parent is not ${appSupport}. Pass the dir through RELAY_USER_DATA_DIR to name it explicitly`,
      );
    }
  }
  return { target, parent, source };
}

/** True when `pid` is a live process (EPERM ⇒ alive). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return isErrno(e, 'EPERM');
  }
}

/**
 * Chromium's single-instance lock (`<userData>/SingletonLock` → `<host>-<pid>`). Returns the live pid holding it, or
 * null when the app is not running on this profile.
 */
export async function runningAppPid(userDataDir: string): Promise<number | null> {
  const lock = join(userDataDir, 'SingletonLock');
  const st = await lstatOrNull(lock);
  if (st === null) return null;
  const target = st.isSymbolicLink() ? await readlink(lock).catch(() => '') : '';
  const pid = Number(/-(\d+)$/.exec(target)?.[1] ?? Number.NaN);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return isPidAlive(pid) ? pid : null;
}

/** `YYYYMMDD-HHmmss-SSS` (UTC). */
export function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${String(d.getUTCFullYear())}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}`;
}

/**
 * Deletes one previous demo dir. Refuses unless ALL hold: `name` matches {@link PREVIOUS_DIR_RE} exactly, the path is
 * `<parent>/<name>` with no symlink in it (realpath equal), it is a directory, and it carries {@link RESET_MARKER} as
 * a regular file (so a user's own directory that was moved aside is never deleted).
 * @throws DemoPathRefused
 */
export async function removePreviousDemoDir(parent: string, name: string): Promise<void> {
  if (!PREVIOUS_DIR_RE.test(name)) throw new DemoPathRefused(`refusing to delete ${name}: not a Relay-Demo.previous-<stamp> name`);
  const dir = join(parent, name);
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new DemoPathRefused(`refusing to delete ${dir}: not a real directory`);
  if ((await realpath(dir)) !== dir) throw new DemoPathRefused(`refusing to delete ${dir}: its realpath differs`);
  const marker = await lstatOrNull(join(dir, RESET_MARKER));
  if (marker === null || !marker.isFile()) throw new DemoPathRefused(`refusing to delete ${dir}: no ${RESET_MARKER} (not created by demo-reset)`);
  await rm(dir, { recursive: true, force: false });
}

const scratch = new Set<string>();

/** Creates a fresh dir under os.tmpdir() (realpath). Only {@link removeScratchDir} deletes it. */
export async function makeScratchDir(prefix: string): Promise<string> {
  if (!/^[a-z0-9-]+-$/.test(prefix)) throw new Error(`makeScratchDir: bad prefix ${prefix}`);
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  scratch.add(dir);
  return dir;
}

/**
 * Removes a dir created by {@link makeScratchDir} in this process (or a path inside one).
 * @throws Error for any other path, so a wrong argument can never delete the temp root or a user dir.
 */
export async function removeScratchDir(rawDir: string): Promise<void> {
  // Resolve first: `<scratch>/../..` must never pass the prefix check below.
  const dir = resolve(rawDir);
  const owner = [...scratch].find((c) => dir === c || dir.startsWith(`${c}${sep}`));
  if (owner === undefined) throw new Error(`removeScratchDir: refusing to remove ${dir} (not created by makeScratchDir)`);
  if (owner === dir) scratch.delete(dir);
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** Removes every scratch dir this process still owns. */
export async function cleanupScratchDirs(): Promise<void> {
  for (const d of [...scratch]) await removeScratchDir(d);
}

/** Marker file of a demo snapshot dir (docs/demo/snapshot/snapshot.json). */
export const SNAPSHOT_MANIFEST = 'snapshot.json';
/** `kind` value inside {@link SNAPSHOT_MANIFEST}. */
export const SNAPSHOT_KIND = 'relay-demo-snapshot';

/**
 * Deletes a previous demo snapshot dir before demo-snapshot writes a new one. Refuses unless the path is absolute,
 * named exactly `snapshot`, a real directory (no symlink, realpath equal), and holds a {@link SNAPSHOT_MANIFEST} whose
 * `kind` is {@link SNAPSHOT_KIND}.
 * @throws DemoPathRefused
 */
export async function removeSnapshotDir(dir: string): Promise<void> {
  if (!isAbsolute(dir) || basename(dir) !== 'snapshot') throw new DemoPathRefused(`refusing to delete ${dir}: not a snapshot dir`);
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || (await realpath(dir)) !== dir) throw new DemoPathRefused(`refusing to delete ${dir}: not a real directory`);
  const manifest = await readFile(join(dir, SNAPSHOT_MANIFEST), 'utf8').catch(() => '');
  let kind: unknown;
  try {
    kind = (JSON.parse(manifest) as { kind?: unknown }).kind;
  } catch {
    kind = undefined;
  }
  if (kind !== SNAPSHOT_KIND) throw new DemoPathRefused(`refusing to delete ${dir}: no ${SNAPSHOT_MANIFEST} of kind ${SNAPSHOT_KIND}`);
  await rm(dir, { recursive: true, force: false });
}
