// 13 §M3: the demo scripts compose the engine only through `createRuntime` from @relay/engine (06 F16), always in FAKE
// provider mode: preparing and verifying demo state never dispatches a live request and never spends money.
import { ok } from '@relay/contracts';
import type { RunnerChannel, RunnerInputOf, RunnerOutputOf } from '@relay/contracts';
import { createRuntime } from '@relay/engine';
import type { EngineTestHooks, Logger, Runtime } from '@relay/engine';

/** A logger that keeps lines in memory (printed only when something fails), so no log file lands in a snapshot. */
export function memoryLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  const at = (level: string) => (event: string, fields?: Readonly<Record<string, unknown>>) => {
    lines.push(JSON.stringify({ level, event, ...fields }));
  };
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** A fake-mode runtime over `userDataDir`. The engine is not started; callers decide. */
export async function openFakeRuntime(userDataDir: string, o: { hooks?: EngineTestHooks; logger?: Logger } = {}): Promise<Runtime> {
  return createRuntime({
    userDataDir,
    providerMode: 'fake',
    fakeScenario: 'happy-path',
    // Fake mode ignores the key; it only has to be non-empty.
    credentials: { resolve: () => Promise.resolve(ok('demo-fake-key-not-a-secret')) },
    logger: o.logger ?? memoryLogger(),
    ...(o.hooks === undefined ? {} : { hooks: o.hooks }),
    idleMs: 25,
  });
}

/** Typed IPC call that throws on an error envelope. */
export async function callOk<C extends RunnerChannel>(rt: Runtime, channel: C, input: RunnerInputOf<C>): Promise<RunnerOutputOf<C>> {
  const res = await rt.engine.handle(channel, input);
  if (!res.ok) throw new Error(`${channel}: ${res.error.code} ${JSON.stringify(res.error.details ?? null)}`);
  return res.data;
}

/** Real-time sleep for polling. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => globalThis.setTimeout(r, ms));
}

/** Polls `cond` until it holds. */
export async function waitUntil(cond: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}
