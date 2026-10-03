// 08 H1: before the single-instance lock, main checks that the userData folder is writable. Electron's lock (and
// everything after it) needs to create files there; without this check an unwritable folder looked exactly like
// "another instance is running" and the app exited silently.
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errnoOf } from '@relay/contracts';

/** Outcome of {@link checkDirWritable}. */
export type WritableCheck = { readonly ok: true } | { readonly ok: false; readonly errno: string | undefined };

/** The fs calls the probe uses (tests inject failures). */
export interface ProbeFs {
  mkdirSync(path: string, opts: { recursive: true }): unknown;
  writeFileSync(path: string, data: string, opts: { flag: 'wx' }): void;
  unlinkSync(path: string): void;
}

const realFs: ProbeFs = {
  mkdirSync: (p, o) => mkdirSync(p, o),
  writeFileSync: (p, d, o) => {
    writeFileSync(p, d, o);
  },
  unlinkSync: (p) => {
    unlinkSync(p);
  },
};

/** Creates `dir` if needed, then creates and removes an empty probe file in it. */
export function checkDirWritable(dir: string, fs: ProbeFs = realFs, pid: number = process.pid): WritableCheck {
  const probe = join(dir, `.relay-write-check-${String(pid)}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.unlinkSync(probe); // a leftover from a crashed probe of a recycled pid
    } catch {
      // usually ENOENT
    }
    fs.writeFileSync(probe, '', { flag: 'wx' });
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (e) {
    return { ok: false, errno: errnoOf(e) };
  }
}

/** The error box shown when userData is not writable (title + body naming the folder and how to fix it). */
export function unwritableUserDataMessage(dir: string, errno: string | undefined): { title: string; content: string } {
  const cause =
    errno === 'ENOSPC' || errno === 'EDQUOT'
      ? 'The disk is full.'
      : errno === 'EROFS'
        ? 'The disk is read-only.'
        : errno === 'EACCES' || errno === 'EPERM'
          ? 'Your user account does not have permission to write there.'
          : `The folder could not be written${errno === undefined ? '' : ` (${errno})`}.`;
  const fix =
    errno === 'ENOSPC' || errno === 'EDQUOT'
      ? 'Free up some disk space, then open Relay again.'
      : 'In Finder, select the folder, choose File → Get Info, and under "Sharing & Permissions" give your account "Read & Write" access (or move the folder aside so Relay can create a new one), then open Relay again.';
  return {
    title: 'Relay cannot start',
    content: `Relay cannot save its data in this folder:\n\n${dir}\n\n${cause}\n\n${fix}`,
  };
}
