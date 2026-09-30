// 08 H7: the runner end of the main ↔ runner protocol (02 §B7). Validates every inbound message, routes `op`
// (public runner-routed and internal channels alike) to the engine, answers with `op.result`, forwards engine push
// events, requests credentials from main, and heartbeats every 2 s after `ready`.
import { RUNNER_HEARTBEAT_MS, appError, epochMs, errors, runnerMessageSchema, runnerRequestSchema } from '@relay/contracts';
import type { CorrelationId, ErrorCode, IpcEnvelope, PushEvent, Result, RunnerChannel, RunnerMessage } from '@relay/contracts';
import type { CredentialRequest, EngineApi, Logger, Timers } from '@relay/engine';

/** The part of `MessagePortMain` the runner uses. */
export interface RunnerPortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown;
  start(): void;
  postMessage(message: unknown): void;
  close(): void;
}

/** What the server needs from a composed runtime. */
export interface ServedRuntime {
  readonly engine: Pick<EngineApi, 'handle' | 'stop'>;
  dispose(): Promise<void>;
}

/** Dependencies of {@link createProtocolServer}. */
export interface ProtocolServerDeps {
  readonly port: RunnerPortLike;
  readonly logger: Logger;
  readonly now: () => number;
  readonly timers: Timers;
  readonly pid: number;
  readonly exit: (code: number) => void;
  /** Fresh `cor_…` id for an INTERNAL error (a bug in the handle wrapper itself). */
  readonly correlationId: () => CorrelationId;
  /** How long a credential request may wait for main (default 30 s). */
  readonly credentialTimeoutMs?: number;
}

/** The protocol server. */
export interface ProtocolServer {
  requestCredential(req: CredentialRequest): Promise<Result<string>>;
  sendEvent(e: PushEvent): void;
  attach(runtime: ServedRuntime): void;
  /** Posts `ready` and starts the heartbeat. Call only after `engine.start()` resolved. */
  sendReady(schemaVersion: number): void;
  sendFatal(code: ErrorCode, message: string): void;
}

const DEFAULT_CREDENTIAL_TIMEOUT_MS = 30_000;
type EngineHandle = (channel: RunnerChannel, input: unknown) => Promise<IpcEnvelope<unknown>>;

/** Creates the server, attaches the port listener, then calls `port.start()` (MessagePortMain queues until then). */
export function createProtocolServer(deps: ProtocolServerDeps): ProtocolServer {
  const { port, logger, timers } = deps;
  let runtime: ServedRuntime | null = null;
  let heartbeat: unknown = null;
  let seq = 0;
  const credentialWaiters = new Map<string, { resolve: (r: Result<string>) => void; timer: unknown }>();

  const post = (msg: RunnerMessage): void => {
    const checked = runnerMessageSchema.safeParse(msg);
    if (!checked.success) {
      logger.error('protocol.invalid_outbound', { kind: msg.kind, outcome: 'error' });
      return;
    }
    port.postMessage(msg);
  };

  const serveOp = async (id: string, channel: RunnerChannel, input: unknown): Promise<void> => {
    let result: IpcEnvelope<unknown>;
    if (runtime === null) result = { ok: false, error: appError('RUNNER_UNAVAILABLE', { details: { reason: 'starting' } }) };
    else {
      try {
        result = await (runtime.engine.handle as EngineHandle)(channel, input);
      } catch {
        result = { ok: false, error: errors.internal(deps.correlationId()) };
      }
    }
    post({ kind: 'op.result', id, result });
  };

  const shutdown = async (graceMs: number): Promise<void> => {
    if (heartbeat !== null) timers.clearInterval(heartbeat);
    heartbeat = null;
    try {
      if (runtime !== null) {
        await runtime.engine.stop({ graceMs });
        await runtime.dispose();
      }
      logger.info('runner.shutdown', { outcome: 'ok' });
      deps.exit(0);
    } catch (e) {
      logger.error('runner.shutdown_failed', { outcome: 'error', err: e instanceof Error ? e.message : String(e) });
      deps.exit(1);
    }
  };

  port.on('message', (e) => {
    const parsed = runnerRequestSchema.safeParse(e.data);
    if (!parsed.success) {
      logger.warn('protocol.invalid_message', { outcome: 'error' });
      return;
    }
    const msg = parsed.data;
    if (msg.kind === 'op') void serveOp(msg.id, msg.channel, msg.input);
    else if (msg.kind === 'shutdown') void shutdown(msg.graceMs);
    else {
      const w = credentialWaiters.get(msg.id);
      if (w === undefined) return;
      credentialWaiters.delete(msg.id);
      timers.clearTimeout(w.timer);
      w.resolve(msg.result.ok ? { ok: true, value: msg.result.apiKey } : { ok: false, error: msg.result.error });
    }
  });
  port.start();

  return {
    requestCredential(req) {
      seq += 1;
      const id = `cred-${String(seq)}`;
      return new Promise<Result<string>>((resolve) => {
        const timer = timers.setTimeout(() => {
          credentialWaiters.delete(id);
          resolve({ ok: false, error: appError('RUNNER_UNAVAILABLE', { details: { reason: 'credential_timeout' } }) });
        }, deps.credentialTimeoutMs ?? DEFAULT_CREDENTIAL_TIMEOUT_MS);
        credentialWaiters.set(id, { resolve, timer });
        post({ kind: 'credential.request', id, providerId: req.providerId, purpose: req.purpose, attemptId: req.attemptId });
      });
    },
    sendEvent(e) {
      post({ kind: 'event', event: e });
    },
    attach(r) {
      runtime = r;
    },
    sendReady(schemaVersion) {
      post({ kind: 'ready', schemaVersion, pid: deps.pid });
      logger.info('runner.ready', { schemaVersion, pid: deps.pid, outcome: 'ok' });
      heartbeat = timers.setInterval(() => {
        post({ kind: 'heartbeat', at: epochMs(Math.floor(deps.now())), activeRunId: null });
      }, RUNNER_HEARTBEAT_MS);
    },
    sendFatal(code, message) {
      post({ kind: 'fatal', code, message });
    },
  };
}

