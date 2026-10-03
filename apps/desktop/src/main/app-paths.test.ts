import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appPaths, ensureLayout, isE2eAllowed, packagedE2eAllowedByBuild, resolveProviderMode, resolveUserDataOverride, samplesRoot } from './app-paths.js';
import { makeTempDir, removeTempDir } from './testing/temp-dirs.js';

describe('app paths', () => {
  let dir = '';
  afterEach(async () => {
    if (dir !== '') await removeTempDir(dir);
    dir = '';
  });

  it('ignores RELAY_USER_DATA_DIR when packaged without RELAY_E2E', () => {
    expect(resolveUserDataOverride(true, { RELAY_USER_DATA_DIR: '/tmp/x' }, true)).toBeNull();
    expect(resolveUserDataOverride(true, { RELAY_USER_DATA_DIR: '/tmp/x', RELAY_E2E: '1' }, true)).toBe('/tmp/x');
    expect(resolveUserDataOverride(false, { RELAY_USER_DATA_DIR: '/tmp/x' })).toBe('/tmp/x');
  });

  it('a packaged build honors RELAY_E2E only when built with MAIN_VITE_RELAY_PACKAGED_E2E=1', () => {
    const env = { RELAY_E2E: '1', RELAY_USER_DATA_DIR: '/tmp/x', RELAY_PROVIDER_MODE: 'fake' };
    expect(resolveUserDataOverride(true, env, false)).toBeNull();
    expect(resolveProviderMode(true, env, false).providerMode).toBe('live');
    expect(isE2eAllowed(true, env, false)).toBe(false);
    expect(isE2eAllowed(true, env, true)).toBe(true);
    expect(isE2eAllowed(false, env, false)).toBe(true); // unpackaged (Playwright) always
    expect(packagedE2eAllowedByBuild()).toBe(false); // the test build sets no flag
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
    dir = await makeTempDir('paths');
    const p = appPaths(join(dir, 'ud'), join(dir, 'samples'));

    await ensureLayout(p);

    for (const d of [p.artifacts, p.backups, p.logs, p.exports]) expect((await stat(d)).isDirectory()).toBe(true);
    expect((await stat(p.secrets)).mode & 0o777).toBe(0o700);
    expect(p.dbFile).toBe(join(dir, 'ud', 'relay.sqlite'));
  });
});
