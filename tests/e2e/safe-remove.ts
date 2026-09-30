// Guarded cleanup for the e2e suite. Recursive deletes only ever target temp dirs this process created with
// `makeTempDir` (or their `<dir>-samples` sibling, created by the app next to an overridden userData): each must be a
// direct child of realpath(os.tmpdir()) whose basename starts with `relay-e2e-`. Anything else throws, so a
// miscomputed path (tmpdir itself, its parent, $HOME, '/') can never be deleted.
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

export const TEMP_PREFIX = 'relay-e2e-';
const SAMPLES_SUFFIX = '-samples';

/** Realpaths of dirs created by {@link makeTempDir} in this process. */
const created = new Set<string>();

function tmpRoot(): string {
  return realpathSync(tmpdir());
}

/** Creates `<tmpdir>/relay-e2e-<suffix>XXXXXX` and registers it as removable. Returns its realpath. */
export async function makeTempDir(suffix = ''): Promise<string> {
  if (suffix.includes('/') || suffix.includes('..'))
    throw new Error(`makeTempDir: bad suffix ${JSON.stringify(suffix)}`);
  const dir = await realpath(await mkdtemp(path.join(tmpRoot(), `${TEMP_PREFIX}${suffix}`)));
  created.add(dir);
  return dir;
}

/** Lexical + realpath form of a path that may not exist yet (then its parent's realpath + basename). */
async function resolveReal(p: string): Promise<string> {
  const abs = path.resolve(p);
  try {
    return await realpath(abs);
  } catch {
    return path.join(await realpath(path.dirname(abs)).catch(() => path.dirname(abs)), path.basename(abs));
  }
}

/** Throws unless `dir` is a tracked temp dir (or its `-samples` sibling) directly inside realpath(os.tmpdir()). */
export async function assertRemovable(dir: string): Promise<string> {
  if (typeof dir !== 'string' || dir.trim() === '') throw new Error('safeRemove: empty path');
  const real = await resolveReal(dir);
  const root = tmpRoot();
  const forbidden = new Set(['/', root, path.dirname(root), homedir(), realpathSync(homedir())]);
  if (forbidden.has(real)) throw new Error(`safeRemove: refusing protected path ${real}`);
  if (path.dirname(real) !== root) throw new Error(`safeRemove: ${real} is not a direct child of ${root}`);
  const base = path.basename(real);
  if (!base.startsWith(TEMP_PREFIX))
    throw new Error(`safeRemove: ${real} does not start with ${TEMP_PREFIX}`);
  const owner = base.endsWith(SAMPLES_SUFFIX) ? real.slice(0, -SAMPLES_SUFFIX.length) : real;
  if (!created.has(owner) && !created.has(real))
    throw new Error(`safeRemove: ${real} was not created by this test process`);
  // Never follow a symlink out of tmp: the entry itself must not be a link.
  const st = await lstat(real).catch(() => null);
  if (st?.isSymbolicLink() === true) throw new Error(`safeRemove: ${real} is a symlink`);
  return real;
}

/** Recursively removes a tracked temp dir (see {@link assertRemovable}); a missing dir is fine. */
export async function safeRemove(dir: string): Promise<void> {
  const real = await assertRemovable(dir);
  await rm(real, { recursive: true, force: true });
  if (!real.endsWith(SAMPLES_SUFFIX)) created.delete(real);
}
