// Test-only helpers for @relay/tools unit tests (excluded from coverage and from the public index).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArtifactId, Clock, EpochMs } from '@relay/contracts';
import { createIdGen, epochMs } from '@relay/contracts';

/** Tracks temp dirs created under `os.tmpdir()` so `cleanup()` can remove them (call it in `afterEach`). */
export interface TempDirs {
  make(prefix?: string): Promise<string>;
  cleanup(): Promise<void>;
}

async function makeWritable(dir: string): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  await fs.promises.chmod(dir, 0o755).catch(() => undefined);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await makeWritable(p);
    else if (e.isFile()) await fs.promises.chmod(p, 0o644).catch(() => undefined);
  }
}

/** Creates a temp-dir tracker. `make()` returns the realpath (on macOS `/var` → `/private/var`). */
export function tempDirs(): TempDirs {
  const created: string[] = [];
  return {
    async make(prefix = 'relay-tools-') {
      const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix)));
      created.push(dir);
      return dir;
    },
    async cleanup() {
      for (const dir of created.splice(0)) {
        await makeWritable(dir);
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Writes `files` (relPath → content) under `root`, creating parent directories. */
export async function writeTree(root: string, files: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
  }
}

/** A settable clock for deterministic tests. */
export function fakeClock(start = 1_760_000_000_000): Clock & { set(ms: number): void } {
  let now: EpochMs = epochMs(start);
  return {
    now: () => now,
    set(ms: number) {
      now = epochMs(ms);
    },
  };
}

/** Real ULID-based artifact id generator. */
export function artifactIds(clock: Clock = fakeClock()): () => ArtifactId {
  const gen = createIdGen(clock, (n) => new Uint8Array(randomBytes(n)));
  return () => gen.next('artifact');
}
