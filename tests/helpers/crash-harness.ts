/**
 * Crash harness (11 §K4): forks `runner-child.ts` as a REAL separate Node process (tsx loader + the workspace
 * "development" export condition), optionally with `RELAY_CRASH_AT=<hook>@<stepKey>[#n]`, and collects its IPC messages
 * and exit code. A crash is `process.exit(137)` inside the child, never a simulated throw.
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RunId, RunStatus } from '@relay/contracts';
import type { ChildJob, ChildMessage } from './runner-child.js';

export type { ChildAction, ChildJob, ChildMessage } from './runner-child.js';

const CHILD_PATH = fileURLToPath(new URL('./runner-child.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Only what Node + tsx need (never the parent's secrets). */
function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG', 'TZ']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export interface ChildResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly messages: readonly ChildMessage[];
  readonly stderr: string;
  /** runId from a `started` message, or the job's. */
  readonly runId: RunId | undefined;
  /** The last reported status. */
  readonly status: RunStatus | undefined;
}

export interface ForkOptions {
  /** `<hook>@<stepKey>[#n]`; absent → no crash hook. */
  readonly crashAt?: string;
  /** SIGKILL the child as soon as it reports a status (row 7). Implies `job.stayAlive`. */
  readonly killOnStatus?: boolean;
  /** Hard timeout for the child (default 60 s). */
  readonly timeoutMs?: number;
}

/** Forks the runner child with `job` and resolves when it exits. */
export function runChild(job: ChildJob, o: ForkOptions = {}): Promise<ChildResult> {
  const child = fork(CHILD_PATH, [], {
    cwd: REPO_ROOT,
    execArgv: ['--import', 'tsx', '--conditions=development'], // 01 §R4-18
    env: { ...minimalEnv(), RELAY_E2E: '1', ...(o.crashAt === undefined ? {} : { RELAY_CRASH_AT: o.crashAt }) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages: ChildMessage[] = [];
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString('utf8');
  });
  child.stdout?.on('data', () => undefined);
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`runner child timed out; messages=${JSON.stringify(messages)} stderr=${stderr.slice(-2000)}`));
    }, o.timeoutMs ?? 60_000);
    child.on('message', (m) => {
      const msg = m as ChildMessage;
      messages.push(msg);
      if (msg.type === 'status' && o.killOnStatus === true) child.kill('SIGKILL');
    });
    child.on('error', (e) => {
      globalThis.clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (exitCode, signal) => {
      globalThis.clearTimeout(timer);
      const started = messages.find((m) => m.type === 'started');
      const status = messages.findLast((m) => m.type === 'status');
      resolve({
        exitCode, signal, messages, stderr,
        runId: started?.type === 'started' ? started.runId : job.runId,
        status: status?.type === 'status' ? status.status : undefined,
      });
    });
    child.send({ ...job, stayAlive: job.stayAlive ?? o.killOnStatus ?? false });
  });
}

/** Throws with the child's diagnostics unless it exited with `expected`. */
export function expectExit(r: ChildResult, expected: number): void {
  if (r.exitCode !== expected) {
    const err = r.messages.find((m) => m.type === 'error');
    throw new Error(`runner child exited ${String(r.exitCode)} (signal ${String(r.signal)}), expected ${String(expected)}; `
      + `error=${err?.type === 'error' ? err.message : 'none'} stderr=${r.stderr.slice(-2000)}`);
  }
}
