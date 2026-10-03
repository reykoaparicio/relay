// 08 H7 runner entry (utility process). Waits for main's `init` carrying the private MessagePort, attaches the
// protocol server (listener first, then port.start()), composes the runtime, and posts `ready`.
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createIdGen, fatalInfoOf, redactString, systemClock } from '@relay/contracts';
import { bootRunner, readRunnerEnv } from './compose.js';
import { createRunnerLogger } from './logger.js';
import { readMaintenanceTask, runMaintenanceTask } from './maintenance.js';
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
  const task = readMaintenanceTask(process.env);
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
    if (task !== undefined) {
      // Maintenance mode: one task, never the engine (the live DB is not opened), then exit.
      logger.info('runner.maintenance', { pid: process.pid, task });
      void runMaintenanceTask(task, { userDataDir: env.RELAY_USER_DATA_DIR, homeDir: homedir() }).then((result) => {
        logger.info('runner.maintenance_done', { task, outcome: result.ok ? 'ok' : 'error', ...(result.ok ? { restored: result.restored } : { code: result.error.code }) });
        server.sendMaintenanceResult(task, result);
        setTimeout(() => process.exit(0), FATAL_EXIT_DELAY_MS);
      });
      return;
    }
    logger.info('runner.start', { pid: process.pid, providerMode: env.RELAY_PROVIDER_MODE });
    bootRunner(env, server, { logger, exit }).catch((err: unknown) => {
      // Main gets the curated, user-presentable {code, reason?, message}; the raw (redacted) error goes to the log only.
      const info = fatalInfoOf(err);
      const raw = redactString(err instanceof Error ? err.message : String(err)).slice(0, 400);
      logger.error('runner.fatal', { outcome: 'error', code: info.code, reason: info.reason, err: raw });
      server.sendFatal(info.code, info.message, info.reason);
      setTimeout(() => process.exit(1), FATAL_EXIT_DELAY_MS);
    });
  });
}

main();
