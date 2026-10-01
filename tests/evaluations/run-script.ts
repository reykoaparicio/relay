/**
 * Runs a repo script (scripts/*.ts) in a child Node process with the tsx loader and the workspace "development"
 * condition, exactly like `pnpm demo:reset` / `pnpm evaluate`. The child gets a minimal env plus `env`: never this
 * process's secrets, and never RELAY_USER_DATA_DIR / RELAY_LIVE_TESTS unless a test passes them on purpose.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export interface ScriptResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runScript(script: string, args: readonly string[] = [], env: Readonly<Record<string, string>> = {}, timeoutMs = 120_000): Promise<ScriptResult> {
  const base: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ']) {
    const v = process.env[k];
    if (v !== undefined) base[k] = v;
  }
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', '--conditions=development', fileURLToPath(new URL(`../../scripts/${script}`, import.meta.url)), ...args],
      { cwd: REPO_ROOT, env: { ...base, ...env }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}
