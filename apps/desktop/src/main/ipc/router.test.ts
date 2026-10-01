import { describe, expect, it, vi } from 'vitest';
import { INTERNAL_OPERATION_LIST, OPERATION_LIST, createIdGen, epochMs } from '@relay/contracts';
import type { AppInfo } from '@relay/contracts';
import type { LogFields, MainLogger } from '../logger.js';
import { createRateLimiter } from './rate-limit.js';
import { createIpcRouter } from './router.js';
import type { IpcEventLike, RouterDeps } from './router.js';
import type { CompositeChannel, HandlerTable, MainChannel } from './types.js';

vi.mock('electron', () => ({}));

const FILE_URL = 'file:///app/out/renderer/index.html';
const DEV_URL = 'http://localhost:5173';
const INFO: AppInfo = {
  version: '0.0.0', buildId: 'dev', electron: '44', node: '24', platform: 'darwin', userDataDisplayPath: '~/x',
  isPackaged: false, providerMode: 'fake', fakeScenario: null,
};
const frame = (url: string, parent: unknown = null): IpcEventLike => ({ senderFrame: { url, parent } });

function setup(o: { isPackaged?: boolean; getInfo?: () => Promise<unknown>; now?: () => number } = {}) {
  const lines: LogFields[] = [];
  const levels: string[] = [];
  const at = (level: string) => (f: LogFields) => {
    levels.push(level);
    lines.push(f);
  };
  const logger: MainLogger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  const registered: string[] = [];
  const runner = { request: vi.fn(() => Promise.resolve({ ok: true as const, data: [] })) };
  const mainHandlers = {
    'relay/v1/app.getInfo': o.getInfo ?? (() => Promise.resolve({ ok: true, data: INFO })),
    'relay/v1/app.openExternal': () => Promise.resolve({ ok: true, data: { opened: false } }),
    'relay/v1/projects.pickDirectory': () => Promise.resolve({ ok: true, data: { selection: null } }),
  } as unknown as HandlerTable<MainChannel>;
  const deps: RouterDeps = {
    isPackaged: o.isPackaged ?? true,
    rendererFileUrl: FILE_URL,
    devServerUrl: DEV_URL,
    ipcMain: { handle: (c) => registered.push(c) },
    logger,
    ids: createIdGen({ now: () => epochMs(1) }, (n) => new Uint8Array(n)),
    limiter: createRateLimiter(o.now ?? (() => 0)),
    now: () => 0,
    mainHandlers,
    composite: {} as HandlerTable<CompositeChannel>,
    runner: runner as unknown as RouterDeps['runner'],
  };
  return { router: createIpcRouter(deps), lines, levels, registered, runner };
}

describe('IPC router (H4)', () => {
  it('registers every OPERATION and no INTERNAL_RUNNER_OPS channel', () => {
    const { router, registered } = setup();

    router.register();

    expect(registered.sort()).toEqual(OPERATION_LIST.map((o) => o.channel).sort());
    for (const internal of INTERNAL_OPERATION_LIST) expect(registered).not.toContain(internal.channel);
  });

  it('rejects a null senderFrame and a subframe', async () => {
    const { router } = setup();

    const nullFrame = await router.invoke('relay/v1/app.getInfo', { senderFrame: null }, {});
    const sub = await router.invoke('relay/v1/app.getInfo', frame(FILE_URL, {}), {});

    expect(!nullFrame.ok && nullFrame.error.code).toBe('PERMISSION_DENIED');
    expect(!sub.ok && sub.error.code).toBe('PERMISSION_DENIED');
  });

  it('packaged: accepts the exact renderer file URL (ignoring #fragment), rejects other file:// URLs and the dev URL', async () => {
    const { router } = setup({ isPackaged: true });

    expect((await router.invoke('relay/v1/app.getInfo', frame(`${FILE_URL}#/runs`), {})).ok).toBe(true);
    expect((await router.invoke('relay/v1/app.getInfo', frame('file:///tmp/evil/index.html'), {})).ok).toBe(false);
    expect((await router.invoke('relay/v1/app.getInfo', frame(`${FILE_URL}.evil`), {})).ok).toBe(false);
    expect((await router.invoke('relay/v1/app.getInfo', frame(`${DEV_URL}/`), {})).ok).toBe(false);
  });

  it('unpackaged: accepts the dev server origin and validates outputs', async () => {
    const { router } = setup({ isPackaged: false });

    expect((await router.invoke('relay/v1/app.getInfo', frame(`${DEV_URL}/#/x`), {})).ok).toBe(true);
    expect((await router.invoke('relay/v1/app.getInfo', frame('http://localhost:9999/'), {})).ok).toBe(false);
  });

  it('dev only: an output that violates the catalog schema becomes INTERNAL (and is logged); packaged passes it through', async () => {
    const bad = () => Promise.resolve({ ok: true, data: { version: 42 } });
    const dev = setup({ isPackaged: false, getInfo: bad });
    const packaged = setup({ isPackaged: true, getInfo: bad });

    const d = await dev.router.invoke('relay/v1/app.getInfo', frame(FILE_URL), {});
    const p = await packaged.router.invoke('relay/v1/app.getInfo', frame(FILE_URL), {});

    expect(!d.ok && d.error.code).toBe('INTERNAL');
    expect(JSON.stringify(d)).not.toContain('42');
    expect(dev.lines.some((l) => l.event === 'ipc.error')).toBe(true);
    expect(p).toEqual({ ok: true, data: { version: 42 } });
    expect(packaged.lines.some((l) => l.event === 'ipc.error')).toBe(false);
  });

  it('dev only: warns about an error code the operation does not document, without changing the answer', async () => {
    const undocumented = () => Promise.resolve({ ok: false, error: { code: 'BUDGET_BLOCKED', userMessage: 'x', retryable: false, nextAction: 'none', alternatives: [] } });
    const dev = setup({ isPackaged: false, getInfo: undocumented });
    const packaged = setup({ isPackaged: true, getInfo: undocumented });

    const d = await dev.router.invoke('relay/v1/app.getInfo', frame(FILE_URL), {});
    await packaged.router.invoke('relay/v1/app.getInfo', frame(FILE_URL), {});

    expect(!d.ok && d.error.code).toBe('BUDGET_BLOCKED');
    expect(dev.lines).toContainEqual({ event: 'ipc.undocumented_error', channel: 'relay/v1/app.getInfo', code: 'BUDGET_BLOCKED' });
    expect(packaged.lines.some((l) => l.event === 'ipc.undocumented_error')).toBe(false);
  });

  it('dev: a documented or universal error code is not reported', async () => {
    const dev = setup({ isPackaged: false, getInfo: () => Promise.resolve({ ok: false, error: { code: 'RUNNER_UNAVAILABLE', userMessage: 'x', retryable: true, nextAction: 'none', alternatives: [] } }) });

    await dev.router.invoke('relay/v1/app.getInfo', frame(FILE_URL), {});

    expect(dev.lines.some((l) => l.event === 'ipc.undocumented_error')).toBe(false);
  });

  it('an unknown channel answers NOT_FOUND', async () => {
    const { router } = setup();

    const r = await router.invoke('relay/v1/nope', frame(FILE_URL), {});

    expect(!r.ok && r.error.code).toBe('NOT_FOUND');
  });

  it('returns VALIDATION_FAILED with zod issues for invalid input', async () => {
    const { router } = setup();

    const r = await router.invoke('relay/v1/app.openExternal', frame(FILE_URL), { url: 'http://insecure.example' });

    expect(!r.ok && r.error.code).toBe('VALIDATION_FAILED');
    expect(!r.ok && Array.isArray(r.error.details?.['issues'])).toBe(true);
  });

  it('maps a thrown error to INTERNAL with a correlationId and no stack or message', async () => {
    const { router, lines } = setup({ getInfo: () => Promise.reject(new Error('SQLITE_BUSY at /Users/alice/secret')) });

    const r = await router.invoke('relay/v1/app.getInfo', frame(FILE_URL), {});

    expect(!r.ok && r.error.code).toBe('INTERNAL');
    expect(!r.ok && r.error.correlationId).toMatch(/^cor_/);
    expect(JSON.stringify(r)).not.toContain('SQLITE_BUSY');
    expect(JSON.stringify(r)).not.toContain('at ');
    expect(lines.some((l) => l.event === 'ipc.error')).toBe(true);
  });

  it('rate limits with retryAfterMs', async () => {
    const { router } = setup();
    const results = [];

    for (let i = 0; i < 6; i += 1) results.push(await router.invoke('relay/v1/app.exportDiagnostics', frame(FILE_URL), {}));

    const last = results.at(-1);
    expect(last !== undefined && !last.ok && last.error.code).toBe('RATE_LIMITED');
    expect(last !== undefined && !last.ok && typeof last.error.details?.['retryAfterMs']).toBe('number');
  });

  it('logs one ipc.op line per call with outcome and code (success at debug, failure at info)', async () => {
    const { router, lines, levels } = setup();

    await router.invoke('relay/v1/app.getInfo', frame(FILE_URL), {});
    await router.invoke('relay/v1/app.getInfo', { senderFrame: null }, {});

    const ops = lines.filter((l) => l.event === 'ipc.op');
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ channel: 'relay/v1/app.getInfo', outcome: 'ok' });
    expect(ops[1]).toMatchObject({ outcome: 'error', code: 'PERMISSION_DENIED' });
    expect(typeof ops[0]?.['correlationId']).toBe('string');
    expect(lines.flatMap((l, i) => (l.event === 'ipc.op' ? [levels[i]] : []))).toEqual(['debug', 'info']);
  });

  it('routes runner-routed channels to the supervisor', async () => {
    const { router, runner } = setup();

    await router.invoke('relay/v1/projects.list', frame(FILE_URL), {});

    expect(runner.request).toHaveBeenCalledWith('relay/v1/projects.list', {});
  });
});
