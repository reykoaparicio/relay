// 08 logging: structured JSONL lines (00b §3 fields incl. `outcome`) in logs/<YYYY-MM-DD>.jsonl, redacted before
// writing (02 §B8). Daily files; 14 days kept.
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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

/** A JSONL file logger writing synchronously (lines survive a crash; O_APPEND keeps concurrent writers line-atomic). */
export function createFileLogger(dir: string, now: () => number = Date.now): MainLogger {
  let ensured = false;
  const write = (level: LogLevel) => (fields: LogFields): void => {
    const ts = now();
    try {
      if (!ensured) {
        mkdirSync(dir, { recursive: true });
        ensured = true;
      }
      appendFileSync(join(dir, `${logDate(ts)}.jsonl`), formatLogLine(level, ts, fields));
    } catch {
      // Logging must never take the app down.
    }
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

/** Logger that discards everything (before userData is known, and in tests). */
export const nullLogger: MainLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
