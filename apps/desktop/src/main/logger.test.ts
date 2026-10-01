import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_FLUSH_INTERVAL_MS, LOG_RETENTION_DAYS, createFileLogger, formatLogLine, logDate, pruneLogs } from './logger.js';
import type { FileLoggerOptions } from './logger.js';
import { makeTempDir, removeTempDir } from './testing/temp-dirs.js';

const DAY = 24 * 60 * 60 * 1000;
const KEY = 'sk-ant-api03-SEEDEDLOGKEY0123456789abcdef';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');

let dir = '';
beforeEach(async () => {
  dir = await makeTempDir('logs');
});
afterEach(async () => {
  await removeTempDir(dir);
});

describe('formatLogLine redaction (02 §B8)', () => {
  it('redacts secret-looking values at any depth and drops sensitive keys', () => {
    const line = formatLogLine('error', NOW, {
      event: 'provider.call',
      outcome: 'error',
      err: `401 invalid x-api-key ${KEY}`,
      nested: { message: `Bearer ${KEY}`, list: [KEY] },
      apiKey: KEY,
      headers: { 'x-api-key': KEY },
      authorization: `Bearer ${KEY}`,
    });

    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2); // exactly one JSONL line
    expect(line).not.toContain('SEEDEDLOGKEY');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ts: NOW, level: 'error', event: 'provider.call', outcome: 'error' });
    expect(parsed).not.toHaveProperty('apiKey');
    expect(parsed).not.toHaveProperty('headers');
    expect(parsed).not.toHaveProperty('authorization');
    expect(String(parsed['err'])).toContain('[REDACTED:sk-…cdef]');
  });

  it('keeps ordinary fields verbatim', () => {
    const parsed = JSON.parse(formatLogLine('info', 5, { event: 'ipc.op', channel: 'relay/v1/runs.list', durationMs: 3 })) as Record<string, unknown>;

    expect(parsed).toEqual({ ts: 5, level: 'info', event: 'ipc.op', channel: 'relay/v1/runs.list', durationMs: 3 });
  });
});

describe('createFileLogger daily rotation', () => {
  it('writes to logs/<UTC date>.jsonl and rolls to a new file at UTC midnight', async () => {
    let now = Date.parse('2026-09-30T23:59:59.000Z');
    const logger = createFileLogger(join(dir, 'logs'), () => now);

    logger.info({ event: 'a' });
    now += 2_000;
    logger.warn({ event: 'b', err: KEY });
    logger.error({ event: 'c' }); // error writes synchronously, with the queued lines before it

    expect((await readdir(join(dir, 'logs'))).sort()).toEqual(['2026-09-30.jsonl', '2026-10-01.jsonl']);
    const day1 = (await readFile(join(dir, 'logs', '2026-09-30.jsonl'), 'utf8')).trim().split('\n');
    const day2 = (await readFile(join(dir, 'logs', '2026-10-01.jsonl'), 'utf8')).trim().split('\n');
    expect(day1.map((l) => (JSON.parse(l) as { event: string }).event)).toEqual(['a']);
    expect(day2.map((l) => JSON.parse(l) as { event: string; level: string })).toMatchObject([
      { event: 'b', level: 'warn' },
      { event: 'c', level: 'error' },
    ]);
    expect(day2.join('\n')).not.toContain('SEEDEDLOGKEY');
  });

  it('never throws when the log dir cannot be created', async () => {
    const blocked = join(dir, 'file-not-dir');
    await writeFile(blocked, 'x');
    const logger = createFileLogger(join(blocked, 'logs'), () => NOW);

    expect(() => {
      logger.info({ event: 'x' });
    }).not.toThrow();
  });
});

/** An in-memory fs double; `hold` makes async appends wait until `release()`. */
function memFs() {
  const files = new Map<string, string>();
  const calls: { kind: 'sync' | 'async'; file: string; data: string }[] = [];
  let holding = false;
  let held: (() => void)[] = [];
  const append = (file: string, data: string) => files.set(file, (files.get(file) ?? '') + data);
  const fs: NonNullable<FileLoggerOptions['fs']> = {
    mkdirSync: () => undefined,
    appendFileSync: (file, data) => {
      calls.push({ kind: 'sync', file, data });
      append(file, data);
    },
    appendFile: (file, data) => {
      calls.push({ kind: 'async', file, data });
      if (!holding) {
        append(file, data);
        return Promise.resolve();
      }
      return new Promise<void>((r) => held.push(() => {
        append(file, data);
        r();
      }));
    },
  };
  const events = (file: string) => (files.get(file) ?? '').trim().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { event: string }).event);
  return {
    fs, files, calls, events,
    hold: () => { holding = true; },
    release: () => { holding = false; const h = held; held = []; for (const f of h) f(); },
  };
}

describe('createFileLogger buffering (MAIN-01)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const FILE = join('/logs', `${logDate(NOW)}.jsonl`);

  it('queues debug/info/warn and appends them in one async write per flush window', async () => {
    const m = memFs();
    const logger = createFileLogger('/logs', () => NOW, { fs: m.fs });

    logger.debug({ event: 'a' });
    logger.info({ event: 'b' });
    logger.warn({ event: 'c' });
    expect(m.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(LOG_FLUSH_INTERVAL_MS);

    expect(m.calls).toEqual([expect.objectContaining({ kind: 'async', file: FILE })]);
    expect(m.events(FILE)).toEqual(['a', 'b', 'c']);
  });

  it('writes an error line synchronously, after the lines queued before it', () => {
    const m = memFs();
    const logger = createFileLogger('/logs', () => NOW, { fs: m.fs });

    logger.info({ event: 'before' });
    logger.error({ event: 'boom', err: KEY });

    expect(m.calls.map((c) => c.kind)).toEqual(['sync']);
    expect(m.events(FILE)).toEqual(['before', 'boom']);
    expect(m.files.get(FILE)).not.toContain('SEEDEDLOGKEY');
  });

  it('keeps file order when an error arrives while an async batch is in flight', async () => {
    const m = memFs();
    const logger = createFileLogger('/logs', () => NOW, { fs: m.fs });
    m.hold();
    logger.info({ event: 'one' });
    await vi.advanceTimersByTimeAsync(LOG_FLUSH_INTERVAL_MS); // batch [one] is now in flight

    logger.error({ event: 'two' });
    logger.info({ event: 'three' });
    expect(m.files.get(FILE)).toBeUndefined(); // the error did not overtake the in-flight batch
    m.release();
    await logger.flush();
    m.release();
    await logger.flush();

    expect(m.events(FILE)).toEqual(['one', 'two', 'three']);
  });

  it('groups a batch by day file (one append per file) across UTC midnight', async () => {
    const m = memFs();
    let now = Date.parse('2026-09-30T23:59:59.950Z');
    const logger = createFileLogger('/logs', () => now, { fs: m.fs });

    logger.info({ event: 'a' });
    logger.info({ event: 'b' });
    now += 100;
    logger.info({ event: 'c' });
    await logger.flush();

    expect(m.calls.map((c) => c.file)).toEqual([join('/logs', '2026-09-30.jsonl'), join('/logs', '2026-10-01.jsonl')]);
    expect(m.events(join('/logs', '2026-09-30.jsonl'))).toEqual(['a', 'b']);
    expect(m.events(join('/logs', '2026-10-01.jsonl'))).toEqual(['c']);
  });

  it('flushSync (quit / uncaught exception) writes everything queued, synchronously', () => {
    const m = memFs();
    const logger = createFileLogger('/logs', () => NOW, { fs: m.fs });
    logger.info({ event: 'x' });
    logger.warn({ event: 'y' });

    logger.flushSync();

    expect(m.calls.map((c) => c.kind)).toEqual(['sync']);
    expect(m.events(FILE)).toEqual(['x', 'y']);
  });

  it('snapshots fields at call time (later mutation does not change the line)', async () => {
    const m = memFs();
    const logger = createFileLogger('/logs', () => NOW, { fs: m.fs });
    const fields = { event: 'snap', n: 1 };

    logger.info(fields);
    fields.n = 2;
    await logger.flush();

    expect(m.files.get(FILE)).toContain('"n":1');
  });

  it('never rejects or throws when the async append fails', async () => {
    const m = memFs();
    m.fs.appendFile = () => Promise.reject(new Error('EIO'));
    const logger = createFileLogger('/logs', () => NOW, { fs: m.fs });

    logger.info({ event: 'lost' });

    await expect(logger.flush()).resolves.toBeUndefined();
  });
});

describe('pruneLogs retention', () => {
  it(`keeps the last ${String(LOG_RETENTION_DAYS)} days of *.jsonl and deletes older ones; other files are untouched`, async () => {
    const day = (n: number) => `${logDate(NOW - n * DAY)}.jsonl`;
    const names = [day(0), day(1), day(LOG_RETENTION_DAYS - 1), day(LOG_RETENTION_DAYS), day(LOG_RETENTION_DAYS + 1), day(400), 'notes.txt', `${logDate(NOW - 400 * DAY)}.jsonl.bak`];
    for (const n of names) await writeFile(join(dir, n), '{}\n');

    pruneLogs(dir, NOW);

    expect((await readdir(dir)).sort()).toEqual(
      [day(0), day(1), day(LOG_RETENTION_DAYS - 1), day(LOG_RETENTION_DAYS), 'notes.txt', `${logDate(NOW - 400 * DAY)}.jsonl.bak`].sort(),
    );
  });

  it('is a no-op for a missing directory', () => {
    expect(() => {
      pruneLogs(join(dir, 'missing'), NOW);
    }).not.toThrow();
  });
});
