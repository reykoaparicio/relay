import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errors, ok } from '@relay/contracts';
import type { PushEvent } from '@relay/contracts';
import type { LogFields, MainLogger } from './logger.js';
import { createRunnerSupervisor, minimalEnv } from './runner-supervisor.js';
import type { SupervisorDeps } from './runner-supervisor.js';

vi.mock('electron', () => ({}));

/** A MessagePortMain double that buffers deliveries until start(). */
class FakePort {
  started = false;
  sent: unknown[] = [];
  private listeners: ((e: { data: unknown }) => void)[] = [];
  private queue: unknown[] = [];
  on(_event: 'message', l: (e: { data: unknown }) => void) {
    this.listeners.push(l);
  }
  start() {
    this.started = true;
    for (const d of this.queue.splice(0)) this.deliver(d);
  }
  deliver(data: unknown) {
    if (!this.started) {
      this.queue.push(data);
      return;
    }
    for (const l of this.listeners) l({ data });
  }
  postMessage(m: unknown) {
    this.sent.push(m);
  }
  close() {}
}

class FakeChild extends EventEmitter {
  pid = 1000;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  init: unknown[] = [];
  port = new FakePort();
  postMessage(m: unknown) {
    this.init.push(m);
  }
  kill() {
    this.killed = true;
    return true;
  }
}

function setup(over: Partial<SupervisorDeps> = {}, opts: { skipPortStart?: boolean } = {}) {
  const lines: LogFields[] = [];
  const logger: MainLogger = { debug: (f) => lines.push(f), info: (f) => lines.push(f), warn: (f) => lines.push(f), error: (f) => lines.push(f) };
  const children: FakeChild[] = [];
  const events: PushEvent[] = [];
  const deps: SupervisorDeps = {
    fork: () => {
      const c = new FakeChild();
      c.pid = 1000 + children.length;
      children.push(c);
      return c;
    },
    createChannel: () => {
      const port1 = new FakePort();
      if (opts.skipPortStart === true) port1.start = () => undefined;
      const child = children.at(-1);
      if (child !== undefined) child.port = port1;
      return { port1, port2: {} };
    },
    entryPath: '/out/main/runner.js',
    env: { RELAY_USER_DATA_DIR: '/ud' },
    now: () => Date.now(),
    timers: { setTimeout, clearTimeout: (h) => { clearTimeout(h as NodeJS.Timeout); }, setInterval, clearInterval: (h) => { clearInterval(h as NodeJS.Timeout); } },
    logger,
    getCredential: () => Promise.resolve(ok('sk-test-key')),
    broadcast: (e) => events.push(e),
    ...over,
  };
  const sup = createRunnerSupervisor(deps);
  const latest = () => {
    const c = children.at(-1);
    if (c === undefined) throw new Error('no child');
    return c;
  };
  const ready = (c = latest()) => { c.port.deliver({ kind: 'ready', schemaVersion: 1, pid: c.pid }); };
  return { sup, children, lines, events, latest, ready };
}

describe('runner supervisor (H6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('forks with a private port, calls port1.start(), and resolves start() on ready', async () => {
    const { sup, latest, ready } = setup();
    const started = sup.start();

    ready();

    await expect(started).resolves.toBeUndefined();
    expect(latest().port.started).toBe(true);
    expect(latest().init).toEqual([{ kind: 'init' }]);
    expect(sup.state().state).toBe('ready');
  });

  it('never sees ready when port1.start() is not called (MessagePortMain buffers)', async () => {
    const { sup, ready } = setup({}, { skipPortStart: true });
    void sup.start().catch(() => undefined);

    ready();
    await vi.advanceTimersByTimeAsync(0);

    expect(sup.state().state).toBe('starting');
  });

  it('drains stdout/stderr line by line into the log', () => {
    const { sup, latest, lines } = setup();
    void sup.start().catch(() => undefined);

    latest().stdout.emit('data', Buffer.from('hello\nwor'));
    latest().stdout.emit('data', 'ld\n');
    latest().stderr.emit('data', 'oops\n');

    expect(lines.filter((l) => l.event === 'runner.stdout').map((l) => l['line'])).toEqual(['hello', 'world']);
    expect(lines.filter((l) => l.event === 'runner.stderr').map((l) => l['line'])).toEqual(['oops']);
  });

  it('kills the child when ready does not arrive within 60 s, and re-forks only after exit', async () => {
    const { sup, children } = setup();
    void sup.start().catch(() => undefined);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(children[0]?.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children[0]?.killed).toBe(true);
    expect(children).toHaveLength(1);
    children[0]?.emit('exit', 1);

    expect(children).toHaveLength(2);
    expect(sup.state()).toMatchObject({ state: 'restarting', restarts: 1 });
  });

  it('applies no heartbeat staleness before ready', async () => {
    const { sup, children } = setup();
    void sup.start().catch(() => undefined);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(children[0]?.killed).toBe(false);
  });

  it('heartbeat loss after ready → restarting → kill → waits for exit → re-fork', async () => {
    const { sup, children, ready, events } = setup();
    void sup.start().catch(() => undefined);
    ready();
    await vi.advanceTimersByTimeAsync(5_000);
    children[0]?.port.deliver({ kind: 'heartbeat', at: Date.now(), activeRunId: null });

    await vi.advanceTimersByTimeAsync(9_000);
    expect(children[0]?.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(children[0]?.killed).toBe(true);
    expect(sup.state().state).toBe('restarting');
    expect(children).toHaveLength(1);
    children[0]?.emit('exit', 137);

    expect(children).toHaveLength(2);
    expect(events).toContainEqual({ type: 'runner.state', state: 'restarting' });
  });

  it('gives up after 3 restarts in 60 s: unavailable, requests fail with RUNNER_UNAVAILABLE', async () => {
    const { sup, children } = setup();
    const started = sup.start();
    started.catch(() => undefined);

    for (let i = 0; i < 4; i += 1) children[i]?.emit('exit', 1);

    expect(children).toHaveLength(4);
    expect(sup.state().state).toBe('unavailable');
    await expect(started).rejects.toThrow();
    const r = await sup.request('relay/v1/projects.list', {});
    expect(!r.ok && r.error.code).toBe('RUNNER_UNAVAILABLE');
  });

  it('routes requests over the port and resolves on op.result', async () => {
    const { sup, latest, ready } = setup();
    void sup.start().catch(() => undefined);
    ready();

    const p = sup.request('relay/v1/projects.list', {});
    const sent = latest().port.sent[0] as { id: string; channel: string };
    latest().port.deliver({ kind: 'op.result', id: sent.id, result: { ok: true, data: [] } });

    expect(sent.channel).toBe('relay/v1/projects.list');
    await expect(p).resolves.toEqual({ ok: true, data: [] });
  });

  it('times out a request with RUNNER_UNAVAILABLE', async () => {
    const { sup, ready } = setup();
    void sup.start().catch(() => undefined);
    ready();

    const p = sup.request('relay/v1/projects.list', {}, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_001);

    const r = await p;
    expect(!r.ok && r.error.code).toBe('RUNNER_UNAVAILABLE');
  });

  it('queues requests while starting and fails them after 15 s', async () => {
    const { sup } = setup();
    void sup.start().catch(() => undefined);

    const p = sup.request('relay/v1/projects.list', {});
    await vi.advanceTimersByTimeAsync(15_001);

    const r = await p;
    expect(!r.ok && r.error.code).toBe('RUNNER_UNAVAILABLE');
  });

  it('answers credential requests from the vault and refuses a missing provider with AUTH_REQUIRED', async () => {
    const getCredential = vi.fn((p: string) => Promise.resolve(p === 'anthropic' ? ok('sk-key-123') : { ok: false as const, error: errors.authRequired('openai') }));
    const { sup, latest, ready, lines } = setup({ getCredential });
    void sup.start().catch(() => undefined);
    ready();

    latest().port.deliver({ kind: 'credential.request', id: 'c1', providerId: 'anthropic', purpose: 'dispatch', attemptId: null });
    latest().port.deliver({ kind: 'credential.request', id: 'c2', providerId: 'openai', purpose: 'connection_test', attemptId: null });
    await vi.advanceTimersByTimeAsync(0);

    expect(latest().port.sent).toContainEqual({ kind: 'credential.response', id: 'c1', result: { ok: true, apiKey: 'sk-key-123' } });
    const c2 = latest().port.sent.find((m) => (m as { id: string }).id === 'c2') as { result: { ok: boolean; error: { code: string } } };
    expect(c2.result.error.code).toBe('AUTH_REQUIRED');
    expect(JSON.stringify(lines)).not.toContain('sk-key-123');
  });

  it('forwards runner events to windows and marks fatal as unavailable', () => {
    const { sup, latest, ready, events } = setup();
    void sup.start().catch(() => undefined);
    ready();

    latest().port.deliver({ kind: 'event', event: { type: 'providers.changed' } });
    latest().port.deliver({ kind: 'fatal', code: 'INTERNAL', message: 'migration failed' });
    latest().emit('exit', 1);

    expect(events).toContainEqual({ type: 'providers.changed' });
    expect(sup.state().state).toBe('unavailable');
  });

  it('shutdown posts shutdown and resolves when the child exits', async () => {
    const { sup, latest, ready } = setup();
    void sup.start().catch(() => undefined);
    ready();

    const done = sup.shutdown({ graceMs: 5_000 });
    expect(latest().port.sent).toContainEqual({ kind: 'shutdown', graceMs: 5_000 });
    latest().emit('exit', 0);

    await expect(done).resolves.toBeUndefined();
  });
});

describe('minimalEnv', () => {
  const base = { userDataDir: '/ud', homeDir: '/Users/a', tmpDir: '/tmp', providerMode: 'fake' as const, fakeScenario: 'happy', nodeEnv: undefined };

  it('always sets RELAY_USER_DATA_DIR, HOME, TMPDIR and inherits nothing else', () => {
    process.env['OPENAI_API_KEY'] = 'sk-should-not-leak';

    const env = minimalEnv({ ...base, e2e: false, crashAt: 'afterStepCommit@plan' });

    expect(env).toEqual({ RELAY_USER_DATA_DIR: '/ud', HOME: '/Users/a', TMPDIR: '/tmp', RELAY_PROVIDER_MODE: 'fake', RELAY_FAKE_SCENARIO: 'happy' });
    delete process.env['OPENAI_API_KEY'];
  });

  it('forwards RELAY_CRASH_AT only with RELAY_E2E=1', () => {
    expect(minimalEnv({ ...base, e2e: true, crashAt: 'afterStepCommit@plan' })).toMatchObject({ RELAY_E2E: '1', RELAY_CRASH_AT: 'afterStepCommit@plan' });
  });
});
