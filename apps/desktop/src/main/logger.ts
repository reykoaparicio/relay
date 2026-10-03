// 08 logging: structured JSONL lines (00b §3 fields incl. `outcome`) in logs/<YYYY-MM-DD>.jsonl, redacted before
// writing (02 §B8). Daily files; 14 days kept. The file logger is buffered (one async append per flush window, per
// day file); error lines and flushSync() write synchronously so the lines that explain a crash survive it.
// When logs/ cannot be written (disk full, permissions), lines go to `<os tmp>/relay-logs/` and stderr instead, and
// the logger reports itself degraded (diagnostics `loggingDegraded`) until a write to logs/ succeeds again.
import { appendFileSync, mkdirSync, promises as fsp, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactDeep } from '@relay/contracts';

/** Log level. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One structured log line; `event` is required, the rest are 00b §3 fields or event-specific extras. */
export interface LogFields {
  readonly event: string;
  readonly [key: string]: unknown;
}

/** Main-process logger. */
export interface MainLogger {
  debug(fields: LogFields): void;
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

/** Days of log files kept (§18.3). */
export const LOG_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** `YYYY-MM-DD` (UTC) of `ms`. */
export function logDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Serializes one redacted JSONL line. Secret-looking values and sensitive keys are removed by `redactDeep`. */
export function formatLogLine(level: LogLevel, ts: number, fields: LogFields): string {
  return `${JSON.stringify(redactDeep({ ts, level, ...fields }))}\n`;
}

/** Deletes `*.jsonl` log files older than {@link LOG_RETENTION_DAYS}. Best effort. */
export function pruneLogs(dir: string, nowMs: number): void {
  const cutoff = logDate(nowMs - LOG_RETENTION_DAYS * DAY_MS);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = LOG_FILE_RE.exec(name);
    if (m?.[1] !== undefined && m[1] < cutoff) rmSync(join(dir, name), { force: true });
  }
}

/** The buffered file logger: a {@link MainLogger} plus explicit flushing. */
export interface FileLogger extends MainLogger {
  /** Writes every queued line (after any in-flight batch, so file order is kept). Never rejects. */
  flush(): Promise<void>;
  /**
   * Writes every queued line synchronously (quit, uncaught exception). A batch already handed to the OS by an async
   * flush cannot be recalled; it completes on its own.
   */
  flushSync(): void;
  /** True while the last write to the logs directory failed (lines went to the fallback file / stderr). */
  isDegraded(): boolean;
}

/** Tunables of {@link createFileLogger} (tests inject a fake fs). */
export interface FileLoggerOptions {
  /** Max time a non-error line waits in memory before its batch is appended. */
  readonly flushIntervalMs?: number;
  readonly fs?: {
    appendFileSync(path: string, data: string): void;
    appendFile(path: string, data: string): Promise<void>;
    mkdirSync(path: string, opts: { recursive: true }): unknown;
  };
  /** Where lines go when `dir` cannot be written. Default `<os tmp>/relay-logs`. */
  readonly fallbackDir?: string;
  /** Last resort for lines neither directory accepts. Default `process.stderr.write`. */
  readonly stderr?: (text: string) => void;
}

/** Default {@link FileLoggerOptions.fallbackDir}. */
export function defaultLogFallbackDir(): string {
  return join(tmpdir(), 'relay-logs');
}

const realStderr = (text: string): void => {
  try {
    process.stderr.write(text);
  } catch {
    // stderr closed: nothing left to try
  }
};

/** Default flush window of the buffered file logger. */
export const LOG_FLUSH_INTERVAL_MS = 100;

const realFs: NonNullable<FileLoggerOptions['fs']> = {
  appendFileSync: (p, d) => {
    appendFileSync(p, d);
  },
  appendFile: (p, d) => fsp.appendFile(p, d),
  mkdirSync: (p, o) => mkdirSync(p, o),
};

/**
 * A buffered JSONL file logger. debug/info/warn lines are queued (already formatted and redacted, so later mutation
 * of `fields` cannot change them) and appended at most every `flushIntervalMs`, one `appendFile` per day file. Error
 * lines are written synchronously together with everything queued before them — unless an async batch is in flight,
 * in which case they join the queue and are written right after it (file order always matches call order). O_APPEND
 * keeps concurrent writers line-atomic. Logging never throws.
 */
export function createFileLogger(dir: string, now: () => number = Date.now, opts: FileLoggerOptions = {}): FileLogger {
  const fs = opts.fs ?? realFs;
  const intervalMs = opts.flushIntervalMs ?? LOG_FLUSH_INTERVAL_MS;
  const fallbackDir = opts.fallbackDir ?? defaultLogFallbackDir();
  const stderr = opts.stderr ?? realStderr;
  let ensured = false;
  let fallbackEnsured = false;
  let degraded = false;
  /** Queued lines in call order: [file, line]. */
  let queue: [string, string][] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The async batch currently being appended (null when idle). */
  let inflight: Promise<void> | null = null;

  const ensureDir = (): boolean => {
    if (ensured) return true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      ensured = true;
    } catch {
      // Logging must never take the app down; lines are dropped while the dir cannot be created.
    }
    return ensured;
  };

  /** Groups lines by day file, preserving the order of files and of lines within each file. */
  const group = (batch: [string, string][]): Map<string, string> => {
    const byFile = new Map<string, string>();
    for (const [file, line] of batch) byFile.set(file, (byFile.get(file) ?? '') + line);
    return byFile;
  };

  const takeQueue = (): [string, string][] => {
    const batch = queue;
    queue = [];
    if (timer !== null) clearTimeout(timer);
    timer = null;
    return batch;
  };

  const setDegraded = (next: boolean): void => {
    if (next === degraded) return;
    degraded = next;
    stderr(
      next
        ? `relay: cannot write logs to ${dir}; writing to ${fallbackDir} and stderr\n`
        : `relay: logging to ${dir} again\n`,
    );
  };

  /** Lines logs/ refused: the OS temp fallback file, else stderr. Never throws. */
  const writeFallback = (file: string, data: string): void => {
    setDegraded(true);
    try {
      if (!fallbackEnsured) {
        fs.mkdirSync(fallbackDir, { recursive: true });
        fallbackEnsured = true;
      }
      fs.appendFileSync(join(fallbackDir, file), data);
    } catch {
      stderr(data);
    }
  };

  /**
   * Round-3 B4: logs/ removed while Relay runs (ENOENT on append) is re-created once — `ensured` is reset and the
   * append retried — instead of degrading to the fallback for the rest of the session.
   */
  const recreatedDir = (e: unknown): boolean => {
    if ((e as { code?: unknown } | null)?.code !== 'ENOENT') return false;
    ensured = false;
    return ensureDir();
  };

  const appendSyncOnce = (file: string, data: string): void => {
    try {
      fs.appendFileSync(join(dir, file), data);
    } catch (e) {
      if (!recreatedDir(e)) throw e;
      fs.appendFileSync(join(dir, file), data);
    }
  };

  const writeSync = (batch: [string, string][]): void => {
    if (batch.length === 0) return;
    const primary = ensureDir();
    for (const [file, data] of group(batch)) {
      if (!primary) {
        writeFallback(file, data);
        continue;
      }
      try {
        appendSyncOnce(file, data);
        setDegraded(false);
      } catch {
        writeFallback(file, data);
      }
    }
  };

  const flushAsync = (): Promise<void> => {
    if (inflight !== null) return inflight.then(flushAsync);
    const batch = takeQueue();
    if (batch.length === 0) return Promise.resolve();
    if (!ensureDir()) {
      for (const [file, data] of group(batch)) writeFallback(file, data);
      return Promise.resolve();
    }
    const run = async (): Promise<void> => {
      for (const [file, data] of group(batch)) {
        try {
          try {
            await fs.appendFile(join(dir, file), data);
          } catch (e) {
            if (!recreatedDir(e)) throw e;
            await fs.appendFile(join(dir, file), data);
          }
          setDegraded(false);
        } catch {
          writeFallback(file, data);
        }
      }
    };
    const p = run().finally(() => {
      inflight = null;
      // Lines (incl. errors) that arrived while this batch was in flight go out next, in order.
      if (queue.length > 0) schedule(0);
    });
    inflight = p;
    return p;
  };

  function schedule(ms: number): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flushAsync();
    }, ms);
    timer.unref();
  }

  const write = (level: LogLevel) => (fields: LogFields): void => {
    let entry: [string, string];
    try {
      const ts = now();
      entry = [`${logDate(ts)}.jsonl`, formatLogLine(level, ts, fields)];
    } catch {
      return; // never throws
    }
    queue.push(entry);
    if (level === 'error' && inflight === null) {
      writeSync(takeQueue()); // the line that explains a crash must survive it
      return;
    }
    schedule(level === 'error' ? 0 : intervalMs);
  };

  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    flush: () => flushAsync(),
    flushSync: () => {
      writeSync(takeQueue());
    },
    isDegraded: () => degraded,
  };
}

/** Logger that discards everything (before userData is known, and in tests). */
export const nullLogger: MainLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
