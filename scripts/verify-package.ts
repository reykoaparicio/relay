// `tsx --conditions=development scripts/verify-package.ts [Relay.app]` (13 §M1, RLY-025): verifies the ad-hoc signed,
// not notarized dir build from `pnpm package` (08 §H9) and smoke-launches it against a temp home (HOME + CFFIXED_USER_HOME,
// so macOS resolves Application Support inside it; the shipped build ignores RELAY_E2E overrides). Playwright
// cannot attach to the packaged build (nodeCliInspect fuse off), so the smoke facts are read from the seeded DB.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import * as asar from '@electron/asar';
import { getCurrentFuseWire } from '@electron/fuses';
import { MIGRATIONS } from '@relay/storage';
import {
  checkAdhocSignature,
  checkForbiddenMembers,
  checkFuses,
  checkRunnerBundle,
  checkSampleResource,
  checkSeedFacts,
  isSeedComplete,
  type CheckResult,
  type SeedFacts,
} from './lib/package-checks.js';
import { makeTempDir, removeDir } from './lib/package-temp-dir.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_APP = path.join(REPO_ROOT, 'apps/desktop/dist/mac-arm64/Relay.app');
const DB_WAIT_MS = 15_000; // 13 §M1: relay.sqlite within 15 s
const SEED_WAIT_MS = 15_000;
const QUIT_WAIT_MS = 10_000;
const POLL_MS = 250;

async function exists(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null)) !== null;
}

async function listRelative(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listRelative(root, r)));
    else out.push(r);
  }
  return out;
}

async function staticChecks(app: string): Promise<CheckResult[]> {
  const resources = path.join(app, 'Contents/Resources');
  const archive = path.join(resources, 'app.asar');
  if (!(await exists(archive))) return [{ name: 'app.asar', ok: false, detail: `${archive} missing` }];
  const members = asar.listPackage(archive, { isPack: false }).map((m) => m.split(path.sep).join('/'));
  const sampleDir = path.join(resources, 'sample-api');
  const codesign = spawnSync('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' });
  return [
    { name: 'app.asar', ok: true, detail: `${String(members.length)} entries` },
    ...checkRunnerBundle(members, (m) => asar.extractFile(archive, m.replace(/^\//, '')).toString('utf8')),
    checkForbiddenMembers(members),
    ...checkSampleResource((await exists(sampleDir)) ? await listRelative(sampleDir) : null),
    ...checkFuses(await getCurrentFuseWire(app)),
    checkAdhocSignature(codesign.status, `${codesign.stdout}${codesign.stderr}`),
  ];
}

function readInt(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { v?: unknown } | undefined;
  return typeof row?.v === 'number' ? row.v : 0;
}

/** Read-only snapshot of the facts `app.getDiagnostics` reports. Throws while the DB is still being created. */
function readSeedFacts(dbFile: string): SeedFacts {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const lease = db.prepare('SELECT heartbeat_at AS v FROM runner_lease WHERE id = 1').get() as { v?: unknown } | undefined;
    const catalog = db.prepare('SELECT MAX(catalog_version) AS v FROM model_catalog').get() as { v?: unknown } | undefined;
    const catalogVersion = typeof catalog?.v === 'string' ? catalog.v : null;
    const tpl = db
      .prepare(
        `SELECT wv.spec_json AS spec, wv.prompts_json AS prompts FROM workflow_versions wv
         JOIN workflows w ON w.id = wv.workflow_id WHERE w.slug = 'review-propose-fix' AND wv.version = 1`,
      )
      .get() as { spec?: unknown; prompts?: unknown } | undefined;
    return {
      schemaVersion: readInt(db, 'SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations'),
      runnerLeaseHeartbeatAt: typeof lease?.v === 'number' ? lease.v : null,
      catalogVersion,
      catalogModels:
        catalogVersion === null ? 0 : (db.prepare('SELECT COUNT(*) AS v FROM model_catalog WHERE catalog_version = ?').get(catalogVersion) as { v: number }).v,
      template: typeof tpl?.spec === 'string' && typeof tpl.prompts === 'string' ? { specJson: tpl.spec, promptsJson: tpl.prompts } : null,
    };
  } finally {
    db.close();
  }
}

async function waitFor<T>(deadlineMs: number, probe: () => Promise<T | null>): Promise<T | null> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const v = await probe().catch(() => null);
    if (v !== null || Date.now() >= end) return v;
    await delay(POLL_MS);
  }
}

/** Kills the app's whole process group (it was spawned detached, so helpers share its pgid). Safe to call twice. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function quit(child: ChildProcess): Promise<string> {
  if (child.exitCode !== null || child.signalCode !== null) return `already exited (${String(child.exitCode ?? child.signalCode)})`;
  const exited = new Promise<string>((resolve) => child.once('exit', (code, sig) => { resolve(`exited (${String(code ?? sig)})`); }));
  killGroup(child, 'SIGTERM');
  const result = await Promise.race([exited, delay(QUIT_WAIT_MS).then(() => null)]);
  if (result !== null) return result;
  killGroup(child, 'SIGKILL');
  return `killed after ${String(QUIT_WAIT_MS)} ms (${await exited})`;
}

/**
 * The user's real Relay profile, under both names it has had (the product name, and the package name used before
 * `productName` was set). The smoke launch must never create or touch either.
 */
const REAL_PROFILES = ['Relay', '@relay/desktop'].map((n) => path.join(userInfo().homedir, 'Library', 'Application Support', n));
const REAL_USER_DATA = REAL_PROFILES[0] ?? '';
async function anyRealProfile(): Promise<string | null> {
  for (const p of REAL_PROFILES) if (await exists(p)) return p;
  return null;
}

async function smokeLaunch(app: string): Promise<CheckResult[]> {
  // Fail closed: with a real profile present, a broken isolation could open it, so do not launch at all.
  const existing = await anyRealProfile();
  if (existing !== null) {
    return [{ name: 'smoke launch', ok: false, detail: `refused: a real Relay profile exists at ${existing}; run on a machine or user without one` }];
  }
  const parent = await makeTempDir('verify-');
  const home = path.join(parent, 'home');
  // macOS resolves Application Support from CFFIXED_USER_HOME (HOME alone is ignored); Electron's userData is
  // <Application Support>/<productName>.
  const userData = path.join(home, 'Library', 'Application Support', 'Relay');
  await mkdir(home);
  // Minimal env: nothing from the caller's shell (provider keys) reaches the app. No RELAY_* overrides: the shipped
  // build ignores them, and the smoke facts need no provider calls.
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: parent };
  const child = spawn(path.join(app, 'Contents/MacOS/Relay'), [], { env, detached: true, stdio: 'ignore' });
  const leaked = async (): Promise<boolean> => (await anyRealProfile()) !== null;
  const onExit = (): void => { killGroup(child, 'SIGKILL'); };
  process.once('exit', onExit);
  const onSignal = (): void => { killGroup(child, 'SIGKILL'); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const dbFile = path.join(userData, 'relay.sqlite');
    // Watch the real profile while waiting: if isolation fails, stop the app at once.
    const appeared = await waitFor(DB_WAIT_MS, async () => ((await leaked()) ? 'leaked' : (await exists(dbFile)) ? 'ok' : null));
    if (appeared === 'leaked') {
      killGroup(child, 'SIGKILL');
      return [{ name: 'smoke launch', ok: false, detail: `isolation failed: the app created ${REAL_USER_DATA} (left in place for you to inspect)` }];
    }
    if (appeared === null) return [{ name: 'smoke launch', ok: false, detail: `relay.sqlite not created within ${String(DB_WAIT_MS)} ms in the temp home` }];
    const facts = await waitFor(SEED_WAIT_MS, () => {
      const f = readSeedFacts(dbFile);
      return Promise.resolve(isSeedComplete(f) ? f : null);
    });
    // Incomplete after the wait: assert what is there, so the failing facts are named.
    let final = facts;
    try {
      final ??= readSeedFacts(dbFile);
    } catch {
      final = null;
    }
    if (final === null) return [{ name: 'smoke launch', ok: false, detail: 'relay.sqlite unreadable' }];
    const latest = Math.max(...MIGRATIONS.map((m) => m.version));
    const isolation: CheckResult = (await leaked())
      ? { name: 'profile isolation', ok: false, detail: `the app created ${REAL_USER_DATA}` }
      : { name: 'profile isolation', ok: true, detail: 'userData inside the temp home; real profile untouched' };
    return [{ name: 'smoke launch', ok: true, detail: 'relay.sqlite created' }, isolation, ...checkSeedFacts(final, latest)];
  } finally {
    const how = await quit(child);
    console.log(`  app quit: ${how}`);
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await removeDir(parent);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const app = path.resolve(argv[0] ?? DEFAULT_APP);
  if (!(await exists(app))) {
    console.error(`verify-package: ${app} not found (run \`pnpm package\` first)`);
    return 1;
  }
  console.log(`verifying ${app}`);
  const results = await staticChecks(app);
  results.push(...(await smokeLaunch(app)));
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}: ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? 'package OK' : `package FAILED (${String(failed)} checks)`);
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
