/**
 * Post-condition checks shared by the crash matrix and other suites (11 §K4 "Every row also asserts"): no negative
 * reserved/unknown bucket, C + R + U = Σ attempts, `integrity_check` ok, and no orphan / `.tmp` artifact files left
 * after `sweepOrphans`.
 */
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { expect } from 'vitest';
import { epochMs } from '@relay/contracts';
import type { Db } from '@relay/storage';
import { createArtifactStore } from '@relay/tools';
import { allRuns, expectLedgerMatchesAttempts, expectNoNegativeReserved } from './assert-ledger.js';
import { integrityCheck } from './sqlite-inspect.js';

/** Every file under `dir` (POSIX paths relative to `base`). */
export async function listFiles(dir: string, base: string = dir): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(abs, base)));
    else if ((await lstat(abs)).isFile()) out.push(relative(base, abs).split(sep).join('/'));
  }
  return out;
}

/** Sweeps orphans with a clock 2 h ahead (past ORPHAN_MIN_AGE_MS) and asserts no `.tmp` / unreferenced files remain. */
export async function expectNoOrphanArtifacts(db: Db, userDataDir: string): Promise<void> {
  const known = new Set<string>();
  for (const run of allRuns(db)) for (const a of db.repos.artifacts.listForRun(run.id)) known.add(a.relPath);
  for (const p of db.repos.projects.list({ includeArchived: true })) for (const a of db.repos.artifacts.listWhere({ projectId: p.id })) known.add(a.relPath);
  const store = createArtifactStore({ userDataDir, clock: { now: () => epochMs(Date.now() + 2 * 60 * 60 * 1000) } });
  await store.sweepOrphans(known);
  const files = await listFiles(join(userDataDir, 'artifacts'), userDataDir);
  expect(files.filter((f) => f.includes('.tmp')), 'temp artifact files').toEqual([]);
  expect(files.filter((f) => !f.endsWith('.purged') && !known.has(f)), 'unreferenced artifact files').toEqual([]);
}

/** All four K4 invariants. `dbPath` is `<userData>/relay.sqlite`. */
export async function expectStorageInvariants(db: Db, userDataDir: string): Promise<void> {
  expectNoNegativeReserved(db);
  for (const run of allRuns(db)) expectLedgerMatchesAttempts(db, run.id);
  expect(integrityCheck(join(userDataDir, 'relay.sqlite'))).toBe('ok');
  await expectNoOrphanArtifacts(db, userDataDir);
}
