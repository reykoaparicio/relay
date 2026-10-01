// 08 H2: the preload bridge — a small, typed, allowlisted IPC surface (§6.3). Electron-free so it can be unit-tested
// with a fake ipcRenderer; index.ts exposes it. Never exposes ipcRenderer, require, process.env, or any filesystem API.
import { EVENTS_CHANNEL, OPERATION_LIST, appError, pushEventSchema } from '@relay/contracts';
import type { Channel, InputOf, IpcResult, PushEvent } from '@relay/contracts';

/** The part of Electron's `ipcRenderer` the bridge uses. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
}

// Renderer-exposed operations only; INTERNAL_RUNNER_OPS are never in OPERATIONS.
const ALLOWED: ReadonlySet<string> = new Set(OPERATION_LIST.map((o) => o.channel));

/** Builds the `window.relay` API over `ipc`. */
export function createRelayApi(ipc: IpcRendererLike, platform: NodeJS.Platform) {
  return {
    invoke<C extends Channel>(channel: C, input: InputOf<C>): Promise<IpcResult<C>> {
      if (!ALLOWED.has(channel)) {
        return Promise.resolve({ ok: false, error: appError('PERMISSION_DENIED', { details: { reason: 'channel_not_allowed' } }) });
      }
      return ipc.invoke(channel, input) as Promise<IpcResult<C>>; // main validates; the preload does not trust itself
    },
    subscribe(listener: (e: PushEvent) => void): () => void {
      const handler = (_event: unknown, payload: unknown): void => {
        const parsed = pushEventSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipc.on(EVENTS_CHANNEL, handler);
      return () => {
        ipc.removeListener(EVENTS_CHANNEL, handler);
      };
    },
    platform, // keyboard hints only
  } as const;
}

/** The exposed bridge type. */
export type RelayBridge = ReturnType<typeof createRelayApi>;
