/**
 * Test-only file reader for the token tests. Vitest replaces CSS imports (including `?raw`) with
 * empty strings, so the tests must read the real bytes from disk. The renderer bans Node imports
 * (§6.3), and this helper is never imported by app code; it reaches `fs` through Node's
 * `process.getBuiltinModule` only when running under Vitest (cwd = repo root, where vitest.config.ts lives).
 */
interface MinimalFs {
  readFileSync(path: string): Uint8Array;
}
interface NodeProcess {
  cwd(): string;
  getBuiltinModule(id: 'node:fs'): MinimalFs;
}

/** Reads a file by its path relative to the repository root. */
export function readRepoFileBytes(repoRelativePath: string): Uint8Array {
  const proc = (globalThis as unknown as { process?: NodeProcess }).process;
  if (proc === undefined) throw new Error('readRepoFileBytes is only available in Node-based tests');
  return proc.getBuiltinModule('node:fs').readFileSync(`${proc.cwd()}/${repoRelativePath}`);
}

export function readRepoFileText(repoRelativePath: string): string {
  return new TextDecoder('utf-8').decode(readRepoFileBytes(repoRelativePath));
}
