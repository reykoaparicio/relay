// 08 H1 boot order (binding; unit-tested): userData override → single-instance lock → provider mode → whenReady →
// session policy → layout → ipc.register (before any window) → main window → supervisor.start (failure tolerated).
import { resolveProviderMode, resolveUserDataOverride } from './app-paths.js';
import type { ProviderModeConfig } from './app-paths.js';
import type { MainLogger } from './logger.js';

/** The part of Electron's `app` boot uses. */
export interface BootApp {
  readonly isPackaged: boolean;
  setPath(name: 'userData', path: string): void;
  requestSingleInstanceLock(): boolean;
  quit(): void;
  whenReady(): Promise<unknown>;
  on(event: 'second-instance' | 'window-all-closed', listener: () => void): unknown;
  on(event: 'before-quit', listener: (e: { preventDefault(): void }) => void): unknown;
}

/** Effective boot configuration handed to the composition root. */
export interface BootConfig extends ProviderModeConfig {
  readonly userDataOverridden: boolean;
  readonly e2e: boolean;
}

/** Services created after `ready` (the composition root). */
export interface BootServices {
  readonly logger: MainLogger;
  applySessionPolicy(): void;
  ensureLayout(): Promise<void>;
  registerIpc(): void;
  createMainWindow(): void;
  focusMainWindow(): void;
  readonly supervisor: { start(): Promise<void>; shutdown(opts: { graceMs: number }): Promise<void> };
  flushLogs(): Promise<void>;
}

/** Dependencies of {@link boot}. */
export interface BootDeps {
  readonly app: BootApp;
  readonly env: NodeJS.ProcessEnv;
  readonly createServices: (cfg: BootConfig) => BootServices;
}

/** Grace period for the runner to finish an in-flight checkpoint on quit. */
export const QUIT_GRACE_MS = 5_000;

/** Runs the main-process boot sequence. Resolves null when another instance holds the lock. */
export async function boot(deps: BootDeps): Promise<BootServices | null> {
  const { app, env } = deps;
  const override = resolveUserDataOverride(app.isPackaged, env);
  if (override !== null) app.setPath('userData', override); // before the lock: the lock is scoped to userData
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }
  const cfg: BootConfig = {
    ...resolveProviderMode(app.isPackaged, env),
    userDataOverridden: override !== null,
    e2e: env['RELAY_E2E'] === '1',
  };

  let services: BootServices | null = null;
  let quitting = false;
  app.on('second-instance', () => services?.focusMainWindow());
  app.on('window-all-closed', () => {
    app.quit();
  });
  app.on('before-quit', (e) => {
    if (quitting || services === null) return; // second call: never prevent, never re-enter
    e.preventDefault();
    quitting = true;
    const s = services;
    void (async () => {
      try {
        await s.supervisor.shutdown({ graceMs: QUIT_GRACE_MS });
      } catch (err) {
        s.logger.error({ event: 'runner.shutdown_failed', outcome: 'error', err: err instanceof Error ? err.message : String(err) });
      }
      await s.flushLogs().catch(() => undefined);
      app.quit();
    })();
  });

  await app.whenReady();
  const s = deps.createServices(cfg);
  services = s;
  s.applySessionPolicy();
  await s.ensureLayout();
  s.registerIpc();
  s.createMainWindow();
  s.logger.info({ event: 'app.boot', providerMode: cfg.providerMode, e2e: cfg.e2e, outcome: 'ok' });
  try {
    await s.supervisor.start();
  } catch (err) {
    // The window stays up; runner-routed ops return RUNNER_UNAVAILABLE and the renderer shows the banner.
    s.logger.error({ event: 'runner.start_failed', outcome: 'error', code: 'RUNNER_UNAVAILABLE', err: err instanceof Error ? err.message : String(err) });
  }
  return s;
}
