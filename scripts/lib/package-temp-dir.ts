// Guarded temp dirs for the release scripts and their tests (13 §M1/M2). Recursive deletes only ever target dirs this
// process created with `makeTempDir`: each must be a direct child of realpath(os.tmpdir()) whose basename starts with
// TEMP_PREFIX, tracked in a Set, and not a symlink. Anything else throws, so a miscomputed path (tmpdir itself, its
// parent, $HOME, '/') can never be deleted.
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

export const TEMP_PREFIX = 'relay-m-';

/** Realpaths of dirs created by {@link makeTempDir} in this process. */
const created = new Set<string>();

function tmpRoot(): string {
  return realpathSync(tmpdir());
}

/** Creates `<tmpdir>/relay-m-<suffix>XXXXXX` and registers it as removable. Returns its realpath. */
export async function makeTempDir(suffix = ''): Promise<string> {
  if (!/^[A-Za-z0-9_-]*$/.test(suffix)) throw new Error(`makeTempDir: bad suffix ${JSON.stringify(suffix)}`);
  const dir = await realpath(await mkdtemp(path.join(tmpRoot(), `${TEMP_PREFIX}${suffix}`)));
  created.add(dir);
  return dir;
}

/** Throws unless `dir` is a tracked temp dir that is a direct child of realpath(os.tmpdir()). Returns its realpath. */
export async function assertRemovable(dir: string): Promise<string> {
  if (dir.trim() === '' || !path.isAbsolute(dir)) throw new Error(`removeDir: not an absolute path: ${JSON.stringify(dir)}`);
  const st = await lstat(dir).catch(() => null);
  if (st?.isSymbolicLink() === true) throw new Error(`removeDir: ${dir} is a symlink`);
  const real = st === null ? path.resolve(dir) : await realpath(dir);
  const root = tmpRoot();
  const forbidden = new Set(['/', root, path.dirname(root), homedir(), realpathSync(homedir())]);
  if (forbidden.has(real)) throw new Error(`removeDir: refusing protected path ${real}`);
  if (path.dirname(real) !== root) throw new Error(`removeDir: ${real} is not a direct child of ${root}`);
  if (!path.basename(real).startsWith(TEMP_PREFIX)) throw new Error(`removeDir: ${real} does not start with ${TEMP_PREFIX}`);
  if (!created.has(real)) throw new Error(`removeDir: ${real} was not created by this process`);
  return real;
}

/** Recursively removes a dir created by {@link makeTempDir}; a missing dir is fine. */
export async function removeDir(dir: string): Promise<void> {
  const real = await assertRemovable(dir);
  await rm(real, { recursive: true, force: true, maxRetries: 3 });
  created.delete(real);
}
