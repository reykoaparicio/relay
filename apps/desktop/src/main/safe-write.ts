// Main-process file writes that never clobber: the diagnostics export (same contract as the runner's exports — never
// overwrite, ` (2)`, ` (3)`, … on a clash, no partial file under the final name) and small JSON state files.
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { errnoOf } from '@relay/contracts';

/** The fs calls {@link writeNewFile} uses (tests inject failures). */
export interface SafeWriteFs {
  writeFile(path: string, data: string, opts: { encoding: 'utf8'; mode: number; flag: 'wx' }): Promise<void>;
  link(existing: string, created: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const realFs: SafeWriteFs = {
  writeFile: (p, d, o) => fsp.writeFile(p, d, o),
  link: (a, b) => fsp.link(a, b),
  unlink: (p) => fsp.unlink(p),
  rename: (a, b) => fsp.rename(a, b),
};

/** Highest ` (n)` suffix tried before giving up. */
export const MAX_NAME_SUFFIX = 99;

/** `name.ext` → `name (n).ext` (n ≥ 2). */
export function suffixedName(name: string, n: number): string {
  if (n <= 1) return name;
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)} (${String(n)})${ext}`;
}

/** errnos meaning "this filesystem cannot hard-link" (exFAT/FAT, some network shares). */
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']);

/**
 * Writes `data` to a NEW file `dest` (or `dest (2)`, `(3)`, …): the bytes go to a hidden temp file in the same
 * directory first (`O_EXCL`), which is then hard-linked under the final name — `link` fails with EEXIST instead of
 * replacing anything, and never follows a symlink planted at the destination. A filesystem without hard links falls
 * back to an `O_EXCL` write of the final name. The temp file is always removed. Returns the path written.
 * @throws the underlying fs error (EACCES, ENOSPC, …) or Error when every candidate name is taken.
 */
export async function writeNewFile(dest: string, data: string, fs: SafeWriteFs = realFs, mode = 0o600): Promise<string> {
  const dir = dirname(dest);
  const name = basename(dest);
  const tmp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  let created = false;
  try {
    // Round-3 B5: inside the try, so a write that fails part-way (ENOSPC) never leaves the temp file behind
    // (writeOwned removes its own partial file; a name collision — EEXIST — is someone else's file and never removed).
    await writeOwned(tmp, data, fs, mode);
    created = true;
    for (let n = 1; n <= MAX_NAME_SUFFIX; n += 1) {
      const candidate = join(dir, suffixedName(name, n));
      try {
        await fs.link(tmp, candidate);
        return candidate;
      } catch (e) {
        const code = errnoOf(e);
        if (code === 'EEXIST') continue;
        if (code === undefined || !NO_LINK.has(code)) throw e;
        return await writeExclusive(dir, name, n, data, fs, mode);
      }
    }
    throw new Error('no free file name');
  } finally {
    if (created) await fs.unlink(tmp).catch(() => undefined);
  }
}

/**
 * `O_EXCL` write of `path`. On any failure other than EEXIST the file is ours (`wx` created it), so whatever part of it
 * reached the disk is removed before rethrowing (round-3 B5). EEXIST means someone else's file: never touched.
 */
async function writeOwned(path: string, data: string, fs: SafeWriteFs, mode: number): Promise<void> {
  try {
    await fs.writeFile(path, data, { encoding: 'utf8', mode, flag: 'wx' });
  } catch (e) {
    if (errnoOf(e) !== 'EEXIST') await fs.unlink(path).catch(() => undefined);
    throw e;
  }
}

/**
 * Fallback for filesystems without hard links: an `O_EXCL` write of the final name. A write that fails part-way removes
 * the partial file it created ({@link writeOwned}), so no partial file is ever left under the final name.
 */
async function writeExclusive(dir: string, name: string, from: number, data: string, fs: SafeWriteFs, mode: number): Promise<string> {
  for (let n = from; n <= MAX_NAME_SUFFIX; n += 1) {
    const candidate = join(dir, suffixedName(name, n));
    try {
      await writeOwned(candidate, data, fs, mode);
      return candidate;
    } catch (e) {
      if (errnoOf(e) !== 'EEXIST') throw e;
    }
  }
  throw new Error('no free file name');
}

/** Atomically replaces a small state file main owns (temp file + rename in the same directory). */
export async function replaceFileAtomic(dest: string, data: string, fs: SafeWriteFs = realFs): Promise<void> {
  const tmp = join(dirname(dest), `.${basename(dest)}.${randomBytes(6).toString('hex')}.tmp`);
  await writeOwned(tmp, data, fs, 0o600); // a failed temp write removes its own partial file (round-3 B5)
  try {
    await fs.rename(tmp, dest);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
}
