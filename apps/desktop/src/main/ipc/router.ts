// 08 H4: the IPC pipeline per operation: senderCheck → rateLimit → validateInput → route (main | runner | composite)
// → mapError → validateOutput (dev only). Only OPERATIONS are registered; INTERNAL_RUNNER_OPS never are.
import { OPERATION_LIST, RATE_LIMITS, UNIVERSAL_ERROR_CODES, appError, errors, redactDeep, toAppError, toValidationIssues } from '@relay/contracts';
import type { AnyOperationDef, AppError, IdGen, IpcEnvelope, RunnerChannel } from '@relay/contracts';
import type { MainLogger } from '../logger.js';
import type { RateLimiter } from './rate-limit.js';
import type { CompositeChannel, HandlerTable, MainChannel, RunnerRequester } from './types.js';

/** The part of an `IpcMainInvokeEvent` the router reads. */
export interface IpcEventLike {
  readonly senderFrame: { readonly url: string; readonly parent: unknown } | null;
}

/** The part of `ipcMain` the router uses. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, raw: unknown) => Promise<unknown>): void;
}

/** Where the renderer may legitimately be loaded from. */
export interface TrustedOrigin {
  readonly isPackaged: boolean;
  /** `pathToFileURL(<out>/renderer/index.html).href`. */
  readonly rendererFileUrl: string;
  /** electron-vite dev server URL (`ELECTRON_RENDERER_URL`), honored only when unpackaged. */
  readonly devServerUrl: string | undefined;
}

/** Dependencies of {@link createIpcRouter}. */
export interface RouterDeps extends TrustedOrigin {
  readonly ipcMain: IpcMainLike;
  readonly logger: MainLogger;
  readonly ids: IdGen;
  readonly limiter: RateLimiter;
  /** Monotonic ms (performance.now). */
  readonly now: () => number;
  readonly mainHandlers: HandlerTable<MainChannel>;
  readonly composite: HandlerTable<CompositeChannel>;
  readonly runner: RunnerRequester;
  /** Defaults to every renderer-exposed operation. */
  readonly operations?: readonly AnyOperationDef[];
}

/** The router. `invoke` runs the pipeline directly (tests; `register` wires it to `ipcMain`). */
export interface IpcRouter {
  register(): void;
  invoke(channel: string, event: IpcEventLike, raw: unknown): Promise<IpcEnvelope<unknown>>;
}

function stripHash(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** True when `url` is the app entry: the exact renderer file URL, or (unpackaged only) the dev server origin. */
export function isAppEntryUrl(url: string, o: TrustedOrigin): boolean {
  const bare = stripHash(url);
  if (bare === o.rendererFileUrl) return true;
  if (o.isPackaged || o.devServerUrl === undefined || o.devServerUrl === '') return false;
  const devOrigin = originOf(o.devServerUrl);
  return devOrigin !== null && devOrigin !== 'null' && originOf(bare) === devOrigin;
}

/** 08 H4 sender check: a live top-level frame whose URL is the app entry. */
export function isTrustedSender(event: IpcEventLike, o: TrustedOrigin): boolean {
  const frame = event.senderFrame;
  if (frame === null) return false;
  if (frame.parent !== null && frame.parent !== undefined) return false;
  return isAppEntryUrl(frame.url, o);
}

type AnyHandler = (input: unknown) => Promise<IpcEnvelope<unknown>>;

/** Creates the router. */
export function createIpcRouter(deps: RouterDeps): IpcRouter {
  const operations = deps.operations ?? OPERATION_LIST;
  const byChannel = new Map(operations.map((op) => [op.channel as string, op]));
  const mainTable = deps.mainHandlers as unknown as Readonly<Record<string, AnyHandler>>;
  const compositeTable = deps.composite as unknown as Readonly<Record<string, AnyHandler>>;
  const runnerRequest = deps.runner.request.bind(deps.runner) as (c: RunnerChannel, i: unknown) => Promise<IpcEnvelope<unknown>>;

  const route = (op: AnyOperationDef, input: unknown): Promise<IpcEnvelope<unknown>> => {
    const table = op.route === 'main' ? mainTable : op.route === 'main+runner' ? compositeTable : null;
    if (table === null) return runnerRequest(op.channel as RunnerChannel, input);
    const handler = table[op.channel];
    if (handler === undefined) throw new Error(`no handler for ${op.channel}`);
    return handler(input);
  };

  const devChecks = (op: AnyOperationDef, result: IpcEnvelope<unknown>): void => {
    if (deps.isPackaged) return;
    if (result.ok) {
      op.output.parse(result.data); // throws → INTERNAL (a contract bug, visible in dev)
      return;
    }
    const documented: readonly string[] = [...op.errors, ...UNIVERSAL_ERROR_CODES, 'PERMISSION_DENIED'];
    if (!documented.includes(result.error.code)) {
      deps.logger.warn({ event: 'ipc.undocumented_error', channel: op.channel, code: result.error.code });
    }
  };

  const pipeline = async (op: AnyOperationDef, event: IpcEventLike, raw: unknown): Promise<IpcEnvelope<unknown>> => {
    if (!isTrustedSender(event, deps)) {
      return { ok: false, error: appError('PERMISSION_DENIED', { userMessage: 'This window may not call Relay.', details: { reason: 'untrusted_sender' } }) };
    }
    const taken = deps.limiter.take(op.channel, op.rateLimit ?? RATE_LIMITS.default);
    if (!taken.ok) return { ok: false, error: errors.rateLimited(taken.retryAfterMs) };
    const input = op.input.safeParse(raw);
    if (!input.success) return { ok: false, error: errors.validationFailed(toValidationIssues(input.error.issues)) };
    const result = await route(op, input.data);
    devChecks(op, result);
    return result;
  };

  const invoke = async (channel: string, event: IpcEventLike, raw: unknown): Promise<IpcEnvelope<unknown>> => {
    const correlationId = deps.ids.next('correlation');
    const t0 = deps.now();
    const op = byChannel.get(channel);
    let result: IpcEnvelope<unknown>;
    if (op === undefined) {
      result = { ok: false, error: errors.notFound('channel') };
    } else {
      try {
        result = await pipeline(op, event, raw);
      } catch (e) {
        deps.logger.error({ event: 'ipc.error', channel, correlationId, outcome: 'error', err: redactDeep(serializeError(e)) });
        const mapped: AppError = toAppError(e, correlationId);
        result = { ok: false, error: mapped.code === 'INTERNAL' ? errors.internal(correlationId) : mapped };
      }
    }
    deps.logger.info({
      event: 'ipc.op', channel, correlationId, durationMs: Math.round(deps.now() - t0),
      outcome: result.ok ? 'ok' : 'error', ...(result.ok ? {} : { code: result.error.code }),
    });
    return result;
  };

  return {
    invoke,
    register() {
      for (const op of operations) deps.ipcMain.handle(op.channel, (event, raw) => invoke(op.channel, event, raw));
    },
  };
}

function serializeError(e: unknown): { name: string; message: string } {
  return e instanceof Error ? { name: e.name, message: e.message } : { name: 'NonError', message: String(e) };
}
