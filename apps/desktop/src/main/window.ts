// 08 H1 main window: hardened webPreferences, shown on ready-to-show (no white flash) regardless of runner state.
// DevTools only when unpackaged, and never auto-opened under RELAY_E2E=1 (it breaks Playwright's firstWindow()).
// Renderer recovery: a crashed renderer is reloaded once automatically; a second crash soon after (or a hung renderer)
// asks the user to Reload or Quit instead of leaving a dead window.
import type { MainLogger } from './logger.js';

/** BrowserWindow options main uses (a subset of Electron's). */
export interface MainWindowOptions {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly show: false;
  readonly backgroundColor: string;
  readonly webPreferences: {
    readonly preload: string;
    readonly contextIsolation: true;
    readonly sandbox: true;
    readonly nodeIntegration: false;
    readonly webviewTag: false;
    readonly spellcheck: false;
    readonly devTools: boolean;
  };
}

/** The part of `BrowserWindow` main uses. */
export interface WindowLike {
  once(event: 'ready-to-show', listener: () => void): unknown;
  show(): void;
  focus(): void;
  isMinimized(): boolean;
  restore(): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  loadFile(path: string): Promise<void>;
  readonly webContents: WebContentsLike;
}

/** `render-process-gone` details (a subset of Electron's). */
export interface RenderProcessGoneDetails {
  readonly reason: string;
  readonly exitCode: number;
}

/** The part of `webContents` main uses. */
export interface WebContentsLike {
  openDevTools(): void;
  send(channel: string, payload: unknown): void;
  reload(): void;
  /** Kills the renderer process (Electron): the only way out of a renderer that is stuck in a loop. */
  forcefullyCrashRenderer(): void;
  on(event: 'did-finish-load' | 'unresponsive' | 'responsive', listener: () => void): unknown;
  on(event: 'render-process-gone', listener: (e: unknown, details: RenderProcessGoneDetails) => void): unknown;
}

/** What the user chose in the recovery dialog. */
export type RecoveryChoice = 'reload' | 'quit' | 'wait';

/** Dependencies of {@link attachRendererRecovery}. */
export interface RendererRecoveryDeps {
  readonly logger: MainLogger;
  /** Monotonic ms. */
  readonly now: () => number;
  /**
   * Native dialog. `crashed`: Reload / Quit. `unresponsive`: Wait / Reload / Quit — `signal` aborts when the renderer
   * becomes responsive again (the dialog closes and resolves `wait`).
   */
  readonly ask: (kind: 'crashed' | 'unresponsive', signal: AbortSignal) => Promise<RecoveryChoice>;
  readonly quit: () => void;
  /** A crash within this long after an automatic reload goes to the dialog. Default 5 minutes. */
  readonly autoReloadWindowMs?: number;
}

/** Default {@link RendererRecoveryDeps.autoReloadWindowMs}. */
export const AUTO_RELOAD_WINDOW_MS = 5 * 60_000;

/**
 * Wires `render-process-gone` / `unresponsive` / `responsive` on `win`: a crash is logged and reloaded once
 * automatically; another crash within {@link AUTO_RELOAD_WINDOW_MS} shows Reload / Quit. A hung renderer is never
 * reloaded behind the user's back (it may recover): it gets Wait / Reload / Quit, dismissed if it recovers. Reload
 * there crashes the hung renderer (`forcefullyCrashRenderer`) and reloads it once it is gone (round-3 M6).
 */
export function attachRendererRecovery(win: Pick<WindowLike, 'isDestroyed' | 'webContents'>, d: RendererRecoveryDeps): void {
  const windowMs = d.autoReloadWindowMs ?? AUTO_RELOAD_WINDOW_MS;
  const wc = win.webContents;
  let lastAutoReloadAt: number | null = null;
  let open: { kind: 'crashed' | 'unresponsive'; abort: AbortController } | null = null;
  /**
   * Round-3 M6: set when the user chose Reload on a HUNG renderer. A plain `reload()` is queued behind the busy
   * renderer and never runs, so the renderer is crashed instead; its `render-process-gone` then reloads the window
   * (without the auto-reload budget or the crash dialog: this crash was asked for).
   */
  let forcedReload = false;

  const prompt = async (kind: 'crashed' | 'unresponsive'): Promise<void> => {
    if (open !== null) {
      if (open.kind === 'crashed' || kind === 'unresponsive') return; // one dialog at a time
      open.abort.abort(); // a crash supersedes an "unresponsive" prompt
    }
    const abort = new AbortController();
    const mine = { kind, abort };
    open = mine;
    let choice: RecoveryChoice;
    try {
      choice = await d.ask(kind, abort.signal);
    } catch {
      choice = 'wait';
    }
    if (open === mine) open = null;
    if (abort.signal.aborted && kind === 'unresponsive') choice = 'wait';
    d.logger.info({ event: 'window.recovery_choice', kind, choice, outcome: 'ok' });
    if (win.isDestroyed()) return;
    if (choice === 'reload' && kind === 'unresponsive') {
      forcedReload = true;
      try {
        wc.forcefullyCrashRenderer();
      } catch {
        forcedReload = false;
        wc.reload();
      }
    } else if (choice === 'reload') wc.reload();
    else if (choice === 'quit') d.quit();
  };

  wc.on('render-process-gone', (_e, details) => {
    if (forcedReload) {
      forcedReload = false;
      d.logger.info({ event: 'window.forced_reload', reason: details.reason, outcome: 'ok' });
      if (!win.isDestroyed()) wc.reload();
      return;
    }
    d.logger.error({ event: 'window.renderer_gone', reason: details.reason, exitCode: details.exitCode, outcome: 'error' });
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    const n = d.now();
    if (lastAutoReloadAt === null || n - lastAutoReloadAt > windowMs) {
      lastAutoReloadAt = n;
      d.logger.info({ event: 'window.auto_reload', reason: details.reason, outcome: 'ok' });
      wc.reload();
      return;
    }
    void prompt('crashed');
  });
  wc.on('unresponsive', () => {
    d.logger.warn({ event: 'window.unresponsive', outcome: 'error' });
    void prompt('unresponsive');
  });
  wc.on('responsive', () => {
    d.logger.info({ event: 'window.responsive', outcome: 'ok' });
    if (open?.kind === 'unresponsive') open.abort.abort();
  });
}

/** Dependencies of {@link createMainWindow}. */
export interface WindowDeps {
  readonly BrowserWindow: new (opts: MainWindowOptions) => WindowLike;
  readonly preloadPath: string;
  readonly rendererIndexPath: string;
  /** Dev server URL (unpackaged only). */
  readonly devServerUrl: string | undefined;
  readonly isPackaged: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly onLoaded?: (win: WindowLike) => void;
  readonly onLoadError?: (e: unknown) => void;
  /** Renderer crash / hang recovery (omitted in tests that do not exercise it). */
  readonly recovery?: RendererRecoveryDeps;
}

/** DevTools auto-open: dev server loads only, never packaged, never under E2E. */
export function shouldOpenDevTools(isPackaged: boolean, env: NodeJS.ProcessEnv, devServerUrl: string | undefined): boolean {
  return !isPackaged && env['RELAY_E2E'] !== '1' && devServerUrl !== undefined && devServerUrl !== '';
}

/** Creates, loads, and (on ready-to-show) shows the main window. */
export function createMainWindow(d: WindowDeps): WindowLike {
  const win = new d.BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#0B1119',
    webPreferences: {
      preload: d.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !d.isPackaged,
    },
  });
  win.once('ready-to-show', () => {
    win.show();
    if (shouldOpenDevTools(d.isPackaged, d.env, d.devServerUrl)) win.webContents.openDevTools();
  });
  win.webContents.on('did-finish-load', () => d.onLoaded?.(win));
  if (d.recovery !== undefined) attachRendererRecovery(win, d.recovery);
  const devUrl = d.isPackaged ? undefined : d.devServerUrl;
  const loading = devUrl !== undefined && devUrl !== '' ? win.loadURL(devUrl) : win.loadFile(d.rendererIndexPath);
  loading.catch((e: unknown) => d.onLoadError?.(e));
  return win;
}
