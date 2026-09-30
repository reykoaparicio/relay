// Production composition root of the main process: wires Electron to the testable modules. Main never imports
// @relay/engine, @relay/storage, or @relay/providers (§6.3); it talks to the runner only through the supervisor.
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserWindow, MessageChannelMain, app, dialog, ipcMain, powerMonitor, safeStorage, session, shell, utilityProcess } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';
import { EVENTS_CHANNEL, createIdGen, systemClock, toDisplayPath } from '@relay/contracts';
import type { AppInfo, PushEvent } from '@relay/contracts';
// 08 H9: `?modulePath` yields only the emitted runner bundle's file path (for utilityProcess.fork); no runner code
// is imported into main.
// eslint-disable-next-line boundaries/dependencies -- the one sanctioned main → runner edge (electron-vite build input)
import runnerEntryPath from '../runner/runner?modulePath';
import { appPaths, ensureLayout, samplesRoot } from './app-paths.js';
import type { BootConfig, BootServices } from './boot.js';
import { createCredentialVault } from './credentials.js';
import { createDialogService } from './dialogs.js';
import type { NativeDialogs } from './dialogs.js';
import { createCompositeHandlers } from './ipc/handlers/composite.js';
import { createMainHandlers } from './ipc/handlers/main-handlers.js';
import { createRateLimiter } from './ipc/rate-limit.js';
import { createIpcRouter } from './ipc/router.js';
import type { TrustedOrigin } from './ipc/router.js';
import { createFileLogger, pruneLogs } from './logger.js';
import { createRunnerSupervisor, minimalEnv } from './runner-supervisor.js';
import type { RunnerSupervisor } from './runner-supervisor.js';
import { createSampleService } from './samples.js';
import { applySessionPolicy, guardWebContents } from './security.js';
import { createMainWindow } from './window.js';
import type { WindowLike } from './window.js';

const HERE = fileURLToPath(new URL('.', import.meta.url)); // out/main/

/** Builds every main-process service after `ready` (08 H1 step 4). */
export function createProductionServices(cfg: BootConfig): BootServices {
  const userData = app.getPath('userData');
  const home = homedir();
  const paths = appPaths(userData, samplesRoot(userData, app.getPath('documents'), cfg.userDataOverridden));
  const logger = createFileLogger(paths.logs);
  const ids = createIdGen(systemClock, (n) => new Uint8Array(randomBytes(n)));
  const origin: TrustedOrigin = {
    isPackaged: app.isPackaged,
    rendererFileUrl: pathToFileURL(join(HERE, '../renderer/index.html')).href,
    devServerUrl: app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'],
  };
  let win: WindowLike | null = null;

  const broadcast = (e: PushEvent): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(EVENTS_CHANNEL, e);
  };

  // Late-bound: the vault resolves OS-protected files through the runner's credential refs (single DB writer).
  let supervisor: RunnerSupervisor | null = null;
  const vault = createCredentialVault({
    safeStorage, userDataDir: userData, platform: process.platform, ids,
    lookupVaultFile: async (providerId) => {
      const refs = await supervisor?.request('relay/v1/providers.listCredentialRefs', {});
      return refs?.ok === true ? (refs.data.find((r) => r.providerId === providerId)?.vaultFile ?? null) : null;
    },
  });

  const sup = createRunnerSupervisor({
    fork: (entry, args, opts) => utilityProcess.fork(entry, args, opts),
    createChannel: () => new MessageChannelMain(),
    entryPath: runnerEntryPath,
    env: minimalEnv({
      userDataDir: userData, homeDir: home, tmpDir: tmpdir(), providerMode: cfg.providerMode, fakeScenario: cfg.fakeScenario,
      e2e: cfg.e2e, crashAt: process.env['RELAY_CRASH_AT'], nodeEnv: process.env['NODE_ENV'],
    }),
    now: Date.now,
    monotonicNow: () => performance.now(), // heartbeat staleness never uses the wall clock
    timers: {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => {
        clearTimeout(h as NodeJS.Timeout);
      },
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (h) => {
        clearInterval(h as NodeJS.Timeout);
      },
    },
    logger,
    getCredential: (providerId) => vault.get(providerId),
    broadcast,
  });
  supervisor = sup;
  // A Mac asleep longer than RUNNER_STALE_AFTER_MS must not look like a hung runner on wake (08 H6).
  powerMonitor.on('resume', () => {
    sup.notifyResume();
  });

  const nativeDialogs: NativeDialogs = {
    showOpenDialog: (opts) => (win === null ? dialog.showOpenDialog(opts as OpenDialogOptions) : dialog.showOpenDialog(win as unknown as BrowserWindow, opts as OpenDialogOptions)),
    showSaveDialog: (opts) => (win === null ? dialog.showSaveDialog(opts as SaveDialogOptions) : dialog.showSaveDialog(win as unknown as BrowserWindow, opts as SaveDialogOptions)),
  };
  const dialogs = createDialogService({ dialogs: nativeDialogs, clock: systemClock, ids, homeDir: home, userDataDir: userData, e2e: cfg.e2e });

  const appInfo = (): AppInfo => ({
    version: app.getVersion(),
    buildId: app.isPackaged ? 'packaged' : 'dev',
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    userDataDisplayPath: toDisplayPath(userData, home),
    isPackaged: app.isPackaged,
    providerMode: cfg.providerMode,
    fakeScenario: cfg.fakeScenario,
  });

  const samples = createSampleService({
    sourceDir: app.isPackaged ? join(process.resourcesPath, 'sample-api') : join(app.getAppPath(), '../../tests/fixtures/sample-api'),
    samplesDir: paths.samples,
    homeDir: home,
  });

  const router = createIpcRouter({
    ...origin,
    ipcMain: ipcMain,
    logger, ids,
    limiter: createRateLimiter(() => performance.now()),
    now: () => performance.now(),
    runner: sup,
    mainHandlers: createMainHandlers({
      appInfo, dialogs,
      confirmOpenExternal: async (url) => {
        const opts = { type: 'question' as const, buttons: ['Open link', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Open this link in your browser?', detail: url };
        const res = win === null ? await dialog.showMessageBox(opts) : await dialog.showMessageBox(win as unknown as BrowserWindow, opts);
        return res.response === 0;
      },
      openExternal: (url) => shell.openExternal(url),
    }),
    composite: createCompositeHandlers({
      runner: sup, dialogs, vault, samples, appInfo, homeDir: home, clock: systemClock,
      supervisorState: () => sup.state(),
      writeTextFile: (p, text) => writeFile(p, text, { encoding: 'utf8', mode: 0o600 }),
      notifyProvidersChanged: () => {
        broadcast({ type: 'providers.changed' });
      },
    }),
  });

  return {
    logger,
    supervisor: sup,
    applySessionPolicy() {
      applySessionPolicy(session.defaultSession, origin);
      app.on('web-contents-created', (_e, wc) => {
        guardWebContents(wc, origin);
      });
    },
    async ensureLayout() {
      await ensureLayout(paths);
      pruneLogs(paths.logs, Date.now());
    },
    registerIpc: () => {
      router.register();
    },
    createMainWindow() {
      win = createMainWindow({
        BrowserWindow: BrowserWindow,
        preloadPath: join(HERE, '../preload/index.js'),
        rendererIndexPath: join(HERE, '../renderer/index.html'),
        devServerUrl: origin.devServerUrl,
        isPackaged: app.isPackaged,
        env: process.env,
        onLoaded: (w) => {
          w.webContents.send(EVENTS_CHANNEL, { type: 'runner.state', state: sup.state().state } satisfies PushEvent);
        },
        onLoadError: (e) => {
          logger.error({ event: 'window.load_failed', outcome: 'error', err: e instanceof Error ? e.message : String(e) });
        },
      });
    },
    focusMainWindow() {
      if (win === null || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
    },
    flushLogs: () => Promise.resolve(), // the file logger writes synchronously
  };
}
