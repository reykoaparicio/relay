// 08 H6: the runner supervisor (§6.4). Forks the runner as a utility process, talks to it over a MessageChannelMain
// (both ends call start()), drains its stdout/stderr, waits for `ready`, watches heartbeats only after ready, and
// restarts it (at most 3 times per 60 s, after a 0.5 s / 2 s / 8 s backoff) — always waiting for the old child's
// `exit` before forking again.
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
  /** Restart-window length, judged on the monotonic clock. */
  readonly restartWindowMs: number;
  readonly maxRestarts: number;
  /**
   * Delay before the n-th restart within the window (index = restarts already in the window; the last entry repeats).
   * The supervisor stays `restarting` during the delay; shutdown cancels it.
   */
  readonly restartBackoffMs: readonly number[];
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

/** 08 H6: backoff before the 1st/2nd/3rd restart within the restart window. */
export const RESTART_BACKOFF_MS: readonly number[] = [500, 2_000, 8_000];

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
  restartBackoffMs: RESTART_BACKOFF_MS,
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
  /** Wall-clock epoch ms (the diagnostics heartbeat timestamp only). */
  readonly now: () => number;
  /**
   * Monotonic ms (`performance.now`) for heartbeat staleness and the restart window. Wall clock jumps (NTP, manual changes, sleep) must
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

/**
 * Lifecycle of the supervisor itself (not of a runner): `idle` until start(), `running` while it keeps a runner up,
 * `shut_down` once shutdown() was called — final: the supervisor never forks again (app quit).
 */
type Phase = 'idle' | 'running' | 'shut_down';

/** Per-generation state: one forked runner, its port, timers, and heartbeat bookkeeping. */
interface Session {
  readonly gen: number;
  readonly child: UtilityChildLike;
  port: MainPortLike | null;
  startupTimer: unknown;
  watchdog: unknown;
  /** Wall-clock time of the last heartbeat (diagnostics only). */
  lastHeartbeatAt: number | undefined;
  /** Monotonic time of the last heartbeat (or of ready / resume): the staleness reference. */
  lastBeatMono: number | undefined;
  /** Monotonic time until which staleness is not judged (after a resume). */
  graceUntilMono: number;
  /** Monotonic time of the previous watchdog tick (sleep-gap detection). */
  lastTickMono: number | undefined;
  /** The supervisor condemned this child (startup timeout / stale heartbeats): a late `ready` must not revive it. */
  killRequested: boolean;
}

/** Creates the supervisor. */
export function createRunnerSupervisor(deps: SupervisorDeps): RunnerSupervisor {
  const cfg: SupervisorConfig = { ...DEFAULT_SUPERVISOR_CONFIG, ...deps.config };
  const t = deps.timers;
  const log = deps.logger;
  const mono = deps.monotonicNow ?? (() => performance.now());

  let state: RunnerState = 'starting';
  let phase: Phase = 'idle';
  /** The current runner generation (null between an exit and the next fork). */
  let session: Session | null = null;
  let generation = 0;
  /** Pending backoff before the next fork (null when none). */
  let restartTimer: unknown = null;
  let restarts = 0;
  /** Monotonic times of the restarts inside the window. */
  let restartTimes: number[] = [];
  let started: Promise<void> | null = null;
  let fatal = false;
  let seq = 0;
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
    const port = session?.port ?? null;
    if (!checked.success || port === null) {
      log.error({ event: 'runner.post_failed', kind: msg.kind, outcome: 'error' });
      return;
    }
    port.postMessage(msg);
  };

  const clearSessionTimers = (s: Session): void => {
    if (s.startupTimer !== null) t.clearTimeout(s.startupTimer);
    if (s.watchdog !== null) t.clearInterval(s.watchdog);
    s.startupTimer = null;
    s.watchdog = null;
  };

  const clearRestartTimer = (): void => {
    if (restartTimer !== null) t.clearTimeout(restartTimer);
    restartTimer = null;
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
    const s = session;
    if (state !== 'ready' || s === null || s.watchdog === null) return;
    const n = mono();
    s.lastBeatMono = n;
    s.lastTickMono = n;
    s.graceUntilMono = n + cfg.resumeGraceMs;
    log.info({ event: 'runner.heartbeat_clock_reset', reason, graceMs: cfg.resumeGraceMs });
  };

  const kill = (s: Session | null, reason: string): void => {
    log.warn({ event: 'runner.kill', reason, pid: s?.child.pid, outcome: 'error' });
    s?.child.kill();
  };

  const onReady = (s: Session, msg: Extract<RunnerMessage, { kind: 'ready' }>): void => {
    // A duplicate `ready` (or one arriving after the watchdog already condemned this child) must not start a second
    // watchdog interval nor resurrect a child that is being killed.
    if (s.watchdog !== null || (state !== 'starting' && state !== 'restarting') || s.killRequested) {
      log.warn({ event: 'runner.duplicate_ready', generation: s.gen, outcome: 'error' });
      return;
    }
    if (s.startupTimer !== null) t.clearTimeout(s.startupTimer);
    s.startupTimer = null;
    s.lastHeartbeatAt = deps.now();
    s.lastBeatMono = mono();
    s.lastTickMono = s.lastBeatMono;
    s.graceUntilMono = 0;
    log.info({ event: 'runner.ready', schemaVersion: msg.schemaVersion, pid: msg.pid, outcome: 'ok' });
    setState('ready');
    // Heartbeat staleness applies only after ready (never during startup: migrations may be slow). It is judged on
    // the monotonic clock; a tick gap much longer than the interval means the process was suspended (system sleep),
    // so the clock restarts with a grace period instead of killing a healthy runner.
    s.watchdog = t.setInterval(() => {
      if (s !== session || state !== 'ready' || s.lastBeatMono === undefined) return;
      const n = mono();
      const gap = s.lastTickMono === undefined ? 0 : n - s.lastTickMono;
      s.lastTickMono = n;
      if (gap >= cfg.sleepGapTicks * cfg.watchdogIntervalMs) {
        restartHeartbeatClock('tick_gap');
        return;
      }
      if (n < s.graceUntilMono) return;
      if (n - s.lastBeatMono <= cfg.staleAfterMs) return;
      if (s.watchdog !== null) t.clearInterval(s.watchdog);
      s.watchdog = null;
      s.killRequested = true;
      setState('restarting');
      kill(s, 'heartbeat_stale');
    }, cfg.watchdogIntervalMs);
    settleReadyWaiters(true);
  };

  const answerCredential = async (s: Session, msg: Extract<RunnerMessage, { kind: 'credential.request' }>): Promise<void> => {
    log.info({ event: 'runner.credential_request', providerId: msg.providerId, purpose: msg.purpose, attemptId: msg.attemptId });
    const askedOn = s.port;
    let r: Result<string>;
    try {
      r = await deps.getCredential(msg.providerId);
    } catch {
      r = { ok: false, error: errors.authRequired(msg.providerId) };
    }
    // The runner that asked may have exited and been replaced while the vault was answering: its request id could
    // collide with one of the new generation's. Never hand a key to a runner generation that did not ask for it.
    if (s !== session || askedOn === null || s.port !== askedOn) {
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

  const onMessage = (s: Session, raw: unknown): void => {
    if (s !== session) return;
    const parsed = runnerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn({ event: 'runner.invalid_message', outcome: 'error' });
      return;
    }
    const msg = parsed.data;
    switch (msg.kind) {
      case 'ready':
        onReady(s, msg);
        return;
      case 'heartbeat':
        s.lastHeartbeatAt = deps.now();
        s.lastBeatMono = mono();
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
        void answerCredential(s, msg);
        return;
      case 'event':
        deps.broadcast(msg.event);
        return;
      case 'fatal':
        log.error({ event: 'runner.fatal', code: msg.code, message: msg.message, outcome: 'error' });
        fatal = true;
        setState('unavailable');
        settleReadyWaiters(false);
        kill(s, 'fatal');
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
    const n = mono();
    restartTimes = restartTimes.filter((x) => n - x < cfg.restartWindowMs);
    if (restartTimes.length >= cfg.maxRestarts) {
      log.error({ event: 'runner.restart_limit', restarts, outcome: 'error' });
      giveUp();
      return;
    }
    const backoff = cfg.restartBackoffMs;
    const delayMs = backoff.length === 0 ? 0 : (backoff[Math.min(restartTimes.length, backoff.length - 1)] ?? 0);
    restartTimes.push(n);
    restarts += 1;
    setState('restarting');
    log.info({ event: 'runner.restart_scheduled', restarts, delayMs });
    // Crash loops back off; the state stays `restarting` (requests queue for up to queueWaitMs) until the fork.
    restartTimer = t.setTimeout(() => {
      restartTimer = null;
      if (phase === 'running') spawn();
    }, delayMs);
  };

  const onExit = (s: Session, code: number): void => {
    if (s !== session) return;
    clearSessionTimers(s);
    s.port?.close();
    s.port = null;
    session = null;
    failPending('runner_exited');
    log.info({ event: 'runner.exit', code, outcome: code === 0 ? 'ok' : 'error' });
    const waiters = exitWaiters;
    exitWaiters = [];
    for (const w of waiters) w();
    if (phase !== 'running') return;
    if (fatal) {
      giveUp();
      return;
    }
    restartOrGiveUp(); // the old child has exited: safe to fork again (§6.4)
  };

  spawn = (): void => {
    generation += 1;
    const c = deps.fork(deps.entryPath, [], { serviceName: 'relay-runner', stdio: 'pipe', env: deps.env });
    const { port1, port2 } = deps.createChannel();
    const s: Session = {
      gen: generation, child: c, port: port1, startupTimer: null, watchdog: null,
      lastHeartbeatAt: undefined, lastBeatMono: undefined, graceUntilMono: 0, lastTickMono: undefined, killRequested: false,
    };
    session = s;
    drain(c.stdout, 'runner.stdout');
    drain(c.stderr, 'runner.stderr');
    port1.on('message', (e) => {
      onMessage(s, e.data);
    });
    port1.start(); // MessagePortMain queues messages until start(): without it `ready` never arrives
    c.on('exit', (code) => {
      onExit(s, code);
    });
    c.postMessage({ kind: 'init' }, [port2]);
    log.info({ event: 'runner.fork', pid: c.pid, generation: s.gen });
    s.startupTimer = t.setTimeout(() => {
      s.startupTimer = null;
      if (s !== session || state === 'ready') return;
      s.killRequested = true;
      kill(s, 'startup_timeout');
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
      if (phase === 'shut_down') return Promise.reject(new Error('runner supervisor is shut down'));
      if (started !== null) return started;
      phase = 'running';
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
      if (state === 'unavailable' || phase !== 'running') return { ok: false, error: unavailable(state) };
      if (state !== 'ready' && !(await waitForReady(cfg.queueWaitMs))) return { ok: false, error: unavailable('not_ready') };
      return send(channel, input, opts);
    },

    notifyResume() {
      restartHeartbeatClock('power_resume');
    },

    async shutdown({ graceMs }) {
      phase = 'shut_down';
      clearRestartTimer(); // a pending backoff never forks after shutdown
      if (session !== null) clearSessionTimers(session);
      settleReadyWaiters(false);
      const s = session;
      if (s === null) return;
      const exited = new Promise<void>((resolve) => exitWaiters.push(resolve));
      post({ kind: 'shutdown', graceMs: Math.min(graceMs, RUNNER_SHUTDOWN_MAX_GRACE_MS) });
      const killTimer = t.setTimeout(() => {
        kill(s, 'shutdown_timeout');
      }, graceMs + cfg.shutdownKillSlackMs);
      await exited;
      t.clearTimeout(killTimer);
    },

    state() {
      const pid = session?.child.pid;
      const lastHeartbeatAt = session?.lastHeartbeatAt;
      return {
        state,
        restarts,
        ...(pid === undefined ? {} : { pid }),
        ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: epochMs(lastHeartbeatAt) }),
      };
    },
  };
}
