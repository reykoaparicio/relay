// 08 H6: the runner supervisor (§6.4). Forks the runner as a utility process, talks to it over a MessageChannelMain
// (both ends call start()), drains its stdout/stderr, waits for `ready`, watches heartbeats only after ready, and
// restarts it (at most 3 times per 60 s) — always waiting for the old child's `exit` before forking again.
import { RUNNER_SHUTDOWN_MAX_GRACE_MS, RUNNER_STALE_AFTER_MS, appError, assertNever, epochMs, errors, getRunnerOperation, runnerMessageSchema, runnerRequestSchema } from '@relay/contracts';
import type { AppError, EpochMs, IpcResult, PushEvent, Result, RunnerChannel, RunnerInputOf, RunnerMessage, RunnerRequest, RunnerState, ProviderId } from '@relay/contracts';
import type { MainLogger } from './logger.js';
import type { RunnerRequestOptions, RunnerRequester } from './ipc/types.js';

/** A readable pipe of the child (`utilityProcess` stdout/stderr). */
export interface PipeLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

/** The part of Electron's `UtilityProcess` the supervisor uses. */
export interface UtilityChildLike {
  readonly pid: number | undefined;
  readonly stdout: PipeLike | null;
  readonly stderr: PipeLike | null;
  postMessage(message: unknown, transfer?: unknown[]): void;
  kill(): boolean;
  on(event: 'exit', listener: (code: number) => void): unknown;
}

/** The part of `MessagePortMain` the supervisor uses. */
export interface MainPortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown;
  start(): void;
  postMessage(message: unknown): void;
  close(): void;
}

/** Injected timers (fake timers in tests). */
export interface SupervisorTimers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

/** Fork options (a subset of Electron's `ForkOptions`). */
export interface ForkOptions {
  readonly serviceName: string;
  readonly stdio: 'pipe';
  readonly env: Record<string, string>;
}

/** Tunables (defaults per 08 H6). */
export interface SupervisorConfig {
  readonly startupTimeoutMs: number;
  readonly queueWaitMs: number;
  readonly queryTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly staleAfterMs: number;
  readonly watchdogIntervalMs: number;
  readonly restartWindowMs: number;
  readonly maxRestarts: number;
  /** Extra time after the grace period before a non-exiting runner is killed. */
  readonly shutdownKillSlackMs: number;
  /**
   * After a system resume (or a watchdog tick that observes a gap of at least `sleepGapTicks` tick intervals), the
   * heartbeat clock restarts and staleness is not judged for this long.
   */
  readonly resumeGraceMs: number;
  /** A watchdog gap this many intervals long is treated as a suspend/resume. */
  readonly sleepGapTicks: number;
}

/** 08 H6 defaults. */
export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  startupTimeoutMs: 60_000,
  queueWaitMs: 15_000,
  queryTimeoutMs: 30_000,
  commandTimeoutMs: 60_000,
  staleAfterMs: RUNNER_STALE_AFTER_MS,
  watchdogIntervalMs: 1_000,
  restartWindowMs: 60_000,
  maxRestarts: 3,
  shutdownKillSlackMs: 1_000,
  resumeGraceMs: 2 * RUNNER_STALE_AFTER_MS,
  sleepGapTicks: 3,
};

/** Dependencies of {@link createRunnerSupervisor}. */
export interface SupervisorDeps {
  readonly fork: (entryPath: string, args: string[], opts: ForkOptions) => UtilityChildLike;
  readonly createChannel: () => { port1: MainPortLike; port2: unknown };
  readonly entryPath: string;
  /** From {@link minimalEnv}; never contains secrets. */
  readonly env: Record<string, string>;
  /** Wall-clock epoch ms (restart-window bookkeeping and the diagnostics timestamp only). */
  readonly now: () => number;
  /**
   * Monotonic ms (`performance.now`) for heartbeat staleness. Wall clock jumps (NTP, manual changes, sleep) must
   * never make a healthy runner look stale. Defaults to `performance.now()`.
   */
  readonly monotonicNow?: () => number;
  readonly timers: SupervisorTimers;
  readonly logger: MainLogger;
  /** Answers `credential.request` (vault.get). */
  readonly getCredential: (providerId: ProviderId) => Promise<Result<string>>;
  /** Forwards push events to every window on `relay/v1/events`. */
  readonly broadcast: (e: PushEvent) => void;
  readonly config?: Partial<SupervisorConfig>;
}

/** Supervisor state snapshot (diagnostics). */
export interface SupervisorSnapshot {
  readonly state: RunnerState;
  readonly pid?: number;
  readonly lastHeartbeatAt?: EpochMs;
  readonly restarts: number;
}

/** The supervisor (08 H6). */
export interface RunnerSupervisor extends RunnerRequester {
  /** Resolves on the first `ready`; rejects when the runner becomes `unavailable` before that. */
  start(): Promise<void>;
  shutdown(opts: { graceMs: number }): Promise<void>;
  state(): SupervisorSnapshot;
  request<C extends RunnerChannel>(channel: C, input: RunnerInputOf<C>, opts?: RunnerRequestOptions): Promise<IpcResult<C>>;
  /** Call on `powerMonitor` 'resume': restarts the heartbeat clock with a grace period (no kill for sleeping). */
  notifyResume(): void;
}

/** Inputs of {@link minimalEnv}. */
export interface RunnerEnvInput {
  readonly userDataDir: string;
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly providerMode: 'live' | 'fake';
  readonly fakeScenario: string | null;
  readonly e2e: boolean;
  readonly crashAt: string | undefined;
  readonly nodeEnv: string | undefined;
}

/** 08 H6: the runner's whole environment. Nothing is inherited from `process.env`; no API keys, ever. */
export function minimalEnv(i: RunnerEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    RELAY_USER_DATA_DIR: i.userDataDir,
    HOME: i.homeDir,
    TMPDIR: i.tmpDir,
    RELAY_PROVIDER_MODE: i.providerMode,
  };
  if (i.providerMode === 'fake' && i.fakeScenario !== null) env['RELAY_FAKE_SCENARIO'] = i.fakeScenario;
  if (i.e2e) {
    env['RELAY_E2E'] = '1';
    if (i.crashAt !== undefined && i.crashAt !== '') env['RELAY_CRASH_AT'] = i.crashAt;
  }
  if (i.nodeEnv !== undefined) env['NODE_ENV'] = i.nodeEnv;
  return env;
}

type Pending = { resolve: (r: IpcResult<RunnerChannel>) => void; timer: unknown };

/** Creates the supervisor. */
export function createRunnerSupervisor(deps: SupervisorDeps): RunnerSupervisor {
  const cfg: SupervisorConfig = { ...DEFAULT_SUPERVISOR_CONFIG, ...deps.config };
  const t = deps.timers;
  const log = deps.logger;
  const mono = deps.monotonicNow ?? (() => performance.now());

  let state: RunnerState = 'starting';
  let child: UtilityChildLike | null = null;
  let port: MainPortLike | null = null;
  let generation = 0;
  let startupTimer: unknown = null;
  let watchdog: unknown = null;
  /** Wall-clock time of the last heartbeat (diagnostics only). */
  let lastHeartbeatAt: number | undefined;
  /** Monotonic time of the last heartbeat (or of ready / resume): the staleness reference. */
  let lastBeatMono: number | undefined;
  /** Monotonic time until which staleness is not judged (after a resume). */
  let graceUntilMono = 0;
  /** Monotonic time of the previous watchdog tick (sleep-gap detection). */
  let lastTickMono: number | undefined;
  let everShutdown = false;
  let restarts = 0;
  let restartTimes: number[] = [];
  let started: Promise<void> | null = null;
  let shuttingDown = false;
  let fatal = false;
  let seq = 0;
  let killRequestedGen = -1;
  const pending = new Map<string, Pending>();
  let readyWaiters: ((ready: boolean) => void)[] = [];
  let exitWaiters: (() => void)[] = [];

  const unavailable = (reason: string): AppError =>
    appError('RUNNER_UNAVAILABLE', { details: { reason } });

  const setState = (next: RunnerState): void => {
    if (next === state) return;
    state = next;
    log.info({ event: 'runner.state', state: next, outcome: next === 'unavailable' ? 'error' : 'ok' });
    deps.broadcast({ type: 'runner.state', state: next });
  };

  const settleReadyWaiters = (ready: boolean): void => {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const w of waiters) w(ready);
  };

  const post = (msg: RunnerRequest): void => {
    const checked = runnerRequestSchema.safeParse(msg);
    if (!checked.success || port === null) {
      log.error({ event: 'runner.post_failed', kind: msg.kind, outcome: 'error' });
      return;
    }
    port.postMessage(msg);
  };

  const clearTimers = (): void => {
    if (startupTimer !== null) t.clearTimeout(startupTimer);
    if (watchdog !== null) t.clearInterval(watchdog);
    startupTimer = null;
    watchdog = null;
  };

  const drain = (pipe: PipeLike | null, event: 'runner.stdout' | 'runner.stderr'): void => {
    if (pipe === null) return;
    let buffered = '';
    pipe.on('data', (chunk) => {
      buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) if (line.trim() !== '') log.info({ event, line });
    });
  };

  /** Restarts the staleness clock and opens a grace window (system resume or an observed sleep gap). */
  const restartHeartbeatClock = (reason: string): void => {
    if (state !== 'ready' || watchdog === null) return;
    const n = mono();
    lastBeatMono = n;
    lastTickMono = n;
    graceUntilMono = n + cfg.resumeGraceMs;
    log.info({ event: 'runner.heartbeat_clock_reset', reason, graceMs: cfg.resumeGraceMs });
  };

  const kill = (reason: string): void => {
    log.warn({ event: 'runner.kill', reason, pid: child?.pid, outcome: 'error' });
    child?.kill();
  };

  const onReady = (gen: number, msg: Extract<RunnerMessage, { kind: 'ready' }>): void => {
    // A duplicate `ready` (or one arriving after the watchdog already condemned this child) must not start a second
    // watchdog interval nor resurrect a child that is being killed.
    if (watchdog !== null || (state !== 'starting' && state !== 'restarting') || killRequestedGen === gen) {
      log.warn({ event: 'runner.duplicate_ready', generation: gen, outcome: 'error' });
      return;
    }
    if (startupTimer !== null) t.clearTimeout(startupTimer);
    startupTimer = null;
    lastHeartbeatAt = deps.now();
    lastBeatMono = mono();
    lastTickMono = lastBeatMono;
    graceUntilMono = 0;
    log.info({ event: 'runner.ready', schemaVersion: msg.schemaVersion, pid: msg.pid, outcome: 'ok' });
    setState('ready');
    // Heartbeat staleness applies only after ready (never during startup: migrations may be slow). It is judged on
    // the monotonic clock; a tick gap much longer than the interval means the process was suspended (system sleep),
    // so the clock restarts with a grace period instead of killing a healthy runner.
    watchdog = t.setInterval(() => {
      if (gen !== generation || state !== 'ready' || lastBeatMono === undefined) return;
      const n = mono();
      const gap = lastTickMono === undefined ? 0 : n - lastTickMono;
      lastTickMono = n;
      if (gap >= cfg.sleepGapTicks * cfg.watchdogIntervalMs) {
        restartHeartbeatClock('tick_gap');
        return;
      }
      if (n < graceUntilMono) return;
      if (n - lastBeatMono <= cfg.staleAfterMs) return;
      if (watchdog !== null) t.clearInterval(watchdog);
      watchdog = null;
      killRequestedGen = gen;
      setState('restarting');
      kill('heartbeat_stale');
    }, cfg.watchdogIntervalMs);
    settleReadyWaiters(true);
  };

  const answerCredential = async (gen: number, msg: Extract<RunnerMessage, { kind: 'credential.request' }>): Promise<void> => {
    log.info({ event: 'runner.credential_request', providerId: msg.providerId, purpose: msg.purpose, attemptId: msg.attemptId });
    const askedOn = port;
    let r: Result<string>;
    try {
      r = await deps.getCredential(msg.providerId);
    } catch {
      r = { ok: false, error: errors.authRequired(msg.providerId) };
    }
    // The runner that asked may have exited and been replaced while the vault was answering: its request id could
    // collide with one of the new generation's. Never hand a key to a runner generation that did not ask for it.
    if (gen !== generation || askedOn === null || port !== askedOn) {
      log.warn({ event: 'runner.credential_dropped', providerId: msg.providerId, reason: 'generation_changed', outcome: 'error' });
      return;
    }
    // `providerId` is echoed so the runner can verify the answer is for the provider it asked about.
    const response: Extract<RunnerRequest, { kind: 'credential.response' }> & { providerId: ProviderId } = {
      kind: 'credential.response', id: msg.id, providerId: msg.providerId,
      result: r.ok ? { ok: true, apiKey: r.value } : { ok: false, error: r.error },
    };
    post(response);
    log.info({ event: 'runner.credential_response', providerId: msg.providerId, outcome: r.ok ? 'ok' : 'error', ...(r.ok ? {} : { code: r.error.code }) });
  };

  const onMessage = (gen: number, raw: unknown): void => {
    if (gen !== generation) return;
    const parsed = runnerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn({ event: 'runner.invalid_message', outcome: 'error' });
      return;
    }
    const msg = parsed.data;
    switch (msg.kind) {
      case 'ready':
        onReady(gen, msg);
        return;
      case 'heartbeat':
        lastHeartbeatAt = deps.now();
        lastBeatMono = mono();
        return;
      case 'op.result': {
        const p = pending.get(msg.id);
        if (p === undefined) return;
        pending.delete(msg.id);
        t.clearTimeout(p.timer);
        p.resolve(msg.result as IpcResult<RunnerChannel>);
        return;
      }
      case 'credential.request':
        void answerCredential(gen, msg);
        return;
      case 'event':
        deps.broadcast(msg.event);
        return;
      case 'fatal':
        log.error({ event: 'runner.fatal', code: msg.code, message: msg.message, outcome: 'error' });
        fatal = true;
        setState('unavailable');
        settleReadyWaiters(false);
        kill('fatal');
        return;
      default:
        assertNever(msg);
    }
  };

  const failPending = (reason: string): void => {
    for (const [id, p] of pending) {
      t.clearTimeout(p.timer);
      pending.delete(id);
      p.resolve({ ok: false, error: unavailable(reason) });
    }
  };

  const giveUp = (): void => {
    setState('unavailable');
    settleReadyWaiters(false);
  };

  let spawn: () => void = () => undefined;

  const restartOrGiveUp = (): void => {
    const now = deps.now();
    restartTimes = restartTimes.filter((x) => now - x < cfg.restartWindowMs);
    if (restartTimes.length >= cfg.maxRestarts) {
      log.error({ event: 'runner.restart_limit', restarts, outcome: 'error' });
      giveUp();
      return;
    }
    restartTimes.push(now);
    restarts += 1;
    setState('restarting');
    spawn();
  };

  const onExit = (gen: number, code: number): void => {
    if (gen !== generation) return;
    clearTimers();
    port?.close();
    port = null;
    child = null;
    lastHeartbeatAt = undefined;
    lastBeatMono = undefined;
    lastTickMono = undefined;
    failPending('runner_exited');
    log.info({ event: 'runner.exit', code, outcome: code === 0 ? 'ok' : 'error' });
    const waiters = exitWaiters;
    exitWaiters = [];
    for (const w of waiters) w();
    if (shuttingDown) return;
    if (fatal) {
      giveUp();
      return;
    }
    restartOrGiveUp(); // the old child has exited: safe to fork again (§6.4)
  };

  spawn = (): void => {
    generation += 1;
    const gen = generation;
    const c = deps.fork(deps.entryPath, [], { serviceName: 'relay-runner', stdio: 'pipe', env: deps.env });
    child = c;
    drain(c.stdout, 'runner.stdout');
    drain(c.stderr, 'runner.stderr');
    const { port1, port2 } = deps.createChannel();
    port = port1;
    port1.on('message', (e) => {
      onMessage(gen, e.data);
    });
    port1.start(); // MessagePortMain queues messages until start(): without it `ready` never arrives
    c.on('exit', (code) => {
      onExit(gen, code);
    });
    c.postMessage({ kind: 'init' }, [port2]);
    log.info({ event: 'runner.fork', pid: c.pid, generation: gen });
    startupTimer = t.setTimeout(() => {
      if (gen !== generation || state === 'ready') return;
      startupTimer = null;
      killRequestedGen = gen;
      kill('startup_timeout');
    }, cfg.startupTimeoutMs);
  };

  const waitForReady = (ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const timer = t.setTimeout(() => {
        readyWaiters = readyWaiters.filter((w) => w !== waiter);
        resolve(false);
      }, ms);
      const waiter = (ready: boolean): void => {
        t.clearTimeout(timer);
        resolve(ready);
      };
      readyWaiters.push(waiter);
    });

  const send = <C extends RunnerChannel>(channel: C, input: unknown, opts?: RunnerRequestOptions): Promise<IpcResult<C>> => {
    seq += 1;
    const id = `req-${String(seq)}`;
    const kind = getRunnerOperation(channel)?.kind ?? 'command';
    const timeoutMs = opts?.timeoutMs ?? (kind === 'query' ? cfg.queryTimeoutMs : cfg.commandTimeoutMs);
    return new Promise<IpcResult<C>>((resolve) => {
      const timer = t.setTimeout(() => {
        pending.delete(id);
        log.warn({ event: 'runner.request_timeout', channel, outcome: 'error', code: 'RUNNER_UNAVAILABLE' });
        resolve({ ok: false, error: unavailable('timeout') });
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (r: IpcResult<RunnerChannel>) => void, timer });
      post({ kind: 'op', id, channel, input });
    });
  };

  return {
    start() {
      // After shutdown() the supervisor is finished for good (app quit): never fork a runner that nobody will stop.
      if (everShutdown) return Promise.reject(new Error('runner supervisor is shut down'));
      if (started !== null) return started;
      shuttingDown = false;
      started = new Promise<void>((resolve, reject) => {
        readyWaiters.push((ready) => {
          if (ready) resolve();
          else reject(new Error('runner unavailable'));
        });
      });
      spawn();
      return started;
    },

    async request<C extends RunnerChannel>(channel: C, input: RunnerInputOf<C>, opts?: RunnerRequestOptions): Promise<IpcResult<C>> {
      if (state === 'unavailable' || shuttingDown || started === null) return { ok: false, error: unavailable(state) };
      if (state !== 'ready' && !(await waitForReady(cfg.queueWaitMs))) return { ok: false, error: unavailable('not_ready') };
      return send(channel, input, opts);
    },

    notifyResume() {
      restartHeartbeatClock('power_resume');
    },

    async shutdown({ graceMs }) {
      everShutdown = true;
      shuttingDown = true;
      clearTimers();
      settleReadyWaiters(false);
      if (child === null) return;
      const exited = new Promise<void>((resolve) => exitWaiters.push(resolve));
      post({ kind: 'shutdown', graceMs: Math.min(graceMs, RUNNER_SHUTDOWN_MAX_GRACE_MS) });
      const killTimer = t.setTimeout(() => {
        kill('shutdown_timeout');
      }, graceMs + cfg.shutdownKillSlackMs);
      await exited;
      t.clearTimeout(killTimer);
    },

    state() {
      const pid = child?.pid;
      return {
        state,
        restarts,
        ...(pid === undefined ? {} : { pid }),
        ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: epochMs(lastHeartbeatAt) }),
      };
    },
  };
}
