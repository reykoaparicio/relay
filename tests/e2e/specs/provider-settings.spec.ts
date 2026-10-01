import { test, expect } from '../fixtures.js';
import { FAKE_ANTHROPIC_KEY, setupOwnProject } from '../flows.js';
import { NewRun, Runs, Settings } from '../pages/app-pages.js';
import type { StorageMode } from '../pages/app-pages.js';
import { Shell } from '../pages/shell.js';
import { scanForSecrets } from '../secret-scan.js';

// Two distinct fake keys: one per storage mode.
const KEYCHAIN_KEY = 'sk-ant-e2e-SETTINGS-KEYCHAIN-QRSTUVWX';
const SESSION_KEY = 'sk-proj-e2e-SETTINGS-SESSION-YZ123456';

test.describe('provider settings', { tag: '@m1' }, () => {
  test('connect, test, remove: keys masked in the UI and absent from userData', async ({ page, userDataDir, closeApp }, testInfo) => {
    const shell = new Shell(page);
    await shell.nav('Settings');
    const settings = new Settings(page);
    await settings.expectLoaded();
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Providers' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // Keychain (safeStorage) when this machine offers it; otherwise every key is session-only.
    const storage = await settings.preferredStorage();
    testInfo.annotations.push({ type: 'credential-storage', description: storage.text });
    await settings.section('Providers');

    const connections: { name: string; key: string; mode: StorageMode }[] = [
      { name: 'Anthropic', key: KEYCHAIN_KEY, mode: storage.mode },
      { name: 'OpenAI', key: SESSION_KEY, mode: 'session' },
    ];

    for (const c of connections) {
      const card = settings.providerCard(c.name);
      await expect(card.getByText('Not connected')).toBeVisible();
      await settings.connect(c.name, c.key, c.mode);
      await expect(card.getByText('Connected', { exact: true })).toBeVisible();
      // Masked: only the redacted label ("sk-…" + last 4) is shown.
      await expect(settings.providerKeyLabel(c.name)).toHaveText(`sk-…${c.key.slice(-4)}`);
      await expect(card.getByRole('definition').nth(1)).toHaveText(Settings.storageText(c.mode));
      await expect(card.getByLabel(`${c.name} API key`)).toHaveCount(0); // the form closes after connecting
    }
    await expect(shell.providerStatus()).toHaveText('2 providers connected');
    let html = await page.content();
    for (const c of connections) expect(html).not.toContain(c.key);
    const needles = connections.map((c) => c.key);
    // While connected: the Keychain-protected vault file exists but holds only ciphertext; the DB and -wal hold no key.
    const connected = await scanForSecrets(userDataDir, needles, { dumpDb: false });
    expect(connected.filesScanned.some((f) => /^secrets\/crd_.+\.bin$/.test(f))).toBe(storage.mode === 'keychain');
    expect(connected.hits).toEqual([]);

    // Test: a latency and cost label.
    await settings.testAndExpectPassed('Anthropic');

    // Remove both keys.
    for (const c of connections) {
      await settings.disconnect(c.name);
      await expect(settings.providerCard(c.name).getByText('Not connected')).toBeVisible();
      await expect(settings.providerCard(c.name).getByRole('button', { name: 'Remove key' })).toHaveCount(0);
    }
    await expect(shell.providerStatus()).toHaveText('No providers connected');
    html = await page.content();
    for (const c of connections) expect(html).not.toContain(c.key);

    // No plaintext key anywhere in userData after removal: while running (the -wal is live) and after quit (+ a logical
    // DB dump of every table).
    const live = await scanForSecrets(userDataDir, needles, { dumpDb: false });
    await closeApp();
    const closed = await scanForSecrets(userDataDir, needles, { dumpDb: true });
    await testInfo.attach('secret-scan', {
      body: JSON.stringify({ connected, live, closed }, null, 2),
      contentType: 'application/json',
    });
    expect(connected.filesScanned).toEqual(expect.arrayContaining(['relay.sqlite', 'relay.sqlite-wal']));
    expect(live.filesScanned).toEqual(expect.arrayContaining(['relay.sqlite']));
    expect(closed.tablesDumped.length).toBeGreaterThan(0);
    expect(live.hits).toEqual([]);
    expect(closed.hits).toEqual([]);
  });

  // 12 §L4: after a disconnect, a run that needs the provider cannot start. The preflight reports `missing_credential`
  // (06 F14) on every step whose profile uses it, with a "Connect provider" way out; reconnecting clears it.
  test('disconnect blocks starting a run that needs the provider (missing_credential → Connect provider)', async ({
    page,
    stubDialogs,
    project,
    callLog,
  }) => {
    await setupOwnProject(page, stubDialogs, project);
    const shell = new Shell(page);
    await shell.nav('Settings');
    const settings = new Settings(page);
    await settings.expectLoaded();
    await settings.section('Providers');
    await settings.disconnect('Anthropic');
    await expect(settings.providerCard('Anthropic').getByText('Not connected')).toBeVisible();

    await shell.nav('Runs');
    const runs = new Runs(page);
    await runs.expectLoaded();
    await runs.startWorkflow();
    const form = new NewRun(page);
    await form.expectLoaded();
    await form.fillGoal('Validate the user id parameter in the user handler.');
    const summary = form.problemSummary();
    await expect(summary).toBeVisible({ timeout: 15_000 });
    await expect(summary.getByText('missing_credential').first()).toBeVisible();
    await expect(summary.getByRole('link', { name: /no API key is connected for Anthropic/ }).first()).toBeVisible();
    await expect(form.startButton()).toBeDisabled();
    await expect(page.getByText('All checks passed. Ready to start.')).toHaveCount(0);

    // The fix: "Connect provider" opens Settings → Providers; reconnecting makes the same form startable.
    await summary.getByRole('link', { name: 'Connect provider' }).first().click();
    await settings.expectLoaded();
    await settings.connect('Anthropic', FAKE_ANTHROPIC_KEY, 'session');
    await expect(settings.providerCard('Anthropic').getByText('Connected', { exact: true })).toBeVisible();
    await shell.nav('Runs');
    await runs.startWorkflow();
    await form.expectLoaded();
    await form.fillGoal('Validate the user id parameter in the user handler.');
    await form.expectReady();
    await expect(form.problemSummary()).toHaveCount(0);
    // Nothing was ever sent while the key was missing.
    expect(await callLog()).toEqual([]);
  });
});
