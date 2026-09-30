/**
 * No-network guard (00b §7, 11 §K3). Loaded as a Vitest setup file (unit + integration projects) and imported FIRST by
 * the crash child (`runner-child.ts`) and the budget-contention workers.
 *
 * Patches `net.Socket.prototype.connect`, `tls.connect`, and `globalThis.fetch` so any attempt to open an outbound
 * connection throws {@link NetworkForbiddenError}. Local IPC (fork channels, worker MessagePorts, stdio pipes) never
 * goes through these entry points and keeps working. Disabled when `RELAY_LIVE_TESTS=1` (the live project).
 */
import net from 'node:net';
import tls from 'node:tls';

/** Thrown for every blocked network attempt. */
export class NetworkForbiddenError extends Error {
  constructor(target: string) {
    super(`Network access is forbidden in tests (attempted: ${target}). Use the fake provider; set RELAY_LIVE_TESTS=1 for live tests.`);
    this.name = 'NetworkForbiddenError';
  }
}

const INSTALLED = Symbol.for('relay.noNetwork.installed');

function describeTarget(args: readonly unknown[]): string {
  const [first, second] = args;
  if (typeof first === 'object' && first !== null) {
    const o = first as { host?: unknown; port?: unknown; path?: unknown };
    if (typeof o.path === 'string') return `ipc:${o.path}`;
    return `${typeof o.host === 'string' ? o.host : 'localhost'}:${typeof o.port === 'number' || typeof o.port === 'string' ? String(o.port) : '?'}`;
  }
  if (typeof first === 'number' || typeof first === 'string') return `${typeof second === 'string' ? second : 'localhost'}:${String(first)}`;
  return 'unknown';
}

/** Installs the guard once per process. Returns whether it is active. */
export function installNoNetwork(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['RELAY_LIVE_TESTS'] === '1') return false;
  const g = globalThis as typeof globalThis & { [INSTALLED]?: boolean };
  if (g[INSTALLED] === true) return true;
  g[INSTALLED] = true;

  // `net.connect`, `http.request`, and friends all end in Socket.prototype.connect.
  net.Socket.prototype.connect = function blockedConnect(this: net.Socket, ...args: unknown[]): never {
    throw new NetworkForbiddenError(describeTarget(args));
  };
  tls.connect = function blockedTlsConnect(...args: unknown[]): never {
    throw new NetworkForbiddenError(`tls ${describeTarget(args)}`);
  };
  globalThis.fetch = function blockedFetch(input: unknown): Promise<Response> {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : 'unknown';
    return Promise.reject(new NetworkForbiddenError(`fetch ${target}`));
  };
  return true;
}

installNoNetwork();
