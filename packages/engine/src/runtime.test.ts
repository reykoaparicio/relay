import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@relay/contracts';
import { createRuntime, createStderrLogger } from './runtime.js';
import type { Runtime } from './runtime.js';
import { memoryLogger } from './testing/harness.js';
import { createManualTimers } from './testing/manual-timers.js';

let rt: Runtime | undefined;
let dir: string | undefined;
afterEach(async () => {
  await rt?.dispose();
  rt = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const credentials = { resolve: () => Promise.resolve(ok('test-key-0000000000000000')) };

describe('createRuntime', () => {
  it('opens, migrates, and seeds a temp userData dir in fake mode; start() takes the lease; dispose() closes the DB', async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-runtime-'));
    rt = await createRuntime({ userDataDir: dir, providerMode: 'fake', credentials, logger: memoryLogger(), timers: createManualTimers() });

    await rt.engine.start();

    expect(rt.db.schemaVersion()).toBeGreaterThanOrEqual(1);
    expect(rt.db.repos.profiles.list()).toHaveLength(3);
    expect(rt.db.repos.workflows.listWorkflows()).toHaveLength(1);
    expect(rt.db.repos.lease.acquire('someone-else', 999_999, Date.now() as never, 10_000)).toBe('held_by_other');
    const diag = await rt.engine.handle('relay/v1/app.getDiagnostics', {});
    expect(diag.ok && diag.data.db.sizeBytes).toBeGreaterThan(0);
    await rt.dispose();
    expect(() => rt?.db.repos.profiles.list()).toThrow();
    rt = undefined;
  });

  it('seeds idempotently across restarts of the same userData dir', async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-runtime-'));
    const a = await createRuntime({ userDataDir: dir, providerMode: 'fake', fakeScenario: 'happy-path', credentials, logger: memoryLogger() });
    await a.dispose();

    rt = await createRuntime({ userDataDir: dir, providerMode: 'fake', credentials, logger: memoryLogger() });

    expect(rt.db.repos.profiles.list()).toHaveLength(3);
  });

  it('fails to create with an unknown fake scenario and closes the DB', async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-runtime-'));
    await expect(createRuntime({ userDataDir: dir, providerMode: 'fake', fakeScenario: 'no-such-scenario', credentials, logger: memoryLogger() })).rejects.toThrow(/unknown fake scenario/);
  });

  it('writes JSON lines on stderr by default', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logger = createStderrLogger();

    logger.info('runtime.test', { ok: true });

    expect(write).toHaveBeenCalledWith(expect.stringMatching(/"event":"runtime.test"/));
    write.mockRestore();
  });
});
