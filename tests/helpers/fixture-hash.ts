/**
 * Tree hashing for the committed `tests/fixtures/sample-api` fixture (11 §K1).
 *
 * `.relay-fixture.json` records a sha256 per file plus one combined tree hash. It is used by
 * `check:project-untouched` (13 §M2), the e2e before/after hash (12), and FR-10 integration checks.
 *
 * CLI: `tsx tests/helpers/fixture-hash.ts --write [root]` regenerates the manifest;
 *      `tsx tests/helpers/fixture-hash.ts --check [root]` exits 1 on any drift.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIXTURE_MANIFEST_NAME = '.relay-fixture.json';
export const SAMPLE_API_ROOT = fileURLToPath(new URL('../fixtures/sample-api', import.meta.url));

/** Never part of the tree hash: the manifest itself and OS litter. */
const IGNORED_NAMES: ReadonlySet<string> = new Set([FIXTURE_MANIFEST_NAME, '.DS_Store']);

export interface FixtureManifest {
  readonly schemaVersion: 1;
  readonly algorithm: 'sha256';
  /** sha256 over the sorted `relPath \0 sha256 \n` lines of `files`. */
  readonly treeHash: string;
  readonly fileCount: number;
  /** POSIX relPath → sha256 of the file bytes (symlinks: sha256 of `symlink:<target>`). */
  readonly files: Readonly<Record<string, string>>;
}

export type FixtureCheckResult =
  | { readonly ok: true; readonly treeHash: string }
  | {
      readonly ok: false;
      readonly expectedTreeHash: string;
      readonly actualTreeHash: string;
      readonly added: readonly string[];
      readonly removed: readonly string[];
      readonly changed: readonly string[];
    };

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function toPosix(relPath: string): string {
  return relPath.split(sep).join(posix.sep);
}

async function walk(root: string, dir: string, out: Map<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    const rel = toPosix(relative(root, abs));
    const stat = await lstat(abs);
    if (stat.isSymbolicLink()) {
      // Symlinks are never followed; their target string is part of the tree identity.
      out.set(rel, sha256(`symlink:${await readlink(abs)}`));
    } else if (stat.isDirectory()) {
      await walk(root, abs, out);
    } else if (stat.isFile()) {
      out.set(rel, sha256(await readFile(abs)));
    }
  }
}

/** Combined hash: order-independent input (sorted by relPath), so it is stable across filesystems. */
export function combineTreeHash(files: Readonly<Record<string, string>>): string {
  const lines = Object.keys(files)
    .sort()
    .map((rel) => `${rel}\0${files[rel] ?? ''}\n`);
  return sha256(lines.join(''));
}

/** Hashes every file under `root` (dotfiles included, symlinks not followed). */
export async function computeFixtureManifest(root: string = SAMPLE_API_ROOT): Promise<FixtureManifest> {
  const collected = new Map<string, string>();
  await walk(root, root, collected);
  const files: Record<string, string> = {};
  for (const rel of [...collected.keys()].sort()) files[rel] = collected.get(rel) ?? '';
  return { schemaVersion: 1, algorithm: 'sha256', treeHash: combineTreeHash(files), fileCount: collected.size, files };
}

export async function readFixtureManifest(root: string = SAMPLE_API_ROOT): Promise<FixtureManifest> {
  const text = await readFile(join(root, FIXTURE_MANIFEST_NAME), 'utf8');
  return JSON.parse(text) as FixtureManifest;
}

export async function writeFixtureManifest(root: string = SAMPLE_API_ROOT): Promise<FixtureManifest> {
  const manifest = await computeFixtureManifest(root);
  await writeFile(join(root, FIXTURE_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** Pure diff of two manifests. */
export function compareManifests(expected: FixtureManifest, actual: FixtureManifest): FixtureCheckResult {
  if (expected.treeHash === actual.treeHash) return { ok: true, treeHash: actual.treeHash };
  const expectedPaths = Object.keys(expected.files);
  const actualPaths = Object.keys(actual.files);
  return {
    ok: false,
    expectedTreeHash: expected.treeHash,
    actualTreeHash: actual.treeHash,
    added: actualPaths.filter((p) => !(p in expected.files)).sort(),
    removed: expectedPaths.filter((p) => !(p in actual.files)).sort(),
    changed: expectedPaths.filter((p) => p in actual.files && expected.files[p] !== actual.files[p]).sort(),
  };
}

/**
 * Recomputes `root` and compares it against `expected` (default: the committed manifest of the
 * sample-api fixture). Temp copies pass their own root with the committed manifest as `expected`.
 */
export async function checkFixtureTree(root: string = SAMPLE_API_ROOT, expected?: FixtureManifest): Promise<FixtureCheckResult> {
  const baseline = expected ?? (await readFixtureManifest(SAMPLE_API_ROOT));
  return compareManifests(baseline, await computeFixtureManifest(root));
}

async function main(argv: readonly string[]): Promise<number> {
  const [mode, rootArg] = argv;
  const root = rootArg ?? SAMPLE_API_ROOT;
  if (mode === '--write') {
    const manifest = await writeFixtureManifest(root);
    console.log(`wrote ${FIXTURE_MANIFEST_NAME}: ${String(manifest.fileCount)} files, treeHash ${manifest.treeHash}`);
    return 0;
  }
  if (mode === '--check') {
    const result = await checkFixtureTree(root, await readFixtureManifest(SAMPLE_API_ROOT));
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  console.error('usage: fixture-hash.ts --write|--check [root]');
  return 2;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
}
