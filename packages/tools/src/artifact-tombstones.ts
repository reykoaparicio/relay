// Artifact tombstones (05 E6, B10/B11): `<artifact>.purged` holds `{ purgedAt }` and is published BEFORE the artifact is
// unlinked, so a concurrent `put` always sees it. A tombstone that exists but is unreadable, empty, or garbled (a crash
// mid-write before B11) still means "purged" and is repaired atomically.
import fs from 'node:fs';
import path from 'node:path';
import type { EpochMs } from '@relay/contracts';
import { artifactTombstoneSchema } from '@relay/contracts';
import { fsyncDir, isErrno, unlinkTemp, writeReadOnlyTemp } from './artifact-fs.js';

/** Suffix of a tombstone next to its artifact. */
export const TOMBSTONE_SUFFIX = '.purged';

/** Tombstone state: absent, valid, or present but unreadable/empty/garbled. */
export type TombstoneState = { readonly kind: 'absent' } | { readonly kind: 'valid'; readonly purgedAt: EpochMs } | { readonly kind: 'broken' };

/** What publishing a tombstone needs from the store. */
export interface TombstoneDeps {
  readonly now: () => EpochMs;
  readonly log: (event: string, fields: Readonly<Record<string, unknown>>) => void;
  /** Fault-injection hook passed to {@link writeReadOnlyTemp}. */
  readonly afterTempWrite?: () => void | Promise<void>;
}

/** Reads the tombstone of artifact `file` (the content is validated with the contracts schema). */
export async function readTombstone(file: string): Promise<TombstoneState> {
  let text: string;
  try {
    text = await fs.promises.readFile(`${file}${TOMBSTONE_SUFFIX}`, 'utf8');
  } catch (e) {
    return isErrno(e, 'ENOENT') ? { kind: 'absent' } : { kind: 'broken' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'broken' };
  }
  const parsed = artifactTombstoneSchema.safeParse(raw);
  return parsed.success ? { kind: 'valid', purgedAt: parsed.data.purgedAt } : { kind: 'broken' };
}

/**
 * Publishes a tombstone for `file` (B11: tmp + fsync + link, so a crash never leaves an empty one). An existing valid
 * tombstone wins (its `purgedAt` is returned); an existing broken one is replaced atomically (repair).
 */
export async function ensureTombstone(file: string, deps: TombstoneDeps): Promise<EpochMs> {
  const tombstone = `${file}${TOMBSTONE_SUFFIX}`;
  const current = await readTombstone(file);
  if (current.kind === 'valid') return current.purgedAt;
  const purgedAt = deps.now();
  const tmp = await writeReadOnlyTemp(tombstone, JSON.stringify({ purgedAt }), deps.afterTempWrite);
  try {
    if (current.kind === 'broken') {
      await fs.promises.rename(tmp, tombstone);
      deps.log('artifact.tombstone.repaired', {});
    } else {
      try {
        await fs.promises.link(tmp, tombstone);
      } catch (e) {
        if (!isErrno(e, 'EEXIST')) throw e;
        const raced = await readTombstone(file);
        if (raced.kind === 'valid') return raced.purgedAt;
        await fs.promises.rename(tmp, tombstone);
      }
    }
  } finally {
    await unlinkTemp(tmp);
  }
  await fsyncDir(path.dirname(file));
  return purgedAt;
}

/** Tombstone present (valid, or broken → repaired) → its `purgedAt`; absent → null. */
export async function purgedAtOf(file: string, deps: TombstoneDeps): Promise<EpochMs | null> {
  const t = await readTombstone(file);
  if (t.kind === 'absent') return null;
  if (t.kind === 'valid') return t.purgedAt;
  return ensureTombstone(file, deps);
}
