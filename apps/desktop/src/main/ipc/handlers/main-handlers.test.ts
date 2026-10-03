// Main-routed handlers (08 H4) through the real router pipeline (sender check → validation → handler → dev output
// validation), with the real dialog service driven through its `__relayDialogs` seam.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appInfoSchema, createIdGen, epochMs } from '@relay/contracts';
import type { AppInfo, RunnerFatal, RunnerState } from '@relay/contracts';
import type { MaintenanceOutcome, RestartOutcome, SupervisorSnapshot } from '../../runner-supervisor.js';
import { createDialogService } from '../../dialogs.js';
import type { NativeDialogs, RelayDialogsSeam } from '../../dialogs.js';
import { nullLogger } from '../../logger.js';
import { makeTempDir, removeTempDir } from '../../testing/temp-dirs.js';
import { createRateLimiter } from '../rate-limit.js';
import { createIpcRouter } from '../router.js';
import type { IpcEventLike } from '../router.js';
import type { CompositeChannel, HandlerTable } from '../types.js';
import { createMainHandlers } from './main-handlers.js';
import type { MainHandlerDeps } from './main-handlers.js';

vi.mock('electron', () => ({}));

const FILE_URL = 'file:///app/out/renderer/index.html';
const FRAME: IpcEventLike = { senderFrame: { url: FILE_URL, parent: null } };
const HOME = '/Users/alice';
const INFO: AppInfo = {
  version: '1.2.3', buildId: 'dev', electron: '44.0.0', node: '24.1.0', platform: 'darwin', userDataDisplayPath: '~/Library/Application Support/Relay',
  isPackaged: false, providerMode: 'fake', fakeScenario: null,
};

let dir = '';
beforeEach(async () => {
  dir = await makeTempDir('mainh');
});
afterEach(async () => {
  await removeTempDir(dir);
});

function fakeRunner(o: { restart?: RestartOutcome; fatal?: RunnerFatal | null; maintenance?: MaintenanceOutcome; state?: RunnerState } = {}) {
  return {
    restart: vi.fn(() => Promise.resolve(o.restart ?? { restarted: false, state: 'ready' as const })),
    state: vi.fn((): SupervisorSnapshot => ({ state: o.state ?? 'unavailable', restarts: 0, lastFatal: o.fatal ?? null, activeRunId: null })),
    runMaintenance: vi.fn(() => Promise.resolve(o.maintenance ?? ({ ok: false, reason: 'runner_active' } as const))),
  };
}

function setup(o: { confirm?: boolean; native?: Partial<NativeDialogs>; runner?: ReturnType<typeof fakeRunner> } = {}) {
  const seamTarget: Record<string, unknown> = {};
  const showOpenDialog = vi.fn<NativeDialogs['showOpenDialog']>(() => Promise.resolve({ canceled: true, filePaths: [] }));
  const dialogs = createDialogService({
    dialogs: { showOpenDialog, showSaveDialog: () => Promise.resolve({ canceled: true }), ...o.native },
    clock: { now: () => epochMs(1_000_000) },
    ids: createIdGen({ now: () => epochMs(1_000_000) }, (n) => new Uint8Array(n).fill(7)),
    homeDir: HOME, userDataDir: join(dir, 'userData'), e2e: true, seamTarget,
  });
  const deps = {
    appInfo: vi.fn(() => INFO),
    dialogs,
    confirmOpenExternal: vi.fn(() => Promise.resolve(o.confirm ?? false)),
    openExternal: vi.fn(() => Promise.resolve()),
    runner: o.runner ?? fakeRunner(),
    relaunch: vi.fn(),
  } satisfies MainHandlerDeps;
  const handlers = createMainHandlers(deps);
  const router = createIpcRouter({
    isPackaged: false, // dev: the router also validates every output against the catalog
    rendererFileUrl: FILE_URL,
    devServerUrl: undefined,
    ipcMain: { handle: () => undefined },
    logger: nullLogger,
    ids: createIdGen({ now: () => epochMs(1) }, (n) => new Uint8Array(n)),
    limiter: createRateLimiter(() => 0),
    now: () => 0,
    mainHandlers: handlers,
    composite: {} as HandlerTable<CompositeChannel>,
    runner: { request: vi.fn() } as never,
  });
  return { deps, handlers, router, showOpenDialog, seam: seamTarget['__relayDialogs'] as RelayDialogsSeam, dialogs };
}

describe('app.openExternal (H4, §11.4)', () => {
  it('cancelled confirmation: answers opened:false and never calls shell.openExternal', async () => {
    const { router, deps } = setup({ confirm: false });

    const r = await router.invoke('relay/v1/app.openExternal', FRAME, { url: 'https://example.com/licenses' });

    expect(r).toEqual({ ok: true, data: { opened: false } });
    expect(deps.confirmOpenExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/licenses');
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('confirmed: opens exactly the confirmed URL', async () => {
    const { router, deps } = setup({ confirm: true });

    const r = await router.invoke('relay/v1/app.openExternal', FRAME, { url: 'https://example.com/docs' });

    expect(r).toEqual({ ok: true, data: { opened: true } });
    expect(deps.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/docs');
  });

  it.each(['http://example.com/', 'file:///etc/passwd', 'javascript:alert(1)'])('rejects %s before any confirmation', async (url) => {
    const { router, deps } = setup({ confirm: true });

    const r = await router.invoke('relay/v1/app.openExternal', FRAME, { url });

    expect(r.ok).toBe(false);
    expect(deps.confirmOpenExternal).not.toHaveBeenCalled();
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('the handler itself is https-only: reaching it with another scheme is an invariant violation, never an open', async () => {
    const { handlers, deps } = setup({ confirm: true });

    const r = handlers['relay/v1/app.openExternal']({ url: 'http://example.com/' });

    await expect(r).rejects.toThrow(/Invariant violation/);
    expect(deps.confirmOpenExternal).not.toHaveBeenCalled();
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('a non-https URL never reaches the handler: the router answers VALIDATION_FAILED (universal; the op declares no errors)', async () => {
    const { router } = setup({ confirm: true });

    const r = await router.invoke('relay/v1/app.openExternal', FRAME, { url: 'http://example.com/' });

    expect(!r.ok && r.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('app.getInfo (H4)', () => {
  it('returns the app info, valid against the catalog output schema', async () => {
    const { router } = setup();

    const r = await router.invoke('relay/v1/app.getInfo', FRAME, {});

    expect(r).toEqual({ ok: true, data: INFO });
    expect(appInfoSchema.safeParse(r.ok ? r.data : null).success).toBe(true);
  });
});

describe('projects.pickDirectory (H3/H4)', () => {
  it('returns a selection token and display path (never the realpath) for the stubbed folder', async () => {
    const { router, seam, dialogs, showOpenDialog } = setup();
    const project = join(dir, 'my-api');
    await mkdir(project);
    seam.setStub({ directory: project });

    const r = await router.invoke('relay/v1/projects.pickDirectory', FRAME, {});

    expect(r.ok).toBe(true);
    const sel = r.ok ? (r.data as { selection: { selectionId: string; displayPath: string } | null }).selection : null;
    expect(sel?.selectionId).toMatch(/^sel_/);
    expect(sel?.displayPath).toBe(project); // outside HOME: shown as is
    expect(JSON.stringify(r)).not.toContain('realpath');
    expect(dialogs.resolveSelection(sel?.selectionId as never)).toEqual({ ok: true, value: { realpath: project, displayPath: project } });
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it('a cancelled native dialog answers selection: null', async () => {
    const { router, showOpenDialog } = setup();

    const r = await router.invoke('relay/v1/projects.pickDirectory', FRAME, {});

    expect(r).toEqual({ ok: true, data: { selection: null } });
    expect(showOpenDialog).toHaveBeenCalledOnce();
  });

  it('an unsafe root (userData) is refused with PERMISSION_DENIED and no token', async () => {
    const { router, seam, dialogs } = setup();
    await mkdir(join(dir, 'userData', 'inner'), { recursive: true });
    seam.setStub({ directory: join(dir, 'userData', 'inner') });

    const r = await router.invoke('relay/v1/projects.pickDirectory', FRAME, {});

    expect(!r.ok && r.error.code).toBe('PERMISSION_DENIED');
    expect(dialogs.pendingSelections()).toBe(0);
  });
});

describe('app.restartRunner / app.relaunch / app.restoreLatestBackup (resilience)', () => {
  it('restartRunner: a no-op while a runner is alive answers restarted:false', async () => {
    const runner = fakeRunner({ restart: { restarted: false, state: 'ready' } });
    const { router } = setup({ runner });

    const r = await router.invoke('relay/v1/app.restartRunner', FRAME, {});

    expect(r).toEqual({ ok: true, data: { restarted: false, state: 'ready' } });
  });

  it('restartRunner: success answers ready; a new failure answers RUNNER_UNAVAILABLE with the fatal reason', async () => {
    const ok = await setup({ runner: fakeRunner({ restart: { restarted: true, state: 'ready' } }) }).router.invoke('relay/v1/app.restartRunner', FRAME, {});
    const fatal: RunnerFatal = { code: 'DATABASE_UNAVAILABLE', reason: 'db_corrupt', message: 'm', at: epochMs(1) };
    const bad = await setup({ runner: fakeRunner({ restart: { restarted: true, state: 'unavailable' }, fatal }) }).router.invoke('relay/v1/app.restartRunner', FRAME, {});

    expect(ok).toEqual({ ok: true, data: { restarted: true, state: 'ready' } });
    expect(!bad.ok && bad.error.code).toBe('RUNNER_UNAVAILABLE');
    expect(!bad.ok && bad.error.details).toMatchObject({ reason: 'db_corrupt', fatalCode: 'DATABASE_UNAVAILABLE' });
  });

  it('restartRunner is rate limited (3 quick attempts, then RATE_LIMITED)', async () => {
    const { router } = setup();

    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await router.invoke('relay/v1/app.restartRunner', FRAME, {}));

    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(!results[3]?.ok && results[3]?.error.code).toBe('RATE_LIMITED');
  });

  it('relaunch answers relaunching:true and starts the relaunch', async () => {
    const { router, deps } = setup();

    const r = await router.invoke('relay/v1/app.relaunch', FRAME, {});

    expect(r).toEqual({ ok: true, data: { relaunching: true } });
    expect(deps.relaunch).toHaveBeenCalledOnce();
  });

  it('restoreLatestBackup: refused (CONFLICT) while a runner is alive', async () => {
    const { router } = setup({ runner: fakeRunner({ maintenance: { ok: false, reason: 'runner_active' } }) });

    const r = await router.invoke('relay/v1/app.restoreLatestBackup', FRAME, {});

    expect(!r.ok && r.error.code).toBe('CONFLICT');
  });

  it('restoreLatestBackup: a restored backup restarts the runner; no backup leaves it down', async () => {
    const restored = fakeRunner({
      maintenance: { ok: true, result: { ok: true, restored: true, restoredFromDisplayPath: '~/b/1', backupCreatedAt: epochMs(7), previousMovedToDisplayPath: '~/ud/relay.sqlite.before-restore' } },
      restart: { restarted: true, state: 'ready' },
    });
    const none = fakeRunner({ maintenance: { ok: true, result: { ok: true, restored: false, restoredFromDisplayPath: null, backupCreatedAt: null, previousMovedToDisplayPath: null } } });

    const a = await setup({ runner: restored }).router.invoke('relay/v1/app.restoreLatestBackup', FRAME, {});
    const b = await setup({ runner: none }).router.invoke('relay/v1/app.restoreLatestBackup', FRAME, {});

    expect(a).toEqual({ ok: true, data: { restored: true, restoredFromDisplayPath: '~/b/1', backupCreatedAt: 7, previousMovedToDisplayPath: '~/ud/relay.sqlite.before-restore', runnerState: 'ready' } });
    expect(restored.restart).toHaveBeenCalledOnce();
    expect(b.ok && b.data).toMatchObject({ restored: false, runnerState: 'unavailable' });
    expect(none.restart).not.toHaveBeenCalled();
  });
});
