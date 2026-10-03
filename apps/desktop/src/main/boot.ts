// 08 H1 boot order (binding; unit-tested): userData override → userData writable check → single-instance lock →
// provider mode → whenReady → session policy → layout (+ launch marker) → ipc.register (before any window) → main
// window → supervisor.start (failure tolerated). Any boot failure shows a native error box and exits (startApp).
import { isE2eAllowed, packagedE2eAllowedByBuild, resolveProviderMode, resolveUserDataOverride } from './app-paths.js';
import type { ProviderModeConfig } from './app-paths.js';
import type { MainLogger } from './logger.js';
import { unwritableUserDataMessage } from './userdata-check.js';
import type { WritableCheck } from './userdata-check.js';

/** The part of Electron's `app` boot uses. */
export interface BootApp {
  readonly isPackaged: boolean;
  setPath(name: 'userData', path: string): void;
  getPath(name: 'userData'): string;
  requestSingleInstanceLock(): boolean;
  quit(): void;
  exit(code: number): void;
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
  /** Creates the userData layout and records this launch in the shutdown marker. */
  ensureLayout(): Promise<void>;
  registerIpc(): void;
  createMainWindow(): void;
  /** Focuses the main window, re-creating it when it was closed. */
  focusMainWindow(): void;
  readonly supervisor: { start(): Promise<void>; shutdown(opts: { graceMs: number }): Promise<void> };
  /** The run with a provider request possibly in flight (runner heartbeat), or null. */
  activeRunId(): string | null;
  /** Native confirmation "A run is in progress…"; true = quit anyway. Called only while a run is active. */
  confirmQuitDuringRun(): boolean;
  /** Writes the clean-quit marker (never rejects). */
  recordCleanQuit(runActive: boolean): Promise<void>;
  flushLogs(): Promise<void>;
}

/** Dependencies of {@link boot}. */
export interface BootDeps {
  readonly app: BootApp;
  readonly env: NodeJS.ProcessEnv;
  readonly createServices: (cfg: BootConfig) => BootServices;
  /** userData writability probe (runs before the single-instance lock). */
  readonly checkWritable: (dir: string) => WritableCheck;
  /** `dialog.showErrorBox` (safe to call before `ready`). */
  readonly showErrorBox: (title: string, content: string) => void;
  /** Build-time permission for RELAY_E2E in a packaged build (default: the inlined MAIN_VITE_RELAY_PACKAGED_E2E). */
  readonly packagedE2eAllowed?: boolean;
}

/** Grace period for the runner to finish an in-flight checkpoint on quit. */
export const QUIT_GRACE_MS = 5_000;

/**
 * Runs the main-process boot sequence. Resolves null when userData is not writable (after an error box) or another
 * instance holds the lock.
 */
export async function boot(deps: BootDeps): Promise<BootServices | null> {
  const { app, env } = deps;
  const packagedE2e = deps.packagedE2eAllowed ?? packagedE2eAllowedByBuild();
  const override = resolveUserDataOverride(app.isPackaged, env, packagedE2e);
  if (override !== null) app.setPath('userData', override); // before the lock: the lock is scoped to userData
  // The lock (and everything after it) creates files in userData: a folder Relay cannot write to must be reported,
  // never mistaken for "another instance is running".
  const userData = app.getPath('userData');
  const writable = deps.checkWritable(userData);
  if (!writable.ok) {
    const m = unwritableUserDataMessage(userData, writable.errno);
    deps.showErrorBox(m.title, m.content);
    app.exit(1);
    return null;
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit(); // another instance holds the lock; it focuses its window on `second-instance`
    return null;
  }
  const cfg: BootConfig = {
    ...resolveProviderMode(app.isPackaged, env, packagedE2e),
    userDataOverridden: override !== null,
    e2e: isE2eAllowed(app.isPackaged, env, packagedE2e),
  };

  let services: BootServices | null = null;
  let quitting = false;
  app.on('second-instance', () => services?.focusMainWindow());
  app.on('window-all-closed', () => {
    app.quit();
  });
  app.on('before-quit', (e) => {
    if (quitting) return; // second call: never prevent, never re-enter
    if (services === null) {
      quitting = true; // boot stops at its next await: no window, no runner fork after quit began
      return; // nothing started yet: let the quit proceed
    }
    const s = services;
    const runId = s.activeRunId();
    if (runId !== null && !s.confirmQuitDuringRun()) {
      e.preventDefault(); // the user chose to keep Relay open
      s.logger.info({ event: 'app.quit_cancelled', reason: 'run_in_progress', runId, outcome: 'ok' });
      s.focusMainWindow();
      return;
    }
    quitting = true;
    e.preventDefault();
    void (async () => {
      try {
        await s.supervisor.shutdown({ graceMs: QUIT_GRACE_MS });
      } catch (err) {
        s.logger.error({ event: 'runner.shutdown_failed', outcome: 'error', err: err instanceof Error ? err.message : String(err) });
      }
      await s.recordCleanQuit(runId !== null).catch(() => undefined);
      s.logger.info({ event: 'app.quit', runActive: runId !== null, outcome: 'ok' });
      await s.flushLogs().catch(() => undefined);
      app.quit();
    })();
  });

  // `quitting` is re-read after every await (a function call keeps TS from narrowing it to its initial value).
  const quitRequested = (): boolean => quitting;
  await app.whenReady();
  if (quitRequested()) return null;
  const s = deps.createServices(cfg);
  services = s;
  s.applySessionPolicy();
  await s.ensureLayout();
  if (quitRequested()) {
    s.logger.info({ event: 'app.boot_aborted', reason: 'quitting', outcome: 'ok' });
    return s;
  }
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

/** The error box shown when boot itself fails (an unexpected exception, never a runner failure). */
export function bootFailureMessage(err: unknown, userData: string | null): { title: string; content: string } {
  const detail = err instanceof Error ? err.message : String(err);
  const where = userData === null ? '' : `\n\nRelay's data folder:\n${userData}`;
  return {
    title: 'Relay could not start',
    content: `Something went wrong while starting Relay:\n\n${detail.slice(0, 500)}${where}\n\nOpen Relay again. If this keeps happening, check that the data folder is writable and that the disk is not full.`,
  };
}

/** The Electron entry: {@link boot}, with any rejection reported in a native error box, then exit(1). */
export async function startApp(deps: BootDeps): Promise<BootServices | null> {
  try {
    return await boot(deps);
  } catch (err) {
    let userData: string | null = null;
    try {
      userData = deps.app.getPath('userData');
    } catch {
      // unknown
    }
    try {
      process.stderr.write(`relay: boot failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    } catch {
      // stderr closed
    }
    const m = bootFailureMessage(err, userData);
    try {
      deps.showErrorBox(m.title, m.content);
    } finally {
      deps.app.exit(1);
    }
    return null;
  }
}
