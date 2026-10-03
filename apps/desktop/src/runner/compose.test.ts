/* eslint-disable @typescript-eslint/unbound-method -- asserting on vi.fn() members */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushEvent } from '@relay/contracts';
import { createRuntime, parseCrashAt } from '@relay/engine';
import { bootRunner, compose, readRunnerEnv } from './compose.js';
import type { ProtocolServer } from './protocol-server.js';

vi.mock('electron', () => ({}));
vi.mock('@relay/engine', () => ({ createRuntime: vi.fn(), parseCrashAt: vi.fn(() => ({ afterStepCommit: () => undefined })) }));
vi.mock('@relay/providers', () => ({ createJsonlCallLog: vi.fn((file: string) => ({ file })) }));

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const exit = ((code: number) => {
  throw new Error(`exit ${String(code)}`);
}) as (code: number) => never;

function protocol(order: string[] = []): ProtocolServer {
  return {
    requestCredential: vi.fn(),
    sendEvent: vi.fn(),
    attach: vi.fn(() => order.push('attach')),
    sendReady: vi.fn(() => order.push('ready')),
    sendFatal: vi.fn(),
    activeRunId: vi.fn(() => null),
    sendMaintenanceResult: vi.fn(),
  };
}

function fakeRuntime(order: string[] = [], start: () => Promise<void> = () => Promise.resolve()) {
  return {
    engine: { start: vi.fn(() => (order.push('engine.start'), start())), stop: vi.fn(), handle: vi.fn() },
    db: { schemaVersion: () => 1 },
    dispose: vi.fn(),
  };
}

describe('runner compose (H7)', () => {
  beforeEach(() => {
    vi.mocked(createRuntime).mockReset();
    vi.mocked(parseCrashAt).mockClear();
  });

  it('fake mode passes fakeScenario and a JSONL callLog at userData/fake-call-log.jsonl', async () => {
    vi.mocked(createRuntime).mockResolvedValue(fakeRuntime() as never);

    await compose(readRunnerEnv({ RELAY_USER_DATA_DIR: '/ud', RELAY_PROVIDER_MODE: 'fake', RELAY_FAKE_SCENARIO: 'happy' }), protocol(), { logger, exit });

    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      userDataDir: '/ud', providerMode: 'fake', fakeScenario: 'happy', callLog: { file: '/ud/fake-call-log.jsonl' },
    }));
  });

  it('live mode passes neither fakeScenario nor callLog', async () => {
    vi.mocked(createRuntime).mockResolvedValue(fakeRuntime() as never);

    await compose(readRunnerEnv({ RELAY_USER_DATA_DIR: '/ud', RELAY_FAKE_SCENARIO: 'happy' }), protocol(), { logger, exit });

    const opts = vi.mocked(createRuntime).mock.calls[0]?.[0];
    expect(opts?.providerMode).toBe('live');
    expect(opts).not.toHaveProperty('fakeScenario');
    expect(opts).not.toHaveProperty('callLog');
  });

  it('parses RELAY_CRASH_AT via the engine parser only when RELAY_E2E=1', async () => {
    vi.mocked(createRuntime).mockResolvedValue(fakeRuntime() as never);

    await compose(readRunnerEnv({ RELAY_USER_DATA_DIR: '/ud', RELAY_CRASH_AT: 'afterStepCommit@plan' }), protocol(), { logger, exit });
    expect(parseCrashAt).not.toHaveBeenCalled();
    expect(vi.mocked(createRuntime).mock.calls[0]?.[0]).not.toHaveProperty('hooks');

    await compose(readRunnerEnv({ RELAY_USER_DATA_DIR: '/ud', RELAY_E2E: '1', RELAY_CRASH_AT: 'afterStepCommit@plan' }), protocol(), { logger, exit });
    expect(parseCrashAt).toHaveBeenCalledWith('afterStepCommit@plan', { exit });
    expect(vi.mocked(createRuntime).mock.calls[1]?.[0]).toHaveProperty('hooks');
  });

  it('posts ready only after engine.start() resolves', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    vi.mocked(createRuntime).mockResolvedValue(fakeRuntime(order, () => new Promise<void>((r) => (release = r))) as never);
    const p = protocol(order);

    const booting = bootRunner(readRunnerEnv({ RELAY_USER_DATA_DIR: '/ud' }), p, { logger, exit });
    await new Promise((r) => setTimeout(r, 0));
    expect(p.sendReady).not.toHaveBeenCalled();
    release();
    await booting;

    expect(order).toEqual(['engine.start', 'attach', 'ready']);
    expect(p.sendReady).toHaveBeenCalledWith(1);
  });

  it('hands createRuntime an emit that forwards push events to protocol.sendEvent', async () => {
    vi.mocked(createRuntime).mockResolvedValue(fakeRuntime() as never);
    const p = protocol();
    await compose(readRunnerEnv({ RELAY_USER_DATA_DIR: '/ud' }), p, { logger, exit });
    const emit = vi.mocked(createRuntime).mock.calls[0]?.[0].emit;
    const event: PushEvent = { type: 'providers.changed' };

    emit?.(event);

    expect(p.sendEvent).toHaveBeenCalledWith(event);
  });

  it('requires RELAY_USER_DATA_DIR', () => {
    expect(() => readRunnerEnv({})).toThrow();
  });
});
