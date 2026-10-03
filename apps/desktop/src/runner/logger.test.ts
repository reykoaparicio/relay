import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line boundaries/dependencies -- test-only: the shared ownership-guarded temp-dir helper
import { makeTempDir, removeTempDir } from '../main/testing/temp-dirs.js';
import { createRunnerLogger } from './logger.js';

const KEY = 'sk-ant-api03-SEEDEDRUNNERKEY0123456789abcd';

let dir = '';
beforeEach(async () => {
  dir = await makeTempDir('runner-logs');
});
afterEach(async () => {
  await removeTempDir(dir);
});

describe('createRunnerLogger', () => {
  it('writes redacted JSONL lines tagged proc: runner into the UTC-day file, rolling at midnight', async () => {
    let now = Date.parse('2026-09-30T23:59:59.500Z');
    const logs = join(dir, 'logs');
    const logger = createRunnerLogger(logs, () => now);

    logger.info('provider.call', { outcome: 'error', err: `invalid key ${KEY}`, apiKey: KEY, headers: { authorization: KEY } });
    now += 1_000;
    logger.debug('engine.tick');

    expect((await readdir(logs)).sort()).toEqual(['2026-09-30.jsonl', '2026-10-01.jsonl']);
    const first = await readFile(join(logs, '2026-09-30.jsonl'), 'utf8');
    expect(first).not.toContain('SEEDEDRUNNERKEY');
    const line = JSON.parse(first) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'info', event: 'provider.call', proc: 'runner', outcome: 'error' });
    expect(line).not.toHaveProperty('apiKey');
    expect(line).not.toHaveProperty('headers');
    expect(String(line['err'])).toContain('[REDACTED:');
    expect(JSON.parse(await readFile(join(logs, '2026-10-01.jsonl'), 'utf8'))).toMatchObject({ level: 'debug', event: 'engine.tick', proc: 'runner' });
  });

  it('falls back to stderr when logs/ cannot be written (never throws)', async () => {
    const { writeFile } = await import('node:fs/promises');
    const blocked = join(dir, 'file-not-dir');
    await writeFile(blocked, 'x');
    const out: string[] = [];
    const logger = createRunnerLogger(join(blocked, 'logs'), () => 0, (t) => out.push(t));

    logger.error('runner.fatal', { code: 'DATABASE_UNAVAILABLE', apiKey: KEY });

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('runner.fatal');
    expect(out[0]).not.toContain('SEEDEDRUNNERKEY');
  });
});
