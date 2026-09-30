// 08 H7: a thin wrapper around createRuntime (06 §F16). H does no seeding or DB/provider wiring of its own.
import { join } from 'node:path';
import { createRuntime, parseCrashAt } from '@relay/engine';
import type { EngineTestHooks, Logger, Runtime } from '@relay/engine';
import { createJsonlCallLog } from '@relay/providers';
import type { ProtocolServer } from './protocol-server.js';

/** The runner's environment (set by main's `minimalEnv`). */
export interface RunnerEnv {
  readonly RELAY_USER_DATA_DIR: string;
  readonly RELAY_PROVIDER_MODE: 'live' | 'fake';
  readonly RELAY_FAKE_SCENARIO?: string;
  readonly RELAY_E2E?: string;
  readonly RELAY_CRASH_AT?: string;
}

/**
 * Reads the runner env. Anything but `fake` is `live`.
 * @throws Error when RELAY_USER_DATA_DIR is missing (main always sets it).
 */
export function readRunnerEnv(env: NodeJS.ProcessEnv): RunnerEnv {
  const userData = env['RELAY_USER_DATA_DIR'];
  if (userData === undefined || userData === '') throw new Error('RELAY_USER_DATA_DIR is not set');
  const pick = (k: string): Record<string, string> => {
    const v = env[k];
    return v === undefined || v === '' ? {} : { [k]: v };
  };
  return {
    RELAY_USER_DATA_DIR: userData,
    RELAY_PROVIDER_MODE: env['RELAY_PROVIDER_MODE'] === 'fake' ? 'fake' : 'live',
    ...pick('RELAY_FAKE_SCENARIO'),
    ...pick('RELAY_E2E'),
    ...pick('RELAY_CRASH_AT'),
  };
}

/** Crash hooks: parsed by F's parser only when RELAY_E2E=1 (ignored otherwise). Throws on an unparsable value. */
export function crashHooks(env: RunnerEnv, exit: (code: number) => never): EngineTestHooks | undefined {
  if (env.RELAY_E2E !== '1' || env.RELAY_CRASH_AT === undefined) return undefined;
  return parseCrashAt(env.RELAY_CRASH_AT, { exit });
}

/** Options of {@link compose}. */
export interface ComposeOptions {
  readonly logger: Logger;
  readonly exit: (code: number) => never;
}

/** Composes the runtime and starts the engine (recovery, 06 §F9). */
export async function compose(env: RunnerEnv, protocol: ProtocolServer, o: ComposeOptions): Promise<Runtime> {
  const userDataDir = env.RELAY_USER_DATA_DIR;
  const fake = env.RELAY_PROVIDER_MODE === 'fake';
  const hooks = crashHooks(env, o.exit);
  const runtime = await createRuntime({
    userDataDir,
    providerMode: fake ? 'fake' : 'live',
    ...(fake && env.RELAY_FAKE_SCENARIO !== undefined ? { fakeScenario: env.RELAY_FAKE_SCENARIO } : {}),
    ...(fake ? { callLog: createJsonlCallLog(join(userDataDir, 'fake-call-log.jsonl')) } : {}),
    ...(hooks === undefined ? {} : { hooks }),
    credentials: { resolve: (req) => protocol.requestCredential(req) },
    emit: (e) => {
      protocol.sendEvent(e);
    },
    logger: o.logger,
  });
  await runtime.engine.start();
  return runtime;
}

/** compose → attach → `ready` (posted only after engine.start() resolved). */
export async function bootRunner(env: RunnerEnv, protocol: ProtocolServer, o: ComposeOptions): Promise<Runtime> {
  const runtime = await compose(env, protocol, o);
  protocol.attach(runtime);
  protocol.sendReady(runtime.db.schemaVersion());
  return runtime;
}
