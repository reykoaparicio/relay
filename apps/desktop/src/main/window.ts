// 08 H1 main window: hardened webPreferences, shown on ready-to-show (no white flash) regardless of runner state.
// DevTools only when unpackaged, and never auto-opened under RELAY_E2E=1 (it breaks Playwright's firstWindow()).

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
  readonly webContents: {
    openDevTools(): void;
    send(channel: string, payload: unknown): void;
    on(event: 'did-finish-load', listener: () => void): unknown;
  };
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
  const devUrl = d.isPackaged ? undefined : d.devServerUrl;
  const loading = devUrl !== undefined && devUrl !== '' ? win.loadURL(devUrl) : win.loadFile(d.rendererIndexPath);
  loading.catch((e: unknown) => d.onLoadError?.(e));
  return win;
}
