import { describe, expect, it, vi } from 'vitest';
import { boot, startApp } from './boot.js';
import type { BootApp, BootServices } from './boot.js';
import { nullLogger } from './logger.js';
import { checkDirWritable, unwritableUserDataMessage } from './userdata-check.js';
import { attachRendererRecovery, createMainWindow, shouldOpenDevTools } from './window.js';
import type { MainWindowOptions, RecoveryChoice, WebContentsLike, WindowLike } from './window.js';

vi.mock('electron', () => ({ app: {} }));

type Listener = (e: { preventDefault(): void }) => void;

function fakeApp(calls: string[], opts: { lock?: boolean; isPackaged?: boolean } = {}) {
  let userData = '/default/userData';
  const listeners = new Map<string, Listener>();
  const app: BootApp & { fire(event: string): { prevented: boolean } } = {
    isPackaged: opts.isPackaged ?? false,
    setPath: (name, p) => {
      calls.push(`setPath:${name}:${p}`);
      userData = p;
    },
    getPath: () => userData,
    exit: (code) => calls.push(`exit:${String(code)}`),
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
    activeRunId: () => null,
    confirmQuitDuringRun: () => {
      calls.push('confirm');
      return true;
    },
    recordCleanQuit: (runActive) => {
      calls.push(`cleanQuit:${String(runActive)}`);
      return Promise.resolve();
    },
    flushLogs: () => {
      calls.push('flush');
      return Promise.resolve();
    },
  };
  return { services, finishShutdown: () => { resolveShutdown(); } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Writable userData, no error box (the defaults of most boot tests). */
const BASE = { checkWritable: () => ({ ok: true as const }), showErrorBox: () => undefined, packagedE2eAllowed: false };

describe('boot @m1', () => {
  it('runs userData override → lock → whenReady → security → layout → ipc.register before createMainWindow → supervisor.start', async () => {
    const calls: string[] = [];
    const app = fakeApp(calls);
    const { services } = fakeServices(calls);

    await boot({ ...BASE, app, env: { RELAY_USER_DATA_DIR: '/tmp/relay-x' }, createServices: () => services });

    expect(calls).toEqual(['setPath:userData:/tmp/relay-x', 'lock', 'whenReady', 'security', 'layout', 'ipc.register', 'createMainWindow', 'supervisor.start']);
  });

  it('ignores RELAY_USER_DATA_DIR and fake mode when packaged without RELAY_E2E', async () => {
    const calls: string[] = [];
    const cfgs: unknown[] = [];
    const { services } = fakeServices(calls);

    await boot({ ...BASE,
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

    const r = await boot({ ...BASE, app: fakeApp(calls, { lock: false }), env: {}, createServices: create });

    expect(r).toBeNull();
    expect(calls).toEqual(['lock', 'quit']);
    expect(create).not.toHaveBeenCalled();
  });

  it('still creates the window when supervisor.start() rejects', async () => {
    const calls: string[] = [];
    const { services } = fakeServices(calls, () => Promise.reject(new Error('boom')));

    await expect(boot({ ...BASE, app: fakeApp(calls), env: {}, createServices: () => services })).resolves.not.toBeNull();

    expect(calls).toContain('createMainWindow');
  });

  it('SIGTERM/SIGINT start the graceful quit; a second signal while quitting exits at once', async () => {
    const calls: string[] = [];
    const app = fakeApp(calls);
    const { services } = fakeServices(calls);
    const handlers = new Map<string, () => void>();
    await boot({ ...BASE, app, env: {}, createServices: () => services, onSignal: (sig, h) => handlers.set(sig, h) });
    expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
    calls.length = 0;

    handlers.get('SIGTERM')?.();
    expect(calls).toEqual(['quit']); // the same path as Cmd+Q (before-quit runs the shutdown)
    app.fire('before-quit'); // what app.quit() triggers: the graceful shutdown starts
    handlers.get('SIGINT')?.();

    expect(calls).toContain('supervisor.shutdown');
    expect(calls.at(-1)).toBe('exit:0');
  });

  it('before-quit: first call prevents, awaits shutdown, then quits; a second call does not prevent', async () => {
    const calls: string[] = [];
    const app = fakeApp(calls);
    const { services, finishShutdown } = fakeServices(calls);
    await boot({ ...BASE, app, env: {}, createServices: () => services });

    const first = app.fire('before-quit');
    await flush();
    expect(first.prevented).toBe(true);
    expect(calls).toContain('supervisor.shutdown');
    expect(calls).not.toContain('quit');
    finishShutdown();
    await flush();
    const second = app.fire('before-quit');

    expect(calls.filter((c) => c === 'quit')).toHaveLength(1);
    expect(calls.indexOf('flush')).toBeGreaterThan(calls.indexOf('supervisor.shutdown')); // logs flushed on quit…
    expect(calls.indexOf('flush')).toBeLessThan(calls.indexOf('quit')); // …before the app actually quits
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
    const booting = boot({ ...BASE, app, env: {}, createServices: () => services });
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

  it('round-3 B3: an early quit waits for the launch marker (ensureLayout) before writing the clean-quit marker', async () => {
    const calls: string[] = [];
    const app = fakeApp(calls);
    const { services, finishShutdown } = fakeServices(calls);
    let finishLayout: () => void = () => undefined;
    services.ensureLayout = () => {
      calls.push('layout');
      return new Promise<void>((r) => (finishLayout = () => {
        calls.push('layout.done'); // recordLaunch wrote { clean: false }
        r();
      }));
    };
    const booting = boot({ ...BASE, app, env: {}, createServices: () => services });
    await flush();

    app.fire('before-quit');
    finishShutdown();
    await flush();
    // The launch marker is still being written: the clean-quit marker must not race it (it would be overwritten).
    expect(calls).not.toContain('cleanQuit:false');
    finishLayout();
    await booting;
    await flush();

    expect(calls.indexOf('layout.done')).toBeGreaterThan(-1);
    expect(calls.indexOf('cleanQuit:false')).toBeGreaterThan(calls.indexOf('layout.done'));
    expect(calls).toContain('quit');
  });

  it('round-3 B3: a failing ensureLayout never blocks the quit', async () => {
    const calls: string[] = [];
    const app = fakeApp(calls);
    const { services, finishShutdown } = fakeServices(calls);
    let failLayout: () => void = () => undefined;
    services.ensureLayout = () => new Promise<void>((_r, reject) => (failLayout = () => { reject(new Error('disk full')); }));
    const booting = boot({ ...BASE, app, env: {}, createServices: () => services });
    await flush();

    app.fire('before-quit');
    finishShutdown();
    failLayout();
    await expect(booting).rejects.toThrow('disk full');
    await flush();

    expect(calls).toContain('cleanQuit:false');
    expect(calls).toContain('quit');
  });

  it('F6: a quit before whenReady resolves never creates services', async () => {
    const calls: string[] = [];
    const app = fakeApp(calls);
    let ready: () => void = () => undefined;
    app.whenReady = () => new Promise<void>((r) => (ready = r));
    const create = vi.fn();
    const booting = boot({ ...BASE, app, env: {}, createServices: create });

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
    await boot({ ...BASE, app, env: {}, createServices: () => services });

    app.fire('second-instance');

    expect(calls).toContain('focus');
  });

  it('an unwritable userData shows an error box naming the folder and exits(1) before taking the lock', async () => {
    const calls: string[] = [];
    const boxes: { title: string; content: string }[] = [];
    const create = vi.fn();

    const r = await boot({
      app: fakeApp(calls), env: { RELAY_USER_DATA_DIR: '/ro/relay' }, createServices: create,
      checkWritable: (dir) => (calls.push(`check:${dir}`), { ok: false, errno: 'EACCES' }),
      showErrorBox: (title, content) => boxes.push({ title, content }),
    });

    expect(r).toBeNull();
    expect(calls).toEqual(['setPath:userData:/ro/relay', 'check:/ro/relay', 'exit:1']);
    expect(calls).not.toContain('lock');
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.content).toContain('/ro/relay');
    expect(boxes[0]?.content).toMatch(/permission/i);
    expect(boxes[0]?.content).toMatch(/Get Info/);
    expect(create).not.toHaveBeenCalled();
  });

  it('a held lock with a writable userData still quits quietly (another instance is running)', async () => {
    const calls: string[] = [];
    const showErrorBox = vi.fn();

    await boot({ ...BASE, showErrorBox, app: fakeApp(calls, { lock: false }), env: {}, createServices: vi.fn() });

    expect(calls).toEqual(['lock', 'quit']);
    expect(showErrorBox).not.toHaveBeenCalled();
  });

  it('startApp: a boot rejection shows an error box and exits(1) instead of an unhandled rejection', async () => {
    const calls: string[] = [];
    const showErrorBox = vi.fn();
    const { services } = fakeServices(calls);
    services.ensureLayout = () => Promise.reject(new Error('EIO: disk gone'));

    const r = await startApp({ ...BASE, showErrorBox, app: fakeApp(calls), env: {}, createServices: () => services });

    expect(r).toBeNull();
    expect(showErrorBox).toHaveBeenCalledExactlyOnceWith('Relay could not start', expect.stringContaining('EIO: disk gone'));
    expect(calls.at(-1)).toBe('exit:1');
  });

  it('before-quit during a run asks first; "keep open" cancels the quit and keeps the runner', async () => {
    const calls: string[] = [];
    const app = fakeApp(calls);
    const { services } = fakeServices(calls);
    services.activeRunId = () => 'run_01J0000000000000000000000A';
    services.confirmQuitDuringRun = () => (calls.push('confirm'), false);
    await boot({ ...BASE, app, env: {}, createServices: () => services });

    const q = app.fire('before-quit');
    await flush();

    expect(q.prevented).toBe(true);
    expect(calls).toContain('confirm');
    expect(calls).not.toContain('supervisor.shutdown');
    expect(calls.at(-1)).toBe('focus'); // re-shows (or re-creates) the window
  });

  it('before-quit during a run, confirmed: shuts down, records a clean quit with runActive, then quits', async () => {
    const calls: string[] = [];
    const app = fakeApp(calls);
    const { services, finishShutdown } = fakeServices(calls);
    services.activeRunId = () => 'run_01J0000000000000000000000A';
    await boot({ ...BASE, app, env: {}, createServices: () => services });

    app.fire('before-quit');
    finishShutdown();
    await flush();

    expect(calls.slice(calls.indexOf('confirm'))).toEqual(['confirm', 'supervisor.shutdown', 'cleanQuit:true', 'flush', 'quit']);
  });

  it('round-3 L1: before-quit during a restore asks first; "keep open" cancels the quit; "quit anyway" shuts down', async () => {
    const calls: string[] = [];
    const app = fakeApp(calls);
    const { services, finishShutdown } = fakeServices(calls);
    let answer = false;
    services.maintenanceRunning = () => true;
    services.confirmQuitDuringRestore = () => {
      calls.push('confirmRestore');
      return answer;
    };
    await boot({ ...BASE, app, env: {}, createServices: () => services });

    const kept = app.fire('before-quit');
    expect(kept.prevented).toBe(true);
    expect(calls).not.toContain('supervisor.shutdown');
    expect(calls).toContain('focus');

    answer = true;
    app.fire('before-quit');
    finishShutdown();
    await flush();
    expect(calls.filter((c) => c === 'confirmRestore')).toHaveLength(2);
    expect(calls).toContain('supervisor.shutdown');
    expect(calls).toContain('quit');
  });

  it('before-quit with no run in flight never prompts and records a clean quit', async () => {
    const calls: string[] = [];
    const app = fakeApp(calls);
    const { services, finishShutdown } = fakeServices(calls);
    await boot({ ...BASE, app, env: {}, createServices: () => services });

    app.fire('before-quit');
    finishShutdown();
    await flush();

    expect(calls).not.toContain('confirm');
    expect(calls).toContain('cleanQuit:false');
  });

  it('packaged: RELAY_E2E is honored only when the build-time flag allows it', async () => {
    const run = async (packagedE2eAllowed: boolean) => {
      const calls: string[] = [];
      const cfgs: unknown[] = [];
      const { services } = fakeServices(calls);
      await boot({
        ...BASE, packagedE2eAllowed, app: fakeApp(calls, { isPackaged: true }),
        env: { RELAY_E2E: '1', RELAY_USER_DATA_DIR: '/tmp/e2e', RELAY_PROVIDER_MODE: 'fake' },
        createServices: (cfg) => (cfgs.push(cfg), services),
      });
      return { calls, cfg: cfgs[0] };
    };

    const shipped = await run(false);
    const verify = await run(true);

    expect(shipped.calls).not.toContain('setPath:userData:/tmp/e2e');
    expect(shipped.cfg).toMatchObject({ providerMode: 'live', userDataOverridden: false, e2e: false });
    expect(verify.calls[0]).toBe('setPath:userData:/tmp/e2e');
    expect(verify.cfg).toMatchObject({ providerMode: 'fake', userDataOverridden: true, e2e: true });
  });
});

describe('userData writability probe', () => {
  it('creates the dir and a probe file, then removes it', () => {
    const ops: string[] = [];
    const r = checkDirWritable('/ud', {
      mkdirSync: (p) => ops.push(`mkdir:${p}`),
      writeFileSync: (p) => ops.push(`write:${p}`),
      unlinkSync: (p) => ops.push(`unlink:${p}`),
    }, 7);

    expect(r).toEqual({ ok: true });
    expect(ops).toEqual(['mkdir:/ud', 'unlink:/ud/.relay-write-check-7', 'write:/ud/.relay-write-check-7', 'unlink:/ud/.relay-write-check-7']);
  });

  it('reports the errno of a refused write', () => {
    const r = checkDirWritable('/ud', {
      mkdirSync: () => undefined,
      writeFileSync: () => {
        throw Object.assign(new Error('nope'), { code: 'EROFS' });
      },
      unlinkSync: () => undefined,
    });

    expect(r).toEqual({ ok: false, errno: 'EROFS' });
    expect(unwritableUserDataMessage('/ud', 'EROFS').content).toMatch(/read-only/);
    expect(unwritableUserDataMessage('/ud', 'ENOSPC').content).toMatch(/disk space/);
  });
});

describe('renderer recovery', () => {
  function fakeWin() {
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const log = { reloads: 0, destroyed: false, crashes: 0 };
    const win = {
      isDestroyed: () => log.destroyed,
      webContents: {
        openDevTools: () => undefined,
        send: () => undefined,
        reload: () => {
          log.reloads += 1;
        },
        forcefullyCrashRenderer: () => {
          log.crashes += 1;
        },
        on: (event: string, l: (...a: unknown[]) => void) => {
          handlers.set(event, l);
        },
      } as unknown as WebContentsLike,
    };
    const emit = (event: string, ...args: unknown[]) => handlers.get(event)?.(...args);
    return { win, log, emit };
  }

  it('reloads once automatically, then asks Reload/Quit on a second crash soon after', async () => {
    const { win, log, emit } = fakeWin();
    let now = 0;
    const ask = vi.fn<(kind: 'crashed' | 'unresponsive', signal: AbortSignal) => Promise<RecoveryChoice>>(() => Promise.resolve('quit'));
    const quit = vi.fn();
    attachRendererRecovery(win, { logger: nullLogger, now: () => now, ask, quit });

    emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(log.reloads).toBe(1);
    expect(ask).not.toHaveBeenCalled();

    now += 10_000;
    emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 });
    await flush();

    expect(log.reloads).toBe(1);
    expect(ask).toHaveBeenCalledWith('crashed', expect.anything());
    expect(quit).toHaveBeenCalledOnce();
  });

  it('a crash long after the last automatic reload is reloaded automatically again; clean exits are ignored', () => {
    const { win, log, emit } = fakeWin();
    let now = 0;
    const ask = vi.fn(() => Promise.resolve<RecoveryChoice>('reload'));
    attachRendererRecovery(win, { logger: nullLogger, now: () => now, ask, quit: vi.fn(), autoReloadWindowMs: 1_000 });

    emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    now += 5_000;
    emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });

    expect(log.reloads).toBe(2);
    expect(ask).not.toHaveBeenCalled();
  });

  it('the dialog\'s Reload choice reloads the window', async () => {
    const { win, log, emit } = fakeWin();
    const ask = vi.fn(() => Promise.resolve<RecoveryChoice>('reload'));
    attachRendererRecovery(win, { logger: nullLogger, now: () => 0, ask, quit: vi.fn() });

    emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await flush();

    expect(log.reloads).toBe(2);
  });

  it('unresponsive asks Wait/Reload/Quit (no automatic reload); becoming responsive dismisses it as Wait', async () => {
    const { win, log, emit } = fakeWin();
    let aborted = false;
    const ask = vi.fn((_kind: 'crashed' | 'unresponsive', signal: AbortSignal) =>
      new Promise<RecoveryChoice>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve('quit'); // what a dismissed box reports is overridden: an abort always means "wait"
        });
      }));
    const quit = vi.fn();
    attachRendererRecovery(win, { logger: nullLogger, now: () => 0, ask, quit });

    emit('unresponsive');
    emit('unresponsive'); // one dialog at a time
    emit('responsive');
    await flush();

    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0]?.[0]).toBe('unresponsive');
    expect(aborted).toBe(true);
    expect(quit).not.toHaveBeenCalled();
    expect(log.reloads).toBe(0);
  });

  it('round-3 M6: Reload on a hung renderer force-crashes it, then reloads on render-process-gone without the crash dialog or the auto-reload budget', async () => {
    const { win, log, emit } = fakeWin();
    let now = 0;
    const ask = vi.fn<(kind: 'crashed' | 'unresponsive', signal: AbortSignal) => Promise<RecoveryChoice>>(() => Promise.resolve('reload'));
    const quit = vi.fn();
    attachRendererRecovery(win, { logger: nullLogger, now: () => now, ask, quit });

    emit('unresponsive');
    await flush();
    // A frozen renderer never runs a plain reload(): it is crashed instead, and reloaded once it is gone.
    expect(log.crashes).toBe(1);
    expect(log.reloads).toBe(0);
    emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 });
    expect(log.reloads).toBe(1);
    expect(ask).toHaveBeenCalledTimes(1); // no "stopped working again" dialog for the crash we caused

    // The forced crash did not spend the automatic-reload budget: a real crash soon after is still reloaded silently.
    now += 1_000;
    emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(log.reloads).toBe(2);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
  });

  it('never reloads a destroyed window', () => {
    const { win, log, emit } = fakeWin();
    log.destroyed = true;
    attachRendererRecovery(win, { logger: nullLogger, now: () => 0, ask: vi.fn(), quit: vi.fn() });

    emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });

    expect(log.reloads).toBe(0);
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
        reload: () => undefined,
        forcefullyCrashRenderer: () => undefined,
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
