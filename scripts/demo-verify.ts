// 13 §M3: verifies a reset demo profile before the pitch and prints the rehearsal checklist.
//
//   RELAY_USER_DATA_DIR="$HOME/Library/Application Support/Relay-Demo" pnpm demo:verify
//
// Read-only: it copies the demo userData (never secrets/) into a scratch dir and asserts the four prepared states
// through createRuntime's runner IPC handlers in fake mode, engine NOT started (no recovery, no dispatch, no network).
// Deviation from 13 §M3 (Playwright): see docs/demo/rehearsal-checklist.md — a Playwright launch would run recovery and
// mutate the very states it checks, and cannot attach to the packaged build (fuses), so the check reads the same IPC
// handlers headlessly instead.
import { cp, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { toDisplayPath } from '@relay/contracts';
import {
  DemoPathRefused,
  RESET_MARKER,
  cleanupScratchDirs,
  exists,
  makeScratchDir,
  resolveDemoTarget,
  runningAppPid,
} from './lib/demo-fs.js';
import { callOk, openFakeRuntime } from './lib/demo-runtime.js';
import { printChecklist, verifyDemoState } from './lib/demo-state.js';
import type { Check } from './lib/demo-state.js';

const SKIP = new Set(['secrets', 'SingletonLock', 'SingletonSocket', 'SingletonCookie']);

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { dir: { type: 'string' } }, strict: true });
  const home = homedir();
  const { target } = await resolveDemoTarget({ envDir: process.env['RELAY_USER_DATA_DIR'], argDir: values.dir, home });
  if (!(await exists(join(target, 'relay.sqlite')))) throw new Error(`${toDisplayPath(target, home)} has no relay.sqlite; run pnpm demo:reset first`);

  const extra: Check[] = [];
  const marker = await readFile(join(target, RESET_MARKER), 'utf8').then((t) => JSON.parse(t) as { at?: string; snapshotGenerator?: string | null }, () => null);
  extra.push({ label: 'Profile restored by demo:reset', ok: marker !== null, level: 'required', detail: marker === null ? `no ${RESET_MARKER}` : `at ${marker.at ?? '?'}` });
  extra.push({
    label: 'Prepared runs labeled correctly in the pitch',
    ok: true,
    level: 'info',
    detail: marker?.snapshotGenerator === 'fake-provider'
      ? 'snapshot made with the FAKE provider: say "Prepared (fake provider)", never "live"'
      : 'snapshot prepared by hand: say "Prepared"',
  });
  const pid = await runningAppPid(target);
  extra.push({ label: 'Relay not running on this profile during verification', ok: pid === null, level: 'info', detail: pid === null ? 'not running' : `pid ${String(pid)} (states may already have changed)` });

  const scratch = await makeScratchDir('relay-demo-verify-');
  try {
    const copy = join(scratch, 'Relay-Demo');
    await cp(target, copy, { recursive: true, filter: (p) => !SKIP.has(basename(p)) });
    const rt = await openFakeRuntime(copy);
    let checks: Check[];
    try {
      checks = await verifyDemoState(rt, copy, { checkProjectRoot: true });
      const refs = await callOk(rt, 'relay/v1/providers.listCredentialRefs', {});
      let present = 0;
      for (const r of refs) if (r.vaultFile !== null && (await exists(join(target, r.vaultFile)))) present += 1;
      checks.push({
        label: 'Saved provider keys carried over',
        ok: present > 0,
        level: 'info',
        detail: present > 0 ? `${String(present)} provider key file(s) present` : 'none: connect providers in Settings before the live segment',
      });
    } finally {
      await rt.dispose();
    }
    const ok = printChecklist(`Demo profile ${toDisplayPath(target, home)}`, [...extra, ...checks]);
    process.stdout.write(
      [
        '',
        'Rehearsal checklist (docs/demo/rehearsal-checklist.md):',
        '  [ ] Network and provider keys tested on the demo machine',
        '  [ ] Recording labeled "Recorded" on screen',
        '  [ ] demo:reset + demo:verify run twice in a row',
        '  [ ] Sleep and screen saver disabled, charger connected',
        '  [ ] Font size / zoom readable from the back of the room',
        '',
        ok ? 'demo:verify OK — every prepared state is present.' : 'demo:verify FAILED — run pnpm demo:reset and verify again.',
        '',
      ].join('\n'),
    );
    return ok ? 0 : 1;
  } finally {
    await cleanupScratchDirs();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    const refused = e instanceof DemoPathRefused;
    process.stderr.write(`demo-verify ${refused ? 'refused' : 'failed'}: ${e instanceof Error ? (refused ? e.message : (e.stack ?? e.message)) : String(e)}\n`);
    process.exitCode = refused ? 3 : 1;
  },
);
