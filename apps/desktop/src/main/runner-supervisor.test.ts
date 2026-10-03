import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errors, ok } from '@relay/contracts';
import type { PushEvent, Result } from '@relay/contracts';
import type { LogFields, MainLogger } from './logger.js';
import { MAINTENANCE_QUIT_WAIT_MS, RESTART_BACKOFF_MS, createRunnerSupervisor, minimalEnv } from './runner-supervisor.js';
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
    monotonicNow: () => Date.now(), // vi fake timers fake Date; tests with a wall/monotonic split inject their own
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
    expect(children).toHaveLength(1); // backoff: still restarting, no fork yet
    expect(sup.state()).toMatchObject({ state: 'restarting', restarts: 1 });
    await vi.advanceTimersByTimeAsync(RESTART_BACKOFF_MS[0] ?? 0);

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
    await vi.advanceTimersByTimeAsync(500);

    expect(children).toHaveLength(2);
    expect(events).toContainEqual({ type: 'runner.state', state: 'restarting' });
  });

  it('gives up after 3 restarts in 60 s: unavailable, requests fail with RUNNER_UNAVAILABLE', async () => {
    const { sup, children } = setup();
    const started = sup.start();
    started.catch(() => undefined);

    for (let i = 0; i < 4; i += 1) {
      children[i]?.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(8_000); // ≥ every backoff step; 4 crashes stay well inside 60 s
    }

    expect(children).toHaveLength(4);
    expect(sup.state().state).toBe('unavailable');
    await expect(started).rejects.toThrow();
    const r = await sup.request('relay/v1/projects.list', {});
    expect(!r.ok && r.error.code).toBe('RUNNER_UNAVAILABLE');
  });

  it('backs off 0.5 s / 2 s / 8 s between rapid crashes instead of exhausting restarts instantly', async () => {
    const { sup, children, lines } = setup();
    const started = sup.start();
    started.catch(() => undefined);

    children[0]?.emit('exit', 1);
    children[0]?.emit('exit', 1); // a duplicate exit of the dead generation is ignored
    expect(sup.state()).toMatchObject({ state: 'restarting', restarts: 1 });
    await vi.advanceTimersByTimeAsync(499);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(2);

    children[1]?.emit('exit', 1); // crashes right after the fork
    await vi.advanceTimersByTimeAsync(1_999);
    expect(children).toHaveLength(2);
    expect(sup.state().state).toBe('restarting'); // stays restarting during the delay
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(3);

    children[2]?.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(children).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(4);
    expect(lines.filter((l) => l.event === 'runner.restart_scheduled').map((l) => l['delayMs'])).toEqual([500, 2_000, 8_000]);
    expect(sup.state().state).not.toBe('unavailable');
  });

  it('a healthy runner older than the restart window starts the backoff over at 0.5 s', async () => {
    const { sup, children, ready } = setup();
    void sup.start().catch(() => undefined);
    children[0]?.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(500);
    ready(children[1]);
    for (let i = 0; i < 7; i += 1) {
      await vi.advanceTimersByTimeAsync(9_000);
      children[1]?.port.deliver({ kind: 'heartbeat', at: Date.now(), activeRunId: null });
    }

    children[1]?.emit('exit', 1); // > 60 s after the first restart
    await vi.advanceTimersByTimeAsync(500);

    expect(children).toHaveLength(3);
  });

  it('shutdown during a backoff cancels the pending fork', async () => {
    const { sup, children } = setup();
    void sup.start().catch(() => undefined);
    children[0]?.emit('exit', 1);

    await sup.shutdown({ graceMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(children).toHaveLength(1);
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

    expect(latest().port.sent).toContainEqual({ kind: 'credential.response', id: 'c1', providerId: 'anthropic', result: { ok: true, apiKey: 'sk-key-123' } });
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

/**
 * Injected clocks + a manual scheduler (no vi fake timers): `wall` and `mono` are driven independently so a system
 * sleep (wall jumps; the process is suspended, so no timer fires) can be simulated exactly.
 */
function manualClock() {
  let wall = 1_700_000_000_000;
  let mono = 0;
  let nextId = 1;
  const tasks = new Map<number, { at: number; cb: () => void; every?: number }>();
  const timers: SupervisorDeps['timers'] = {
    setTimeout: (cb, ms) => (tasks.set(nextId, { at: mono + ms, cb }), nextId++),
    clearTimeout: (h) => { tasks.delete(h as number); },
    setInterval: (cb, ms) => (tasks.set(nextId, { at: mono + ms, cb, every: ms }), nextId++),
    clearInterval: (h) => { tasks.delete(h as number); },
  };
  /** Runs time forward, firing due timers in order. */
  const advance = (ms: number) => {
    const end = mono + ms;
    for (;;) {
      let due: [number, { at: number; cb: () => void; every?: number }] | undefined;
      for (const e of tasks) if (e[1].at <= end && (due === undefined || e[1].at < due[1].at)) due = e;
      if (due === undefined) break;
      const [id, task] = due;
      const fireAt = Math.max(task.at, mono); // overdue after a suspension: fires once, now (no replay)
      wall += fireAt - mono;
      mono = fireAt;
      if (task.every === undefined) tasks.delete(id);
      else task.at = fireAt + task.every;
      task.cb();
    }
    wall += end - mono;
    mono = end;
  };
  /** The process is suspended for `ms`: nothing fires; `monoAdvances` says whether the monotonic clock ran. */
  const sleep = (ms: number, monoAdvances: boolean) => {
    wall += ms;
    if (monoAdvances) mono += ms; // else: timers are relative to mono, which did not move

  };
  return { timers, advance, sleep, now: () => wall, monotonicNow: () => mono, intervals: () => [...tasks.values()].filter((x) => x.every !== undefined).length };
}

describe('runner supervisor — sleep/resume and races (injected clocks)', () => {
  const beat = (c: FakeChild, at: number) => { c.port.deliver({ kind: 'heartbeat', at, activeRunId: null }); };

  it('F1: a system sleep longer than the stale window (wall clock jumps) never kills a healthy runner', () => {
    const clk = manualClock();
    const { sup, children, ready } = setup({ now: clk.now, monotonicNow: clk.monotonicNow, timers: clk.timers });
    void sup.start().catch(() => undefined);
    ready();
    clk.advance(2_000);
    beat(children[0] as FakeChild, clk.now());

    clk.sleep(10 * 60_000, false); // macOS: mach time stops while asleep; the wall clock jumps 10 min
    clk.advance(1_000);
    beat(children[0] as FakeChild, clk.now());
    clk.advance(2_000);

    expect(children[0]?.killed).toBe(false);
    expect(sup.state().state).toBe('ready');
  });

  it('F1: a watchdog tick gap (monotonic clock ran during suspension) restarts the clock with a grace period', () => {
    const clk = manualClock();
    const { sup, children, ready, lines } = setup({ now: clk.now, monotonicNow: clk.monotonicNow, timers: clk.timers });
    void sup.start().catch(() => undefined);
    ready();
    clk.advance(2_000);

    clk.sleep(60_000, true); // no ticks for 60 s, then the first tick sees the gap
    clk.advance(1_000);
    expect(lines.some((l) => l.event === 'runner.heartbeat_clock_reset' && l['reason'] === 'tick_gap')).toBe(true);
    clk.advance(3_000); // the runner's heartbeat arrives a little late after wake
    beat(children[0] as FakeChild, clk.now());
    clk.advance(5_000);

    expect(children[0]?.killed).toBe(false);
  });

  it('F1: genuinely missing heartbeats after resume still kill — after the 2× stale grace period', () => {
    const clk = manualClock();
    const { sup, children, ready } = setup({ now: clk.now, monotonicNow: clk.monotonicNow, timers: clk.timers });
    void sup.start().catch(() => undefined);
    ready();
    clk.advance(2_000);
    beat(children[0] as FakeChild, clk.now());

    clk.sleep(30 * 60_000, false);
    sup.notifyResume(); // powerMonitor 'resume'
    clk.advance(19_000); // still inside the 20 s grace (2 × RUNNER_STALE_AFTER_MS), no heartbeat at all
    expect(children[0]?.killed).toBe(false);
    clk.advance(2_000);

    expect(children[0]?.killed).toBe(true);
    expect(sup.state().state).toBe('restarting');
  });

  it('F1: after a tick gap, a runner that never heartbeats again is killed once the grace period ends', () => {
    const clk = manualClock();
    const { sup, children, ready } = setup({ now: clk.now, monotonicNow: clk.monotonicNow, timers: clk.timers });
    void sup.start().catch(() => undefined);
    ready();

    clk.sleep(120_000, true);
    clk.advance(1_000);
    expect(children[0]?.killed).toBe(false);
    clk.advance(21_000);

    expect(children[0]?.killed).toBe(true);
  });

  it('a duplicate ready does not start a second watchdog interval', () => {
    const clk = manualClock();
    const { sup, ready, lines } = setup({ now: clk.now, monotonicNow: clk.monotonicNow, timers: clk.timers });
    void sup.start().catch(() => undefined);

    ready();
    ready();

    expect(clk.intervals()).toBe(1);
    expect(lines.filter((l) => l.event === 'runner.ready')).toHaveLength(1);
  });

  it('F2: a credential answer for a runner generation that has since exited is dropped, not sent to the new one', async () => {
    const clk = manualClock();
    let release: (v: Result<string>) => void = () => undefined;
    const getCredential = vi.fn(() => new Promise<Result<string>>((r) => (release = r)));
    const { sup, children, ready, lines } = setup({ now: clk.now, monotonicNow: clk.monotonicNow, timers: clk.timers, getCredential });
    void sup.start().catch(() => undefined);
    ready();
    const old = children[0] as FakeChild;
    old.port.deliver({ kind: 'credential.request', id: 'cred-1', providerId: 'anthropic', purpose: 'dispatch', attemptId: null });

    old.emit('exit', 1); // restart: generation 2 forks with a fresh port (after the first backoff step)
    clk.advance(500);
    const fresh = children[1] as FakeChild;
    ready(fresh);
    release(ok('sk-late-key'));
    await new Promise((r) => setImmediate(r));

    expect(fresh.port.sent.some((m) => (m as { kind: string }).kind === 'credential.response')).toBe(false);
    expect(old.port.sent.some((m) => (m as { kind: string }).kind === 'credential.response')).toBe(false);
    expect(lines.some((l) => l.event === 'runner.credential_dropped')).toBe(true);
  });

  it('F6: start() refuses after shutdown() and forks nothing', async () => {
    const clk = manualClock();
    const { sup, children } = setup({ now: clk.now, monotonicNow: clk.monotonicNow, timers: clk.timers });

    await sup.shutdown({ graceMs: 1_000 });

    await expect(sup.start()).rejects.toThrow(/shut down/);
    expect(children).toHaveLength(0);
  });
});

describe('runner supervisor: manual recovery, lastFatal, activeRunId, maintenance (resilience)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Boots to `unavailable` through a fatal startup error (e.g. a locked / corrupt DB). */
  async function fatalBoot() {
    const h = setup();
    const started = h.sup.start();
    started.catch(() => undefined);
    h.latest().port.deliver({ kind: 'fatal', code: 'DATABASE_UNAVAILABLE', reason: 'database_busy', message: 'The database is locked by another process.' });
    h.latest().emit('exit', 1);
    await vi.advanceTimersByTimeAsync(0);
    return h;
  }

  it('keeps lastFatal {code, reason, message, at} from the fatal message and logs the reason', async () => {
    const { sup, lines } = await fatalBoot();

    expect(sup.state().state).toBe('unavailable');
    expect(sup.state().lastFatal).toEqual({ code: 'DATABASE_UNAVAILABLE', reason: 'database_busy', message: 'The database is locked by another process.', at: expect.any(Number) as number });
    expect(lines.find((l) => l.event === 'runner.fatal')).toMatchObject({ reason: 'database_busy' });
  });

  it('a fatal message without a reason (older runner) keeps reason: null', () => {
    const { sup, latest } = setup();
    void sup.start().catch(() => undefined);

    latest().port.deliver({ kind: 'fatal', code: 'INTERNAL', message: 'boom' });

    expect(sup.state().lastFatal).toMatchObject({ code: 'INTERNAL', reason: null, message: 'boom' });
  });

  it('restart() from unavailable (cause fixed) forks a fresh runner, clears lastFatal, and resolves ready', async () => {
    const { sup, children, ready, events } = await fatalBoot();
    expect(children).toHaveLength(1);

    const p = sup.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(2);
    expect(sup.state().state).toBe('starting');
    expect(sup.state().lastFatal).toBeNull();
    ready(children[1]);

    await expect(p).resolves.toEqual({ restarted: true, state: 'ready' });
    expect(events.filter((e) => e.type === 'runner.state').map((e) => (e as { state: string }).state)).toEqual(['unavailable', 'starting', 'ready']);
    const r = sup.request('relay/v1/projects.list', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(children[1]?.port.sent.at(-1)).toMatchObject({ kind: 'op', channel: 'relay/v1/projects.list' });
    void r.catch(() => undefined);
  });

  it('restart() when the cause persists ends unavailable again with the new lastFatal', async () => {
    const { sup, children } = await fatalBoot();

    const p = sup.restart();
    await vi.advanceTimersByTimeAsync(0);
    children[1]?.port.deliver({ kind: 'fatal', code: 'DATABASE_UNAVAILABLE', reason: 'schema_too_new', message: 'newer schema' });
    children[1]?.emit('exit', 1);

    await expect(p).resolves.toEqual({ restarted: true, state: 'unavailable' });
    expect(sup.state().lastFatal?.reason).toBe('schema_too_new');
  });

  it('restart() also recovers from the restart limit (restart window cleared)', async () => {
    const { sup, children, ready } = setup();
    void sup.start().catch(() => undefined);
    for (let i = 0; i < 4; i += 1) {
      children[i]?.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(8_000);
    }
    expect(sup.state()).toMatchObject({ state: 'unavailable', lastFatal: { code: 'RUNNER_UNAVAILABLE', reason: 'restart_limit' } });

    const p = sup.restart();
    await vi.advanceTimersByTimeAsync(0);
    ready(children[4]);

    await expect(p).resolves.toEqual({ restarted: true, state: 'ready' });
    children[4]?.emit('exit', 1); // a later crash restarts automatically again (fresh window)
    await vi.advanceTimersByTimeAsync(500);
    expect(children).toHaveLength(6);
  });

  it('restart() while a runner is alive (ready / starting) is a no-op and forks nothing', async () => {
    const { sup, children, ready } = setup();
    void sup.start();
    await expect(sup.restart()).resolves.toEqual({ restarted: false, state: 'starting' });
    ready();

    await expect(sup.restart()).resolves.toEqual({ restarted: false, state: 'ready' });
    expect(children).toHaveLength(1);
  });

  it('concurrent restart() calls share one attempt (never two runners)', async () => {
    const { sup, children, ready } = await fatalBoot();

    const a = sup.restart();
    const b = sup.restart();
    await vi.advanceTimersByTimeAsync(0);
    ready(children[1]);

    expect(await a).toEqual(await b);
    expect(children).toHaveLength(2);
  });

  it('restart() waits for a condemned child that has not exited yet before forking', async () => {
    const { sup, latest, children } = setup();
    void sup.start().catch(() => undefined);
    latest().port.deliver({ kind: 'fatal', code: 'INTERNAL', message: 'x' }); // killed, exit not yet observed

    const p = sup.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(1);
    children[0]?.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(2);
    children[1]?.port.deliver({ kind: 'ready', schemaVersion: 1, pid: 2 });

    await expect(p).resolves.toEqual({ restarted: true, state: 'ready' });
  });

  it('restart() after shutdown is a no-op', async () => {
    const { sup, children } = await fatalBoot();
    await sup.shutdown({ graceMs: 0 });

    await expect(sup.restart()).resolves.toEqual({ restarted: false, state: 'unavailable' });
    expect(children).toHaveLength(1);
  });

  it('activeRunId follows heartbeats and run.status events, and clears on exit', () => {
    const { sup, latest, ready } = setup();
    void sup.start();
    ready();
    const RUN = 'run_01J0000000000000000000000A';

    latest().port.deliver({ kind: 'event', event: { type: 'run.status', runId: RUN, status: 'running', pauseReason: null, seq: 3 } });
    expect(sup.state().activeRunId).toBe(RUN);
    latest().port.deliver({ kind: 'event', event: { type: 'run.status', runId: RUN, status: 'completed', pauseReason: null, seq: 9 } });
    expect(sup.state().activeRunId).toBeNull();
    latest().port.deliver({ kind: 'heartbeat', at: 1, activeRunId: RUN });
    expect(sup.state().activeRunId).toBe(RUN);
    latest().emit('exit', 1);
    expect(sup.state().activeRunId).toBeNull();
  });

  it('runMaintenance forks a task runner (RELAY_RUNNER_TASK) only while unavailable and resolves its result', async () => {
    const { sup, children } = await fatalBoot();
    expect(await setup().sup.runMaintenance('restore_latest_backup')).toEqual({ ok: false, reason: 'runner_active' }); // idle supervisor: not unavailable

    const p = sup.runMaintenance('restore_latest_backup');
    const child = children[1];
    expect(child).toBeDefined();
    child?.port.deliver({
      kind: 'maintenance.result', task: 'restore_latest_backup',
      result: { ok: true, restored: true, restoredFromDisplayPath: '~/b', backupCreatedAt: 5, previousMovedToDisplayPath: null },
    });
    child?.emit('exit', 0);

    await expect(p).resolves.toMatchObject({ ok: true, result: { ok: true, restored: true } });
    expect(sup.state().state).toBe('unavailable'); // the caller restarts
  });

  it('round-3 L1: shutdown() during a restore waits for the maintenance child to finish (no kill); maintenanceRunning() reports it', async () => {
    const { sup, children } = await fatalBoot();
    expect(sup.maintenanceRunning()).toBe(false);
    const m = sup.runMaintenance('restore_latest_backup');
    const maint = children[1];
    if (maint === undefined) throw new Error('no maintenance child');
    expect(sup.maintenanceRunning()).toBe(true);
    let shutDown = false;
    const s = sup.shutdown({ graceMs: 5_000 }).then(() => {
      shutDown = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(shutDown).toBe(false); // the quit waits for the restore
    expect(maint.killed).toBe(false);

    maint.port.deliver({ kind: 'maintenance.result', task: 'restore_latest_backup',
      result: { ok: true, restored: true, restoredFromDisplayPath: '~/b', backupCreatedAt: 5, previousMovedToDisplayPath: null } });
    maint.emit('exit', 0);
    await s;
    await expect(m).resolves.toMatchObject({ ok: true });
    expect(maint.killed).toBe(false);
    expect(sup.maintenanceRunning()).toBe(false);
  });

  it('round-3 L1: shutdown() kills a restore that outlives the quit cap', async () => {
    const { sup, children, lines } = await fatalBoot();
    void sup.runMaintenance('restore_latest_backup');
    const maint = children[1];
    if (maint === undefined) throw new Error('no maintenance child');
    let shutDown = false;
    void sup.shutdown({ graceMs: 5_000 }).then(() => {
      shutDown = true;
    });

    await vi.advanceTimersByTimeAsync(MAINTENANCE_QUIT_WAIT_MS + 1);

    expect(maint.killed).toBe(true);
    expect(shutDown).toBe(true);
    expect(lines).toContainEqual(expect.objectContaining({ event: 'runner.kill', reason: 'maintenance_quit' }));
    expect(sup.maintenanceRunning()).toBe(false);
  });

  it('runMaintenance passes the task in the env and reports an exit without a result', async () => {
    const envs: Record<string, string>[] = [];
    const children: FakeChild[] = [];
    const h = setup({
      fork: (_e, _a, opts) => {
        envs.push(opts.env);
        const c = new FakeChild();
        children.push(c);
        return c;
      },
      createChannel: () => {
        const port1 = new FakePort();
        const c = children.at(-1);
        if (c !== undefined) c.port = port1;
        return { port1, port2: {} };
      },
    });
    void h.sup.start().catch(() => undefined);
    children[0]?.port.deliver({ kind: 'fatal', code: 'INTERNAL', message: 'x' });
    children[0]?.emit('exit', 1);

    const p = h.sup.runMaintenance('restore_latest_backup');
    expect(envs[1]).toMatchObject({ RELAY_USER_DATA_DIR: '/ud', RELAY_RUNNER_TASK: 'restore_latest_backup' });
    expect(envs[0]).not.toHaveProperty('RELAY_RUNNER_TASK');
    children[1]?.emit('exit', 1);

    await expect(p).resolves.toEqual({ ok: false, reason: 'exited' });
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
