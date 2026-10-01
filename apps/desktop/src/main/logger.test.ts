import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOG_RETENTION_DAYS, createFileLogger, formatLogLine, logDate, pruneLogs } from './logger.js';
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
    logger.error({ event: 'c' });

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
