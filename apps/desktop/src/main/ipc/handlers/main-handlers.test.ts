// Main-routed handlers (08 H4) through the real router pipeline (sender check → validation → handler → dev output
// validation), with the real dialog service driven through its `__relayDialogs` seam.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appInfoSchema, createIdGen, epochMs } from '@relay/contracts';
import type { AppInfo } from '@relay/contracts';
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

function setup(o: { confirm?: boolean; native?: Partial<NativeDialogs> } = {}) {
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
