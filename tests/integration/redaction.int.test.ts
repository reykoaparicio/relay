// 11 §K6 redaction (@m3, §3.3): runs with the fake key `sk-ant-test-SECRET-abcdefghij`; then EVERY file under userData
// (DB, -wal, -shm, logs, artifacts, the fake call log) is scanned for the key and its middle 10 characters. The DB check
// is a custom dump (sqlite_master → SELECT * → every column value) plus the raw bytes of relay.sqlite and
// relay.sqlite-wal while the runtime is still open (un-checkpointed pages). A provider reply that echoes the key is
// redacted in the raw_response artifact (validated outputs are not redacted by design, so the key is never in one).
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScenario } from '@relay/providers';
import { createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { listFiles } from '../helpers/invariants.js';
import { dumpAllValues } from '../helpers/sqlite-inspect.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

const KEY = 'sk-ant-test-SECRET-abcdefghij';
const MIDDLE = KEY.slice(Math.floor((KEY.length - 10) / 2), Math.floor((KEY.length - 10) / 2) + 10);

/** A review reply that echoes the key (as a leaky model/provider error might), twice → paused(output_invalid). */
const ECHO: FakeScenario = { name: 'echo-key', steps: [
  { match: { stepKey: 'review' }, times: 2, result: { kind: 'malformed', text: `I cannot comply. Your key is ${KEY} (x-api-key: ${KEY}).` } },
] };

async function scanUserData(x: Harness): Promise<string[]> {
  const hits: string[] = [];
  for (const rel of await listFiles(x.userDataDir, x.userDataDir)) {
    const bytes = await readFile(join(x.userDataDir, rel));
    const latin = bytes.toString('latin1');
    const utf16 = bytes.toString('utf16le');
    for (const needle of [KEY, MIDDLE]) if (latin.includes(needle) || utf16.includes(needle)) hits.push(`${rel}: ${needle}`);
  }
  return hits;
}

describe('redaction @m3', () => {
  it('the API key (and its middle 10 chars) never lands anywhere under userData: DB dump, -wal bytes, logs, artifacts @m3', async () => {
    h = await createHarness({ apiKey: KEY });
    const runId = await h.startRun();
    await h.waitFor(runId, 'awaiting_approval');
    await h.approve(runId);
    await h.waitFor(runId, 'completed');
    await h.waitUntil(() => h!.db.repos.artifacts.listForRun(runId, ['report']).length === 1, 10_000, 'report');
    const test = await h.call('relay/v1/providers.test', { providerId: 'anthropic' });
    expect(test.ok).toBe(true);

    // Runtime still open: the WAL holds un-checkpointed pages.
    expect(existsSync(join(h.userDataDir, 'relay.sqlite-wal'))).toBe(true);
    for (const f of ['relay.sqlite', 'relay.sqlite-wal']) {
      const bytes = (await readFile(join(h.userDataDir, f))).toString('latin1');
      expect(bytes.includes(KEY) || bytes.includes(MIDDLE), f).toBe(false);
    }
    expect(dumpAllValues(h.dbPath).filter((v) => v.value.includes(KEY) || v.value.includes(MIDDLE))).toEqual([]);
    expect(await scanUserData(h)).toEqual([]);

    const userDataDir = h.userDataDir;
    await h.dispose();
    const after = await listFiles(userDataDir, userDataDir);
    expect(after.length).toBeGreaterThan(0);
    for (const rel of after) {
      const s = (await readFile(join(userDataDir, rel))).toString('latin1');
      expect(s.includes(KEY) || s.includes(MIDDLE), rel).toBe(false);
    }
  });

  it('a provider reply echoing the key is stored redacted (raw_response, attempt error, events, logs) @m3', async () => {
    h = await createHarness({ apiKey: KEY, scenario: ECHO });
    const runId = await h.startRun();
    const paused = await h.waitFor(runId, (r) => !['queued', 'running'].includes(r.status));

    expect([paused.status, paused.pauseReason]).toEqual(['paused', 'output_invalid']);
    const raws = h.db.repos.artifacts.listForRun(runId, ['raw_response']);
    expect(raws.length).toBeGreaterThanOrEqual(1);
    for (const raw of raws) {
      const text = await readFile(join(h.userDataDir, raw.relPath), 'utf8');
      expect(text).toContain('I cannot comply.'); // the reply is kept…
      expect(text).not.toContain(KEY); // …with the key redacted
      expect(text).not.toContain(MIDDLE);
    }
    expect(dumpAllValues(h.dbPath).filter((v) => v.value.includes(KEY) || v.value.includes(MIDDLE))).toEqual([]);
    expect(await scanUserData(h)).toEqual([]);
  });
});
