import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appPaths, ensureLayout, resolveProviderMode, resolveUserDataOverride, samplesRoot } from './app-paths.js';

describe('app paths', () => {
  let dir = '';
  afterEach(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  it('ignores RELAY_USER_DATA_DIR when packaged without RELAY_E2E', () => {
    expect(resolveUserDataOverride(true, { RELAY_USER_DATA_DIR: '/tmp/x' })).toBeNull();
    expect(resolveUserDataOverride(true, { RELAY_USER_DATA_DIR: '/tmp/x', RELAY_E2E: '1' })).toBe('/tmp/x');
    expect(resolveUserDataOverride(false, { RELAY_USER_DATA_DIR: '/tmp/x' })).toBe('/tmp/x');
  });

  it('honors fake mode only under the same condition and forwards the scenario', () => {
    expect(resolveProviderMode(true, { RELAY_PROVIDER_MODE: 'fake' })).toEqual({ providerMode: 'live', fakeScenario: null });
    expect(resolveProviderMode(false, { RELAY_PROVIDER_MODE: 'fake', RELAY_FAKE_SCENARIO: 'happy' })).toEqual({ providerMode: 'fake', fakeScenario: 'happy' });
  });

  it('places samples outside userData', () => {
    expect(samplesRoot('/t/ud', '/docs', true)).toBe('/t/ud-samples');
    expect(samplesRoot('/t/ud', '/docs', false)).toBe('/docs/Relay Samples');
  });

  it('ensureLayout creates the layout with a 0700 secrets dir', async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-paths-'));
    const p = appPaths(join(dir, 'ud'), join(dir, 'samples'));

    await ensureLayout(p);

    for (const d of [p.artifacts, p.backups, p.logs, p.exports]) expect((await stat(d)).isDirectory()).toBe(true);
    expect((await stat(p.secrets)).mode & 0o777).toBe(0o700);
    expect(p.dbFile).toBe(join(dir, 'ud', 'relay.sqlite'));
  });
});
