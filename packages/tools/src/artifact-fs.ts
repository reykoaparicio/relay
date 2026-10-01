// Low-level file operations of the artifact store (05 E6): crash-safe temp writes and permission-aware unlinks.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { errnoOf } from '@relay/contracts';

/** Committed artifacts and tombstones are read-only (B12). */
export const FILE_MODE_READONLY = 0o444;
/** Mode of a temp file while it is written. */
export const FILE_MODE_WRITABLE = 0o644;

/** `e` is a Node fs error with this errno code. */
export function isErrno(e: unknown, code: string): boolean {
  return errnoOf(e) === code;
}

/** fsyncs a directory, so a link/rename/unlink in it is durable. */
export async function fsyncDir(dir: string): Promise<void> {
  const fh = await fs.promises.open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Writes `bytes` to a fresh read-only temp file next to `target` (O_EXCL, fsync, chmod 0o444) and returns its path.
 * `afterWrite` is the store's fault-injection hook (between fsync and chmod).
 */
export async function writeReadOnlyTemp(target: string, bytes: Uint8Array | string, afterWrite?: () => void | Promise<void>): Promise<string> {
  const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  const fh = await fs.promises.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, FILE_MODE_WRITABLE);
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await afterWrite?.();
  await fs.promises.chmod(tmp, FILE_MODE_READONLY);
  return tmp;
}

/** Unlinks a temp name WITHOUT chmod: after `link` it shares the committed inode, whose `0o444` must survive. */
export async function unlinkTemp(file: string): Promise<void> {
  await fs.promises.unlink(file).catch((e: unknown) => {
    if (!isErrno(e, 'ENOENT')) throw e;
  });
}

/** Makes `file` writable, then unlinks it; a missing file is fine. */
export async function unlinkWritable(file: string): Promise<void> {
  await fs.promises.chmod(file, FILE_MODE_WRITABLE).catch(() => undefined);
  await fs.promises.unlink(file).catch((e: unknown) => {
    if (!isErrno(e, 'ENOENT')) throw e;
  });
}
