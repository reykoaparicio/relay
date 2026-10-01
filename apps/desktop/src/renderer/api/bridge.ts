// The only module that touches `window.relay` (10 J2). Everything else calls `api/client.ts`.
import type { Channel, InputOf, IpcResult, PushEvent } from '@relay/contracts';

/** The preload surface (08 H2): typed invoke plus push subscription. */
export interface RelayBridge {
  invoke<C extends Channel>(channel: C, input: InputOf<C>): Promise<IpcResult<C>>;
  subscribe(listener: (e: PushEvent) => void): () => void;
}

declare global {
  interface Window {
    /** Exposed by the preload (08 H2); absent under the fake bridge (dev renderer, tests). */
    readonly relay?: RelayBridge;
  }
}

let installed: RelayBridge | null = null;

/**
 * Installs a bridge used instead of `window.relay`: the fake bridge in `pnpm dev:renderer` and in tests
 * (main.tsx installs it behind an `import.meta.env.DEV || MODE === 'test'` guard, so production bundles never
 * contain the fake). Pass `null` to uninstall.
 */
export function installBridge(bridge: RelayBridge | null): void {
  installed = bridge;
}

/** True when the preload exposed the real bridge. */
export function hasPreloadBridge(): boolean {
  return window.relay !== undefined;
}

/**
 * The active bridge: an installed one (dev/test), else the preload's `window.relay`.
 * @throws Error when neither exists (production without a preload is a packaging bug, never silently faked).
 */
export function getBridge(): RelayBridge {
  if (installed !== null) return installed;
  const relay = window.relay;
  if (relay !== undefined) return relay;
  throw new Error('Relay bridge unavailable: window.relay is missing.');
}
