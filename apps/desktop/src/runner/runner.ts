// 08 H7 runner entry (utility process). Waits for main's `init` carrying the private MessagePort, attaches the
// protocol server (listener first, then port.start()), composes the runtime, and posts `ready`.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createIdGen, isRelayError, redactString, systemClock } from '@relay/contracts';
import { bootRunner, readRunnerEnv } from './compose.js';
import { createRunnerLogger } from './logger.js';
import { createProtocolServer } from './protocol-server.js';
import type { RunnerPortLike } from './protocol-server.js';

interface ParentPortLike {
  once(event: 'message', listener: (e: { data: unknown; ports: RunnerPortLike[] }) => void): unknown;
}

const FATAL_EXIT_DELAY_MS = 200;

function main(): void {
  const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  if (parentPort === undefined) {
    process.stderr.write('relay-runner must run as an Electron utility process\n');
    process.exit(1);
  }
  const env = readRunnerEnv(process.env);
  const logger = createRunnerLogger(join(env.RELAY_USER_DATA_DIR, 'logs'));
  const ids = createIdGen(systemClock, (n) => new Uint8Array(randomBytes(n)));
  const exit = (code: number): never => process.exit(code);
  process.on('uncaughtException', (e) => {
    logger.error('runner.uncaught', { outcome: 'error', err: redactString(e.message) });
    process.exit(1);
  });

  parentPort.once('message', (e) => {
    const port = e.ports[0];
    if (port === undefined) {
      logger.error('runner.no_port', { outcome: 'error' });
      process.exit(1);
    }
    const server = createProtocolServer({
      port, logger, pid: process.pid, exit, now: Date.now,
      correlationId: () => ids.next('correlation'),
      timers: {
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (h) => {
          clearTimeout(h as NodeJS.Timeout);
        },
        setInterval: (cb, ms) => setInterval(cb, ms),
        clearInterval: (h) => {
          clearInterval(h as NodeJS.Timeout);
        },
      },
    });
    logger.info('runner.start', { pid: process.pid, providerMode: env.RELAY_PROVIDER_MODE });
    bootRunner(env, server, { logger, exit }).catch((err: unknown) => {
      const code = isRelayError(err) ? err.appError.code : 'INTERNAL';
      const message = redactString(err instanceof Error ? err.message : String(err)).slice(0, 400);
      logger.error('runner.fatal', { outcome: 'error', code, err: message });
      server.sendFatal(code, message);
      setTimeout(() => process.exit(1), FATAL_EXIT_DELAY_MS);
    });
  });
}

main();
