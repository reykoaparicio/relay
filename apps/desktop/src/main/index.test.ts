import { describe, expect, it, vi } from 'vitest';
import { boot } from './boot.js';
import type { BootApp, BootServices } from './boot.js';
import { nullLogger } from './logger.js';
import { createMainWindow, shouldOpenDevTools } from './window.js';
import type { MainWindowOptions, WindowLike } from './window.js';

vi.mock('electron', () => ({ app: {} }));

type Listener = (e: { preventDefault(): void }) => void;

function fakeApp(calls: string[], opts: { lock?: boolean; isPackaged?: boolean } = {}) {
  const listeners = new Map<string, Listener>();
  const app: BootApp & { fire(event: string): { prevented: boolean } } = {
    isPackaged: opts.isPackaged ?? false,
    setPath: (name, p) => calls.push(`setPath:${name}:${p}`),
    requestSingleInstanceLock: () => {
      calls.push('lock');
      return opts.lock ?? true;
    },
    quit: () => calls.push('quit'),
    whenReady: () => {
      calls.push('whenReady');
      return Promise.resolve();
    },
    on: (event: string, l: Listener) => {
      listeners.set(event, l);
      return app;
    },
    fire(event) {
      const state = { prevented: false };
      listeners.get(event)?.({ preventDefault: () => (state.prevented = true) });
      return state;
    },
  };
  return app;
}

function fakeServices(calls: string[], start: () => Promise<void> = () => Promise.resolve()) {
  let resolveShutdown: () => void = () => undefined;
  const services: BootServices = {
    logger: nullLogger,
    applySessionPolicy: () => calls.push('security'),
    ensureLayout: () => {
      calls.push('layout');
      return Promise.resolve();
    },
    registerIpc: () => calls.push('ipc.register'),
    createMainWindow: () => calls.push('createMainWindow'),
    focusMainWindow: () => calls.push('focus'),
    supervisor: {
      start: () => {
        calls.push('supervisor.start');
        return start();
      },
      shutdown: () => {
        calls.push('supervisor.shutdown');
        return new Promise<void>((r) => (resolveShutdown = r));
      },
    },
    flushLogs: () => {
      calls.push('flush');
      return Promise.resolve();
    },
  };
  return { services, finishShutdown: () => { resolveShutdown(); } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('boot @m1', () => {
  it('runs userData override → lock → whenReady → security → layout → ipc.register before createMainWindow → supervisor.start', async () => {
    const calls: string[] = [];
    const app = fakeApp(calls);
    const { services } = fakeServices(calls);

    await boot({ app, env: { RELAY_USER_DATA_DIR: '/tmp/relay-x' }, createServices: () => services });

    expect(calls).toEqual(['setPath:userData:/tmp/relay-x', 'lock', 'whenReady', 'security', 'layout', 'ipc.register', 'createMainWindow', 'supervisor.start']);
  });

  it('ignores RELAY_USER_DATA_DIR and fake mode when packaged without RELAY_E2E', async () => {
    const calls: string[] = [];
    const cfgs: unknown[] = [];
    const { services } = fakeServices(calls);

    await boot({
      app: fakeApp(calls, { isPackaged: true }),
      env: { RELAY_USER_DATA_DIR: '/tmp/x', RELAY_PROVIDER_MODE: 'fake' },
      createServices: (cfg) => (cfgs.push(cfg), services),
    });

    expect(calls[0]).toBe('lock');
    expect(cfgs[0]).toMatchObject({ providerMode: 'live', userDataOverridden: false });
  });

  it('quits without creating services when the single-instance lock is held', async () => {
    const calls: string[] = [];
    const create = vi.fn();

    const r = await boot({ app: fakeApp(calls, { lock: false }), env: {}, createServices: create });

    expect(r).toBeNull();
    expect(calls).toEqual(['lock', 'quit']);
    expect(create).not.toHaveBeenCalled();
  });

  it('still creates the window when supervisor.start() rejects', async () => {
    const calls: string[] = [];
    const { services } = fakeServices(calls, () => Promise.reject(new Error('boom')));

    await expect(boot({ app: fakeApp(calls), env: {}, createServices: () => services })).resolves.not.toBeNull();

    expect(calls).toContain('createMainWindow');
  });

  it('before-quit: first call prevents, awaits shutdown, then quits; a second call does not prevent', async () => {
    const calls: string[] = [];
    const app = fakeApp(calls);
    const { services, finishShutdown } = fakeServices(calls);
    await boot({ app, env: {}, createServices: () => services });

    const first = app.fire('before-quit');
    await flush();
    expect(first.prevented).toBe(true);
    expect(calls).toContain('supervisor.shutdown');
    expect(calls).not.toContain('quit');
    finishShutdown();
    await flush();
    const second = app.fire('before-quit');

    expect(calls.filter((c) => c === 'quit')).toHaveLength(1);
    expect(second.prevented).toBe(false);
    expect(calls.filter((c) => c === 'supervisor.shutdown')).toHaveLength(1);
  });

  it('F6: a quit during boot stops it at the next await — no IPC, no window, no runner fork', async () => {
    const calls: string[] = [];
    const app = fakeApp(calls);
    const { services, finishShutdown } = fakeServices(calls);
    let finishLayout: () => void = () => undefined;
    services.ensureLayout = () => {
      calls.push('layout');
      return new Promise<void>((r) => (finishLayout = r));
    };
    const booting = boot({ app, env: {}, createServices: () => services });
    await flush();

    const quit = app.fire('before-quit');
    finishLayout();
    finishShutdown();
    await booting;
    await flush();

    expect(quit.prevented).toBe(true);
    expect(calls).not.toContain('ipc.register');
    expect(calls).not.toContain('createMainWindow');
    expect(calls).not.toContain('supervisor.start');
    expect(calls).toContain('quit');
  });

  it('F6: a quit before whenReady resolves never creates services', async () => {
    const calls: string[] = [];
    const app = fakeApp(calls);
    let ready: () => void = () => undefined;
    app.whenReady = () => new Promise<void>((r) => (ready = r));
    const create = vi.fn();
    const booting = boot({ app, env: {}, createServices: create });

    const quit = app.fire('before-quit');
    ready();

    await expect(booting).resolves.toBeNull();
    expect(quit.prevented).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('second-instance focuses the existing window', async () => {
    const calls: string[] = [];
    const app = fakeApp(calls);
    const { services } = fakeServices(calls);
    await boot({ app, env: {}, createServices: () => services });

    app.fire('second-instance');

    expect(calls).toContain('focus');
  });
});

describe('main window', () => {
  function makeWindowClass(log: { opts?: MainWindowOptions; devtools: number; shown: number; readyToShow?: () => void }) {
    return class implements WindowLike {
      constructor(opts: MainWindowOptions) {
        log.opts = opts;
      }
      once(_e: 'ready-to-show', l: () => void) {
        log.readyToShow = l;
        return this;
      }
      show() {
        log.shown += 1;
      }
      focus() {}
      isMinimized() {
        return false;
      }
      restore() {}
      isDestroyed() {
        return false;
      }
      loadURL() {
        return Promise.resolve();
      }
      loadFile() {
        return Promise.resolve();
      }
      webContents = {
        openDevTools: () => {
          log.devtools += 1;
        },
        send: () => undefined,
        on: () => undefined,
      };
    };
  }

  it('is hardened and never auto-opens DevTools when RELAY_E2E=1', () => {
    const log: { opts?: MainWindowOptions; devtools: number; shown: number; readyToShow?: () => void } = { devtools: 0, shown: 0 };

    createMainWindow({
      BrowserWindow: makeWindowClass(log), preloadPath: '/p.js', rendererIndexPath: '/i.html',
      devServerUrl: 'http://localhost:5173', isPackaged: false, env: { RELAY_E2E: '1' },
    });
    log.readyToShow?.();

    expect(log.opts?.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false });
    expect(log.opts?.show).toBe(false);
    expect(log.shown).toBe(1);
    expect(log.devtools).toBe(0);
  });

  it('opens DevTools only unpackaged on the dev server outside E2E', () => {
    expect(shouldOpenDevTools(false, {}, 'http://localhost:5173')).toBe(true);
    expect(shouldOpenDevTools(true, {}, 'http://localhost:5173')).toBe(false);
    expect(shouldOpenDevTools(false, { RELAY_E2E: '1' }, 'http://localhost:5173')).toBe(false);
  });
});
