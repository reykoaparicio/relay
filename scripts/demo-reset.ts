// 13 §M3 / §18.4: demo reset = restore the prepared demo snapshot (docs/demo/snapshot/) into a dedicated
// `Relay-Demo` userData dir. It never deletes rows (the ledger and revision tables are immutable, 03 §C3) and never
// touches any other profile or project.
//
//   RELAY_USER_DATA_DIR="$HOME/Library/Application Support/Relay-Demo" pnpm demo:reset
//   pnpm demo:reset [--dir <…/Application Support/Relay-Demo>] [--samples-dir <dir>] [--snapshot <dir>]
//
// Steps: refuse any target not named exactly `Relay-Demo` (and, unless RELAY_USER_DATA_DIR names it, any parent
// other than ~/Library/Application Support); refuse while Relay runs on that profile; move the current dir aside to
// `Relay-Demo.previous-<stamp>` (one kept; older ones deleted only through the guarded helper); copy the snapshot
// (never secrets/); restore the sample project (from tests/fixtures/sample-api, minus .env) OUTSIDE userData and rebind
// the demo project to it; carry `secrets/` and
// the matching credential refs over from the previous dir so saved keys need no re-entry.
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { toDisplayPath } from '@relay/contracts';
import type { CredentialRef } from '@relay/contracts';
import { rebindDemoProject } from './lib/demo-db.js';
import {
  DEMO_DIR_NAME,
  DemoPathRefused,
  PREVIOUS_DIR_RE,
  RESET_MARKER,
  SAMPLE_DIR_NAME,
  SAMPLE_MARKER,
  SNAPSHOT_KIND,
  SNAPSHOT_MANIFEST,
  exists,
  removePreviousDemoDir,
  resolveDemoTarget,
  runningAppPid,
  stamp,
} from './lib/demo-fs.js';
import { callOk, openFakeRuntime } from './lib/demo-runtime.js';
import { REPO_ROOT } from './lib/demo-state.js';

const SECRETS_DIR_MODE = 0o700;
/** The sample project the snapshot's demo project was prepared on (the same files the app bundles, minus .env). */
const SAMPLE_SOURCE = join(REPO_ROOT, 'tests', 'fixtures', 'sample-api');

/** Where the restored sample lives: never inside userData or ~/Library (the runner refuses those roots, 05 E1). */
async function defaultSamplesDir(parent: string, home: string): Promise<string> {
  const library = await realpath(join(home, 'Library')).catch(() => join(home, 'Library'));
  const insideLibrary = parent === library || parent.startsWith(`${library}/`);
  return insideLibrary ? join(home, 'Documents', 'Relay Demo Samples') : join(parent, `${DEMO_DIR_NAME}-samples`);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

/** Credential refs of a previous demo DB (opened through createRuntime, fake mode, engine not started). */
async function previousCredentialRefs(previousDir: string): Promise<CredentialRef[]> {
  if (!(await exists(join(previousDir, 'relay.sqlite')))) return [];
  const rt = await openFakeRuntime(previousDir);
  try {
    return await callOk(rt, 'relay/v1/providers.listCredentialRefs', {});
  } finally {
    await rt.dispose();
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { dir: { type: 'string' }, 'samples-dir': { type: 'string' }, snapshot: { type: 'string' } },
    strict: true,
  });
  const home = homedir();
  const { target, parent, source } = await resolveDemoTarget({ envDir: process.env['RELAY_USER_DATA_DIR'], argDir: values.dir, home });

  const pid = await runningAppPid(target);
  if (pid !== null) throw new DemoPathRefused(`Relay is running on ${target} (pid ${String(pid)}). Quit it, then run demo:reset again.`);

  const snapshot = resolve(values.snapshot ?? join(REPO_ROOT, 'docs', 'demo', 'snapshot'));
  const manifest = (await readJson(join(snapshot, SNAPSHOT_MANIFEST)).catch(() => null)) as { kind?: unknown; generator?: unknown; fixtureTreeHash?: unknown } | null;
  if (manifest?.kind !== SNAPSHOT_KIND) throw new Error(`${snapshot} is not a demo snapshot (run scripts/demo-snapshot.ts first)`);
  // The prepared runs (approval context hashes) are bound to the fixture's exact files.
  const fixture = (await readJson(join(SAMPLE_SOURCE, '.relay-fixture.json'))) as { treeHash?: unknown };
  if (manifest.fixtureTreeHash !== fixture.treeHash) {
    throw new Error('tests/fixtures/sample-api changed since the snapshot was made; regenerate it with scripts/demo-snapshot.ts --generate-fake');
  }
  if (await exists(join(snapshot, 'userdata', 'secrets'))) throw new Error(`${snapshot} contains secrets/; refusing to restore it`);

  const samplesDir = resolve(values['samples-dir'] ?? (await defaultSamplesDir(parent, home)));
  const sampleDir = join(samplesDir, SAMPLE_DIR_NAME);
  const sampleSt = await lstat(sampleDir).catch(() => null);
  if (sampleSt !== null && (sampleSt.isSymbolicLink() || !(await exists(join(sampleDir, SAMPLE_MARKER))))) {
    throw new DemoPathRefused(`refusing to replace ${sampleDir}: it was not created by demo:reset (no ${SAMPLE_MARKER})`);
  }

  // 1. Move the current demo dir aside (never deleted here).
  const now = new Date();
  const previousName = `${DEMO_DIR_NAME}.previous-${stamp(now)}`;
  const previous = join(parent, previousName);
  if (await exists(previous)) throw new Error(`${previous} already exists; retry in a moment`);
  const hadTarget = await exists(target);
  if (hadTarget) await rename(target, previous);
  // A dir moved aside keeps whatever it had: only a dir demo-reset restored carries RESET_MARKER, so a user's own
  // `Relay-Demo` that was moved aside is never deleted by the pruning below. A previous dir created here (to hold the
  // old sample copy when there was no demo dir) gets the marker.
  const ensurePrevious = async (): Promise<void> => {
    if (await exists(previous)) return;
    await mkdir(previous);
    await writeFile(join(previous, RESET_MARKER), `${JSON.stringify({ createdBy: 'demo-reset', at: now.toISOString(), role: 'previous' })}\n`);
  };

  // 2. Copy the snapshot's userData (never secrets/).
  await cp(join(snapshot, 'userdata'), target, { recursive: true, errorOnExist: true, force: false, filter: (p) => basename(p) !== 'secrets' });
  await writeFile(join(target, RESET_MARKER), `${JSON.stringify({ createdBy: 'demo-reset', at: now.toISOString(), snapshotGenerator: manifest.generator ?? null })}\n`);

  // 3. Restore the sample project outside userData; the old copy moves into the previous dir.
  await mkdir(samplesDir, { recursive: true });
  if (sampleSt !== null) {
    await ensurePrevious();
    await rename(sampleDir, join(previous, `previous-${SAMPLE_DIR_NAME}`));
  }
  await cp(SAMPLE_SOURCE, sampleDir, {
    recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, filter: (p) => !['.env', '.relay-fixture.json'].includes(basename(p)),
  });
  await writeFile(join(sampleDir, SAMPLE_MARKER), `${JSON.stringify({ createdBy: 'demo-reset', at: now.toISOString() })}\n`);
  const sampleReal = await realpath(sampleDir);
  rebindDemoProject(join(target, 'relay.sqlite'), sampleReal, toDisplayPath(sampleReal, home));

  // 4. Carry secrets/ (OS-protected key files) and their credential refs over from the previous dir.
  let carried = 0;
  const prevSecrets = join(previous, 'secrets');
  const prevSecretsSt = hadTarget ? await lstat(prevSecrets).catch(() => null) : null;
  if (prevSecretsSt?.isDirectory() === true && !prevSecretsSt.isSymbolicLink()) {
    if (await exists(join(target, 'secrets'))) await rmdir(join(target, 'secrets')); // empty: the copy filter skips secrets/
    await rename(prevSecrets, join(target, 'secrets'));
    await chmod(join(target, 'secrets'), SECRETS_DIR_MODE);
    const refs = await previousCredentialRefs(previous);
    const rt = await openFakeRuntime(target);
    try {
      for (const ref of refs) {
        if (ref.storageMode !== 'os_protected' || ref.vaultFile === null) continue; // session keys never persist
        if (!(await exists(join(target, ref.vaultFile)))) continue;
        await callOk(rt, 'relay/v1/providers.recordCredentialRef', {
          providerId: ref.providerId, storageMode: ref.storageMode, vaultFile: ref.vaultFile, redactedLabel: ref.redactedLabel,
        });
        carried += 1;
      }
    } finally {
      await rt.dispose();
    }
  } else {
    await mkdir(join(target, 'secrets'), { recursive: true, mode: SECRETS_DIR_MODE });
    await chmod(join(target, 'secrets'), SECRETS_DIR_MODE);
  }

  // 5. Keep one previous dir: delete older ones only through the guarded helper.
  const previousDirs = (await readdir(parent)).filter((n) => PREVIOUS_DIR_RE.test(n)).sort();
  const keep = previousDirs.at(-1);
  const pruned: string[] = [];
  for (const name of previousDirs) {
    if (name === keep) continue;
    try {
      await removePreviousDemoDir(parent, name);
      pruned.push(name);
    } catch (e) {
      process.stdout.write(`note: kept ${name} (${e instanceof Error ? e.message : String(e)})\n`);
    }
  }

  const show = (p: string): string => toDisplayPath(p, home);
  process.stdout.write(
    [
      `Demo reset done (${source === 'env' ? 'RELAY_USER_DATA_DIR' : source === 'arg' ? '--dir' : 'default path'}).`,
      `  userData:        ${show(target)}`,
      `  sample project:  ${show(sampleReal)}`,
      `  previous kept:   ${keep === undefined ? 'none' : show(join(parent, keep))}`,
      `  older removed:   ${pruned.length === 0 ? 'none' : pruned.join(', ')}`,
      `  saved keys:      ${String(carried)} credential ref(s) carried over${carried === 0 ? ' (connect providers before the live segment)' : ''}`,
      `  snapshot:        ${typeof manifest.generator === 'string' ? manifest.generator : 'unknown'} — label prepared runs accordingly (§22.2)`,
      '',
    ].join('\n'),
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    const refused = e instanceof DemoPathRefused;
    process.stderr.write(`demo-reset ${refused ? 'refused' : 'failed'}: ${e instanceof Error ? (refused ? e.message : (e.stack ?? e.message)) : String(e)}\n`);
    process.exitCode = refused ? 3 : 1;
  },
);
