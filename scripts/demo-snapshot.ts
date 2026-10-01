// 13 §M3: produces the committed demo snapshot (docs/demo/snapshot/) that `pnpm demo:reset` restores.
//
//   tsx --conditions=development scripts/demo-snapshot.ts --generate-fake [--out <dir>]
//   tsx --conditions=development scripts/demo-snapshot.ts --from <prepared userData dir> [--out <dir>]
//
// --generate-fake builds the four prepared states in a scratch dir with the FAKE provider (no network, no spend).
// --from takes a demo dir prepared by hand (e.g. with live providers). Either way the states are asserted through
// createRuntime before anything is written, and the output is scanned: no secrets/, no .env, no home or scratch
// paths, no secret-looking strings. Layout:
//   snapshot.json            what the snapshot holds and how it was produced
//   userdata/relay.sqlite    self-contained DB copy (demo project bound to a placeholder root)
//   userdata/artifacts/**    the runs' artifacts
// The sample project itself is NOT duplicated into the snapshot: demo-reset restores it from tests/fixtures/sample-api
// (the same files, minus .env), and snapshot.json pins the fixture's tree hash so a changed fixture is caught. A copy
// under docs/ would also be linted and type-checked as repo code.
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { redactString, SECRET_PATTERNS, toDisplayPath } from '@relay/contracts';
import {
  RESET_MARKER,
  SAMPLE_MARKER,
  SNAPSHOT_KIND,
  SNAPSHOT_MANIFEST,
  cleanupScratchDirs,
  exists,
  makeScratchDir,
  removeSnapshotDir,
} from './lib/demo-fs.js';
import { SNAPSHOT_DISPLAY_PLACEHOLDER, SNAPSHOT_ROOT_PLACEHOLDER, makeSelfContained, rebindDemoProject } from './lib/demo-db.js';
import { openFakeRuntime } from './lib/demo-runtime.js';
import { REPO_ROOT, prepareFakeDemo, printChecklist, verifyDemoState } from './lib/demo-state.js';

const FIXTURE_SAMPLE = join(REPO_ROOT, 'tests', 'fixtures', 'sample-api');
const DEFAULT_OUT = join(REPO_ROOT, 'docs', 'demo', 'snapshot');
/** Never copied into a snapshot, from any source. */
const EXCLUDED_NAMES = new Set(['.env', 'secrets', '.relay-fixture.json', SAMPLE_MARKER, RESET_MARKER, 'SingletonLock', 'SingletonSocket', 'SingletonCookie']);

// `.env*` also covers `.env.example`, which the repo .gitignore drops from docs/demo/snapshot anyway (01 §R2-4).
const copyFilter = (p: string): boolean => !EXCLUDED_NAMES.has(basename(p)) && !basename(p).startsWith('.env');
/** The sample copy matches what demo-reset restores: the fixture minus its .env and manifest. */
const sampleFilter = (p: string): boolean => !['.env', '.relay-fixture.json', SAMPLE_MARKER].includes(basename(p));

/** Files of the demo project that differ from the fixture (ignoring .env, the fixture manifest, and reset markers). */
async function sampleDrift(sampleRoot: string): Promise<string[]> {
  const rel = async (root: string): Promise<string[]> => (await walk(root)).map((f) => relative(root, f)).filter((r) => r.split('/').every((part) => sampleFilter(part))).sort();
  const want = await rel(FIXTURE_SAMPLE);
  const have = await rel(sampleRoot);
  const out: string[] = [];
  for (const f of new Set([...want, ...have])) {
    if (!want.includes(f) || !have.includes(f)) out.push(`${f}: ${want.includes(f) ? 'missing' : 'extra'}`);
    else if (!(await readFile(join(FIXTURE_SAMPLE, f))).equals(await readFile(join(sampleRoot, f)))) out.push(`${f}: content differs`);
  }
  return out;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** Problems in a staged snapshot (empty = clean). */
async function scanSnapshot(dir: string, forbiddenStrings: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const file of await walk(dir)) {
    const rel = relative(dir, file);
    const parts = rel.split('/');
    if (parts.includes('secrets')) problems.push(`${rel}: secrets/ must never be in a snapshot`);
    if (parts.includes('.env')) problems.push(`${rel}: .env must never be in a snapshot`);
    if (/\.sqlite-(wal|shm)$/.test(rel)) problems.push(`${rel}: the DB copy must be self-contained`);
    const text = (await readFile(file)).toString('latin1');
    for (const s of forbiddenStrings) if (s !== '' && text.includes(s)) problems.push(`${rel}: contains the machine path or key "${s}"`);
    for (const re of SECRET_PATTERNS) {
      const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
      for (const m of text.matchAll(new RegExp(re.source, flags))) {
        // Candidates only: some rules also check the char after the value, so confirm by redacting the match plus it.
        const candidate = text.slice(m.index, m.index + m[0].length + 1);
        if (redactString(candidate) === candidate) continue;
        if (!m[0].includes('sk-fixture-DO-NOT-READ')) problems.push(`${rel}: secret-like string ${m[0].slice(0, 12)}…`);
      }
    }
  }
  return problems;
}

type Generator = 'fake-provider' | 'hand-prepared';

/** Parsed CLI options, or the exit code of a usage error. */
function parseOptions(): { generate: boolean; from: string | undefined; out: string } | number {
  const { values } = parseArgs({
    options: { 'generate-fake': { type: 'boolean', default: false }, from: { type: 'string' }, out: { type: 'string' } },
    strict: true,
  });
  const generate = values['generate-fake'];
  if (generate === (values.from !== undefined)) {
    process.stderr.write('usage: demo-snapshot.ts (--generate-fake | --from <prepared userData dir>) [--out <dir>]\n');
    return 2;
  }
  const out = resolve(values.out ?? DEFAULT_OUT);
  if (basename(out) !== 'snapshot') {
    process.stderr.write(`refusing --out ${out}: the snapshot dir must be named "snapshot"\n`);
    return 2;
  }
  return { generate, from: values.from, out };
}

/** Step 1: the userData dir to snapshot, in `work` (generated with the fake provider, or a copy of `--from`). */
async function prepareWork(scratch: string, work: string, from: string | undefined): Promise<Generator> {
  if (from === undefined) {
    const sampleRoot = join(scratch, 'Relay-Demo-samples', 'sample-api');
    await mkdir(join(scratch, 'Relay-Demo-samples'), { recursive: true });
    await cp(FIXTURE_SAMPLE, sampleRoot, { recursive: true, filter: sampleFilter, verbatimSymlinks: true });
    const real = await realpath(sampleRoot);
    process.stdout.write('Preparing the four demo states with the fake provider (no network, no spend)…\n');
    await prepareFakeDemo(work, real, toDisplayPath(real, homedir()));
    return 'fake-provider';
  }
  const source = await realpath(resolve(from));
  if (await exists(join(source, 'SingletonLock'))) process.stdout.write('note: SingletonLock present; make sure Relay is not running on this profile\n');
  // Work on a copy (never secrets/): opening a runtime writes to its DB.
  await cp(source, work, { recursive: true, filter: copyFilter, verbatimSymlinks: true });
  return 'hand-prepared';
}

/**
 * Step 2: assert the prepared states, then stage a self-contained DB copy (demo project bound to the placeholder root)
 * and the artifacts. Returns null when a required state is missing.
 */
async function stageUserData(work: string, staging: string): Promise<{ sampleRoot: string; schemaVersion: number } | null> {
  await mkdir(join(staging, 'userdata'), { recursive: true });
  const dbCopy = join(staging, 'userdata', 'relay.sqlite');
  const rt = await openFakeRuntime(work);
  let staged: { sampleRoot: string; schemaVersion: number };
  try {
    const checks = await verifyDemoState(rt, work, { checkProjectRoot: true });
    if (!printChecklist('Prepared demo states', checks)) return null;
    const demo = rt.db.repos.projects.list({ includeArchived: false }).find((p) => p.isDemo);
    if (demo === undefined) throw new Error('no demo project');
    staged = { sampleRoot: rt.db.repos.projects.getWithRoot(demo.id).rootRealpath, schemaVersion: rt.db.schemaVersion() };
    await rt.db.backupTo(dbCopy);
  } finally {
    await rt.dispose();
  }
  rebindDemoProject(dbCopy, SNAPSHOT_ROOT_PLACEHOLDER, SNAPSHOT_DISPLAY_PLACEHOLDER);
  makeSelfContained(dbCopy);
  if (await exists(join(work, 'artifacts'))) await cp(join(work, 'artifacts'), join(staging, 'userdata', 'artifacts'), { recursive: true, filter: copyFilter });
  return staged;
}

/** Step 3: `snapshot.json` (what the snapshot holds and how it was produced). */
async function writeManifest(staging: string, generator: Generator, dbSchemaVersion: number): Promise<void> {
  const fixtureManifest = JSON.parse(await readFile(join(FIXTURE_SAMPLE, '.relay-fixture.json'), 'utf8')) as { treeHash?: unknown };
  const manifest = {
    kind: SNAPSHOT_KIND,
    schemaVersion: 1,
    dbSchemaVersion,
    generator,
    createdAt: new Date().toISOString(),
    sampleRootPlaceholder: SNAPSHOT_ROOT_PLACEHOLDER,
    sampleSource: 'tests/fixtures/sample-api',
    fixtureTreeHash: typeof fixtureManifest.treeHash === 'string' ? fixtureManifest.treeHash : null,
    states: ['sample project + 1 approved rule', 'completed run with report', 'budget-blocked run (paused, budget_run)', 'interrupted run checkpointed after Plan'],
    note: generator === 'fake-provider'
      ? 'Every prepared run was produced by the deterministic FAKE provider. Label them "Prepared (fake provider)" in the demo; never present them as live model results (§22.2).'
      : 'Prepared by hand; label these runs "Prepared" in the demo (§22.2).',
  };
  await writeFile(join(staging, SNAPSHOT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** Step 4: the built-in scan, then check-no-secrets. True when both are clean. */
async function verifyStaging(staging: string, forbidden: readonly string[]): Promise<boolean> {
  const problems = await scanSnapshot(staging, forbidden);
  if (problems.length > 0) {
    process.stderr.write(`demo-snapshot: ${String(problems.length)} finding(s); nothing was written\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
    return false;
  }
  const scanner = join(REPO_ROOT, 'scripts', 'check-no-secrets.ts');
  if (!(await exists(scanner))) {
    process.stdout.write('note: scripts/check-no-secrets.ts not present; ran the built-in scan only\n');
    return true;
  }
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--conditions=development', scanner, staging], { cwd: REPO_ROOT, encoding: 'utf8' });
  process.stdout.write(r.stdout);
  if (r.status !== 0) {
    process.stderr.write(`demo-snapshot: check-no-secrets failed (exit ${String(r.status)}); nothing was written\n${r.stderr}`);
    return false;
  }
  return true;
}

/** Step 5: replace `out` with the verified staging dir (the old snapshot is removed only through the guarded helper). */
async function publish(staging: string, out: string): Promise<void> {
  if (await exists(out)) {
    const st = await lstat(out);
    if (!st.isDirectory()) throw new Error(`${out} exists and is not a directory`);
    await removeSnapshotDir(out);
  }
  await cp(staging, out, { recursive: true });
}

async function main(): Promise<number> {
  const opts = parseOptions();
  if (typeof opts === 'number') return opts;
  const scratch = await makeScratchDir('relay-demo-snap-');
  try {
    const work = join(scratch, 'Relay-Demo');
    const staging = join(scratch, 'snapshot');
    const generator = await prepareWork(scratch, work, opts.generate ? undefined : opts.from);
    const staged = await stageUserData(work, staging);
    if (staged === null) {
      process.stderr.write('demo-snapshot: the prepared dir is missing a required state; nothing was written\n');
      return 1;
    }
    const drift = await sampleDrift(staged.sampleRoot);
    if (drift.length > 0) {
      process.stderr.write(`demo-snapshot: the demo project's files differ from tests/fixtures/sample-api; nothing was written\n${drift.map((d) => `  ${d}`).join('\n')}\n`);
      return 1;
    }
    await writeManifest(staging, generator, staged.schemaVersion);
    const home = homedir();
    if (!(await verifyStaging(staging, [home, scratch, staged.sampleRoot, work, 'demo-fake-key-not-a-secret']))) return 1;
    await publish(staging, opts.out);
    process.stdout.write(`\nSnapshot written to ${toDisplayPath(opts.out, home)} (${generator}, 0 findings)\n`);
    return 0;
  } finally {
    await cleanupScratchDirs();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`demo-snapshot failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  },
);
