/**
 * Temp directories for integration tests (11 §K3). Tests never touch the committed fixture: `copyFixture` copies it into
 * a fresh dir under `os.tmpdir()` (temp roots are valid project roots, 05 §R4-35).
 */
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_MANIFEST_NAME } from './fixture-hash.js';

/** Root of the committed fixtures. */
export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** The obviously fake secret of the sample-api `.env` (11 §K1; allowlisted by the secret scanner). */
export const FIXTURE_SECRET_LINE = 'SAMPLE_API_TOKEN=sk-fixture-DO-NOT-READ-1234567890';
export const FIXTURE_SECRET = 'sk-fixture-DO-NOT-READ-1234567890';

/** Content of the symlink-escape target outside the project root. */
export const OUTSIDE_SECRET_CONTENT = 'OUTSIDE-SECRET-must-never-be-read\n';

const created = new Set<string>();

/** Creates a fresh temp dir (realpath) with the given prefix. Removed by {@link cleanupTempDirs}. */
export async function makeTempDir(prefix = 'relay-int-'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  created.add(dir);
  return dir;
}

/** Runs `fn` with a fresh temp dir and always removes it afterwards. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>, prefix = 'relay-int-'): Promise<T> {
  const dir = await makeTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    await removeDir(dir);
  }
}

/**
 * Removes a temp dir created by {@link makeTempDir} (or anything inside one). Refuses any other path, so a wrong
 * `dirname` can never delete the system temp dir or a user directory.
 * @throws Error when `dir` is not inside a dir this module created.
 */
export async function removeDir(dir: string): Promise<void> {
  const owner = [...created].find((c) => dir === c || dir.startsWith(`${c}${sep}`));
  if (owner === undefined) throw new Error(`removeDir: refusing to remove ${dir} (not a temp dir created by temp-dirs.ts)`);
  if (owner === dir) created.delete(dir);
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** Removes every temp dir created through this module that is still present. */
export async function cleanupTempDirs(): Promise<void> {
  await Promise.all([...created].map((d) => removeDir(d)));
}

/**
 * Copies `tests/fixtures/<name>` into a fresh temp dir and returns the copy's realpath. For `sample-api`, the copy gets
 * the fake `.env` (not committable from this environment, so it is materialised here) and loses the fixture manifest.
 */
export async function copyFixture(name: 'sample-api' = 'sample-api'): Promise<string> {
  const parent = await makeTempDir(`relay-fixture-${name}-`);
  // Nested one level so the symlink probe's `../../outside-target` stays inside this temp parent.
  const root = join(parent, 'work', name);
  await mkdir(dirname(root), { recursive: true });
  await cp(join(FIXTURES_DIR, name), root, { recursive: true, verbatimSymlinks: true });
  await rm(join(root, FIXTURE_MANIFEST_NAME), { force: true });
  await writeFile(join(root, '.env'), `${FIXTURE_SECRET_LINE}\n`, 'utf8');
  return realpath(root);
}

/**
 * Creates `<root>/link-outside → ../../outside-target/secret.txt` (the §17.1 symlink escape probe) plus its target
 * outside the root. Returns the target's absolute path.
 */
export async function makeSymlinkEscape(root: string): Promise<{ linkRelPath: string; targetAbs: string }> {
  const parent = dirname(dirname(root));
  if (![...created].some((c) => parent === c || parent.startsWith(`${c}${sep}`))) {
    throw new Error(`makeSymlinkEscape: ${root} is not a copyFixture() root`);
  }
  const targetAbs = join(parent, 'outside-target', 'secret.txt');
  await mkdir(dirname(targetAbs), { recursive: true });
  await writeFile(targetAbs, OUTSIDE_SECRET_CONTENT, 'utf8');
  await symlink('../../outside-target/secret.txt', join(root, 'link-outside'));
  return { linkRelPath: 'link-outside', targetAbs };
}
