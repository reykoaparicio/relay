// Tests the preload bridge (08 H2). Lives under main/ because the vitest `unit` project only collects
// apps/desktop/src/{main,runner}/**/*.test.ts; the bridge module itself is Electron-free.
import { describe, expect, it, vi } from 'vitest';
import { EVENTS_CHANNEL, INTERNAL_OPERATION_LIST, OPERATION_LIST, pushEventSchema } from '@relay/contracts';
import type { Channel } from '@relay/contracts';
// eslint-disable-next-line boundaries/dependencies -- test-only: exercises the preload bridge from the unit project
import { createRelayApi } from '../preload/bridge.js';
// eslint-disable-next-line boundaries/dependencies -- test-only type import
import type { IpcRendererLike } from '../preload/bridge.js';

type Listener = (event: unknown, payload: unknown) => void;

function fakeIpc() {
  const listeners = new Map<string, Listener[]>();
  const ipc = {
    invoke: vi.fn<IpcRendererLike['invoke']>(() => Promise.resolve({ ok: true, data: 'from-main' })),
    on: vi.fn((channel: string, l: Listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), l]);
    }),
    removeListener: vi.fn((channel: string, l: Listener) => {
      listeners.set(channel, (listeners.get(channel) ?? []).filter((x) => x !== l));
    }),
  } satisfies IpcRendererLike;
  const emit = (channel: string, payload: unknown): void => {
    for (const l of listeners.get(channel) ?? []) l({ sender: 'main' }, payload);
  };
  return { ipc, emit, count: (channel: string) => listeners.get(channel)?.length ?? 0 };
}

describe('preload bridge (H2)', () => {
  it('forwards an allowlisted channel to ipcRenderer.invoke unchanged', async () => {
    const { ipc } = fakeIpc();
    const api = createRelayApi(ipc, 'darwin');

    const r = await api.invoke('relay/v1/app.getInfo', {});

    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('relay/v1/app.getInfo', {});
    expect(r).toEqual({ ok: true, data: 'from-main' });
    expect(api.platform).toBe('darwin');
  });

  it.each([
    'relay/v1/not.a.channel',
    'relay/v1/events',
    ...INTERNAL_OPERATION_LIST.map((o) => o.channel).slice(0, 3), // runner-internal ops are never renderer-callable
  ])('rejects %s with channel_not_allowed and never calls ipcRenderer', async (channel) => {
    const { ipc } = fakeIpc();
    const api = createRelayApi(ipc, 'darwin');

    const r = await api.invoke(channel as Channel, {});

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('PERMISSION_DENIED');
    expect(!r.ok && r.error.details).toMatchObject({ reason: 'channel_not_allowed' });
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it('allowlists exactly the renderer-exposed OPERATIONS', async () => {
    const { ipc } = fakeIpc();
    const api = createRelayApi(ipc, 'darwin');

    for (const op of OPERATION_LIST) await api.invoke(op.channel as Channel, {});

    expect(ipc.invoke).toHaveBeenCalledTimes(OPERATION_LIST.length);
  });

  it('subscribe delivers valid push events and drops payloads that fail the schema', () => {
    const { ipc, emit } = fakeIpc();
    const api = createRelayApi(ipc, 'darwin');
    const got = vi.fn();
    api.subscribe(got);

    emit(EVENTS_CHANNEL, { type: 'providers.changed' });
    emit(EVENTS_CHANNEL, { type: 'runner.state', state: 'definitely-not-a-state' });
    emit(EVENTS_CHANNEL, { type: 'evil', payload: 'x' });
    emit(EVENTS_CHANNEL, 'not an object');
    emit(EVENTS_CHANNEL, { type: 'memory.changed', projectId: 'not-an-id' });

    expect(got).toHaveBeenCalledExactlyOnceWith({ type: 'providers.changed' });
  });

  it('the unsubscribe function removes exactly its listener', () => {
    const { ipc, emit, count } = fakeIpc();
    const api = createRelayApi(ipc, 'darwin');
    const got = vi.fn();
    const off = api.subscribe(got);
    expect(count(EVENTS_CHANNEL)).toBe(1);

    off();
    emit(EVENTS_CHANNEL, { type: 'providers.changed' });

    expect(count(EVENTS_CHANNEL)).toBe(0);
    expect(got).not.toHaveBeenCalled();
  });

  it('fans one parsed event out to every subscriber over a single ipcRenderer listener', () => {
    const { ipc, emit, count } = fakeIpc();
    const api = createRelayApi(ipc, 'darwin');
    const parse = vi.spyOn(pushEventSchema, 'safeParse');
    const a = vi.fn();
    const b = vi.fn();
    api.subscribe(a);
    api.subscribe(b);
    api.subscribe(a); // the same function twice = two subscriptions

    emit(EVENTS_CHANNEL, { type: 'providers.changed' });

    expect(count(EVENTS_CHANNEL)).toBe(1);
    expect(ipc.on).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledExactlyOnceWith({ type: 'providers.changed' });
    parse.mockRestore();
  });

  it('removes the ipcRenderer listener only when the last subscriber leaves, and re-attaches lazily', () => {
    const { ipc, emit, count } = fakeIpc();
    const api = createRelayApi(ipc, 'darwin');
    const a = vi.fn();
    const b = vi.fn();
    const offA = api.subscribe(a);
    const offB = api.subscribe(b);

    offA();
    offA(); // idempotent: must not drop b's subscription
    emit(EVENTS_CHANNEL, { type: 'providers.changed' });
    expect(count(EVENTS_CHANNEL)).toBe(1);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    offB();
    expect(count(EVENTS_CHANNEL)).toBe(0);

    const c = vi.fn();
    api.subscribe(c);
    emit(EVENTS_CHANNEL, { type: 'providers.changed' });
    expect(count(EVENTS_CHANNEL)).toBe(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it('a subscriber that unsubscribes another mid-dispatch, or throws, does not break the fan-out', async () => {
    const { ipc, emit } = fakeIpc();
    const api = createRelayApi(ipc, 'darwin');
    const late = vi.fn();
    let offLate: () => void = () => undefined;
    const thrown: unknown[] = [];
    const onErr = (e: unknown) => thrown.push(e);
    process.on('uncaughtException', onErr);
    api.subscribe(() => {
      offLate();
      throw new Error('subscriber bug');
    });
    const after = vi.fn();
    offLate = api.subscribe(late);
    api.subscribe(after);

    emit(EVENTS_CHANNEL, { type: 'providers.changed' });
    await new Promise((r) => setTimeout(r, 0));
    process.off('uncaughtException', onErr);

    expect(late).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
    expect(thrown).toHaveLength(1);
  });
});
