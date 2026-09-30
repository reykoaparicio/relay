// 08 H2: the preload bridge — a small, typed, allowlisted IPC surface (§6.3). Bundled as one sandbox-safe CJS file:
// @relay/contracts and zod are inlined. Never exposes ipcRenderer, require, process.env, or any filesystem API.
import { contextBridge, ipcRenderer } from 'electron';
import { EVENTS_CHANNEL, OPERATION_LIST, appError, pushEventSchema } from '@relay/contracts';
import type { Channel, InputOf, IpcResult, PushEvent } from '@relay/contracts';

// Renderer-exposed operations only; INTERNAL_RUNNER_OPS are never in OPERATIONS.
const ALLOWED: ReadonlySet<string> = new Set(OPERATION_LIST.map((o) => o.channel));

const api = {
  invoke<C extends Channel>(channel: C, input: InputOf<C>): Promise<IpcResult<C>> {
    if (!ALLOWED.has(channel)) {
      return Promise.resolve({ ok: false, error: appError('PERMISSION_DENIED', { details: { reason: 'channel_not_allowed' } }) });
    }
    return ipcRenderer.invoke(channel, input) as Promise<IpcResult<C>>; // main validates; the preload does not trust itself
  },
  subscribe(listener: (e: PushEvent) => void): () => void {
    const handler = (_event: unknown, payload: unknown): void => {
      const parsed = pushEventSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(EVENTS_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(EVENTS_CHANNEL, handler);
    };
  },
  platform: process.platform, // keyboard hints only
} as const;

contextBridge.exposeInMainWorld('relay', api);

/** The exposed bridge type. */
export type RelayBridge = typeof api;
