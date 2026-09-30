import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CorrelationId } from '@relay/contracts';
import { createProtocolServer } from './protocol-server.js';
import type { RunnerPortLike, ServedRuntime } from './protocol-server.js';

vi.mock('electron', () => ({}));

class FakePort implements RunnerPortLike {
  started = false;
  sent: unknown[] = [];
  listener: ((e: { data: unknown }) => void) | null = null;
  on(_e: 'message', l: (e: { data: unknown }) => void) {
    this.listener = l;
  }
  start() {
    this.started = true;
  }
  postMessage(m: unknown) {
    this.sent.push(m);
  }
  close() {}
  deliver(data: unknown) {
    this.listener?.({ data });
  }
}

function setup() {
  const port = new FakePort();
  const order: string[] = [];
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const exit = vi.fn((code: number) => order.push(`exit:${String(code)}`));
  const server = createProtocolServer({
    port, logger, pid: 7, exit, now: () => 1_700_000_000_000,
    correlationId: () => 'cor_01J0000000000000000000000A' as CorrelationId,
    timers: { setTimeout, clearTimeout: (h) => { clearTimeout(h as NodeJS.Timeout); }, setInterval, clearInterval: (h) => { clearInterval(h as NodeJS.Timeout); } },
  });
  const runtime: ServedRuntime = {
    engine: {
      handle: vi.fn(() => Promise.resolve({ ok: true as const, data: ['x'] })) as unknown as ServedRuntime['engine']['handle'],
      stop: vi.fn(() => (order.push('stop'), Promise.resolve())),
    },
    dispose: vi.fn(() => (order.push('dispose'), Promise.resolve())),
  };
  return { port, server, runtime, logger, order, exit };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('runner protocol server (H7)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('attaches its listener and calls port.start()', () => {
    const { port } = setup();

    expect(port.listener).not.toBeNull();
    expect(port.started).toBe(true);
  });

  it('ignores and logs an invalid message', async () => {
    const { port, logger } = setup();

    port.deliver({ kind: 'op', id: 'x', channel: 'relay/v1/nope', input: {} });
    await flush();

    expect(port.sent).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('protocol.invalid_message', expect.anything());
  });

  it('routes public and internal channels to engine.handle and replies with op.result', async () => {
    const { port, server, runtime } = setup();
    server.attach(runtime);

    port.deliver({ kind: 'op', id: 'a', channel: 'relay/v1/projects.list', input: {} });
    port.deliver({ kind: 'op', id: 'b', channel: 'relay/v1/providers.listCredentialRefs', input: {} });
    await flush();

    expect(runtime.engine.handle).toHaveBeenCalledWith('relay/v1/projects.list', {});
    expect(runtime.engine.handle).toHaveBeenCalledWith('relay/v1/providers.listCredentialRefs', {});
    expect(port.sent).toContainEqual({ kind: 'op.result', id: 'a', result: { ok: true, data: ['x'] } });
  });

  it('answers RUNNER_UNAVAILABLE before the runtime is attached', async () => {
    const { port } = setup();

    port.deliver({ kind: 'op', id: 'a', channel: 'relay/v1/projects.list', input: {} });
    await flush();

    expect(port.sent[0]).toMatchObject({ kind: 'op.result', id: 'a', result: { ok: false, error: { code: 'RUNNER_UNAVAILABLE' } } });
  });

  it('shutdown → engine.stop → dispose → exit 0', async () => {
    const { port, server, runtime, order } = setup();
    server.attach(runtime);

    port.deliver({ kind: 'shutdown', graceMs: 1000 });
    await flush();

    expect(order).toEqual(['stop', 'dispose', 'exit:0']);
  });

  it('requests credentials from main and resolves on credential.response', async () => {
    const { port, server } = setup();

    const p = server.requestCredential({ providerId: 'anthropic', purpose: 'dispatch', attemptId: null });
    const req = port.sent[0] as { kind: string; id: string };
    port.deliver({ kind: 'credential.response', id: req.id, result: { ok: true, apiKey: 'k' } });

    expect(req.kind).toBe('credential.request');
    await expect(p).resolves.toEqual({ ok: true, value: 'k' });
  });

  it('posts validated events and ready + heartbeats', async () => {
    vi.useFakeTimers();
    const { port, server } = setup();

    server.sendEvent({ type: 'providers.changed' });
    server.sendReady(1);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(port.sent[0]).toEqual({ kind: 'event', event: { type: 'providers.changed' } });
    expect(port.sent[1]).toEqual({ kind: 'ready', schemaVersion: 1, pid: 7 });
    expect(port.sent[2]).toMatchObject({ kind: 'heartbeat', activeRunId: null });
  });
});
