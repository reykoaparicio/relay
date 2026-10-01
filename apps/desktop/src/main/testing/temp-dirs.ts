// Test-only temp directories for desktop unit tests. Ownership-guarded: `removeTempDir` deletes only a directory this
// module created (tracked in a Set), directly under the realpath of os.tmpdir(), whose name carries PREFIX. Anything
// else — the temp root itself, its parent, home, `/`, or a look-alike path — is refused.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** Name prefix of every directory this module creates. */
export const TEMP_PREFIX = 'relay-desk-';

const created = new Set<string>();

/** Creates a fresh `<tmpdir>/relay-desk-<label>-XXXXXX` and returns its realpath. */
export async function makeTempDir(label = 't'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `${TEMP_PREFIX}${label}-`)));
  created.add(dir);
  return dir;
}

/**
 * Recursively removes a directory created by {@link makeTempDir}.
 * @throws Error for any other path (nothing is deleted).
 */
export async function removeTempDir(dir: string): Promise<void> {
  const root = await realpath(tmpdir());
  if (!created.has(dir) || dirname(dir) !== root || !basename(dir).startsWith(TEMP_PREFIX)) {
    throw new Error(`removeTempDir: refusing to remove ${dir} (not a temp dir created by testing/temp-dirs.ts)`);
  }
  created.delete(dir);
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
}
