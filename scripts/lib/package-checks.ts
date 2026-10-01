// Pure checks for `verify-package` (13 §M1). Readers (asar listing, file contents, fuse wire, codesign output, DB facts)
// are injected so the checks are unit-testable without a packaged build.
import { createHash } from 'node:crypto';

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const pass = (name: string, detail: string): CheckResult => ({ name, ok: true, detail });
const fail = (name: string, detail: string): CheckResult => ({ name, ok: false, detail });

/** The runner chunk electron-vite emits under out/main (08 §H9). Asar member paths start with `/`. */
export const RUNNER_CHUNK_RE = /^\/?out\/main\/[^/]*runner[^/]*\.js$/;

/** Runner bundle must embed the migrations (03 §R4-32) and keep `node:sqlite` a runtime import (08 §H9). */
export function checkRunnerBundle(members: readonly string[], read: (member: string) => string): CheckResult[] {
  const runners = members.filter((m) => RUNNER_CHUNK_RE.test(m));
  const [runner] = runners;
  if (runner === undefined) return [fail('asar runner chunk', 'no out/main/*runner*.js in app.asar')];
  const src = read(runner);
  return [
    pass('asar runner chunk', runner),
    src.includes('CREATE TABLE runs') ? pass('embedded migrations', 'CREATE TABLE runs') : fail('embedded migrations', `${runner} lacks CREATE TABLE runs`),
    /["']node:sqlite["']/.test(src) ? pass('node:sqlite runtime import', runner) : fail('node:sqlite runtime import', `${runner} has no "node:sqlite" import`),
  ];
}

/**
 * True for members that must never ship inside app.asar: env files, SQLite files, anything under a `tests/` dir, any
 * `*.test.*` / `*.spec.*` file, and any `node_modules/` (every dependency is bundled into out/**, 08 §H9).
 */
export function isForbiddenAsarMember(member: string): boolean {
  const segments = member.split('/').filter((s) => s !== '');
  const base = segments.at(-1) ?? '';
  const isEnv = base === '.env' || (base.startsWith('.env.') && base !== '.env.example');
  const isSqlite = /\.sqlite(?:-wal|-shm|-journal)?$/.test(base) || base.endsWith('.db');
  const isTest = /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) || segments.slice(0, -1).includes('tests');
  return isEnv || isSqlite || isTest || segments.includes('node_modules');
}

const MAX_LISTED = 5;

export function checkForbiddenMembers(members: readonly string[]): CheckResult {
  const bad = members.filter(isForbiddenAsarMember);
  return bad.length === 0
    ? pass('no .env/.sqlite/tests in asar', `${String(members.length)} members checked`)
    : fail('no .env/.sqlite/tests in asar', `${String(bad.length)} members, e.g. ${bad.slice(0, MAX_LISTED).join(', ')}`);
}

/** The bundled sample (§4.1) ships beside the asar, without its fixture `.env` (08 §R2-29). */
export function checkSampleResource(sampleFiles: readonly string[] | null): CheckResult[] {
  if (sampleFiles === null) return [fail('sample-api resource', 'Contents/Resources/sample-api missing')];
  const env = sampleFiles.filter((f) => f.split('/').at(-1) === '.env');
  return [
    sampleFiles.includes('package.json') ? pass('sample-api resource', `${String(sampleFiles.length)} files`) : fail('sample-api resource', 'no package.json'),
    env.length === 0 ? pass('sample-api has no .env', 'excluded') : fail('sample-api has no .env', env.join(', ')),
  ];
}

/** `@electron/fuses` wire states: the ASCII bytes '0' (disabled) and '1' (enabled). */
export const FUSE_DISABLE = 48;
export const FUSE_ENABLE = 49;

/** Indexes of `FuseV1Options` with the state electron-builder.yml configures (08 §H9). */
export const EXPECTED_FUSES: readonly { readonly index: number; readonly name: string; readonly state: number }[] = [
  { index: 0, name: 'RunAsNode', state: FUSE_DISABLE },
  { index: 1, name: 'EnableCookieEncryption', state: FUSE_ENABLE },
  { index: 2, name: 'EnableNodeOptionsEnvironmentVariable', state: FUSE_DISABLE },
  { index: 3, name: 'EnableNodeCliInspectArguments', state: FUSE_DISABLE },
  { index: 4, name: 'EnableEmbeddedAsarIntegrityValidation', state: FUSE_ENABLE },
  { index: 5, name: 'OnlyLoadAppFromAsar', state: FUSE_ENABLE },
];

const fuseStateName = (s: unknown): string => (s === FUSE_ENABLE ? 'enabled' : s === FUSE_DISABLE ? 'disabled' : `state ${String(s)}`);

export function checkFuses(wire: Readonly<Record<string, unknown>>): CheckResult[] {
  return EXPECTED_FUSES.map(({ index, name, state }) => {
    const actual = wire[String(index)];
    const detail = `${name}=${fuseStateName(actual)}`;
    return actual === state ? pass(`fuse ${name}`, detail) : fail(`fuse ${name}`, `${detail}, expected ${fuseStateName(state)}`);
  });
}

/** `codesign -dv --verbose=2` prints to stderr; an ad-hoc identity reports `Signature=adhoc` (08 §R4-34). */
export function checkAdhocSignature(exitCode: number | null, output: string): CheckResult {
  if (exitCode !== 0) return fail('ad-hoc signature', `codesign exited ${String(exitCode)}: ${output.trim().split('\n')[0] ?? ''}`);
  return /^Signature=adhoc$/m.test(output) ? pass('ad-hoc signature', 'Signature=adhoc') : fail('ad-hoc signature', 'codesign output lacks Signature=adhoc');
}

/** Facts read from the seeded relay.sqlite (the packaged app's `app.getDiagnostics` equivalents). */
export interface SeedFacts {
  readonly schemaVersion: number;
  readonly runnerLeaseHeartbeatAt: number | null;
  readonly catalogVersion: string | null;
  readonly catalogModels: number;
  /** `review-propose-fix` v1, or null when not seeded. */
  readonly template: { readonly specJson: string; readonly promptsJson: string } | null;
}

interface ModelStep {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly instructionVersion?: unknown;
}

/** sha256 of every model step's prompt text; '' when a step's prompt is missing or empty. */
export function promptShasByStep(specJson: string, promptsJson: string): Map<string, string> {
  const spec = JSON.parse(specJson) as { steps?: ModelStep[] };
  const prompts = JSON.parse(promptsJson) as Record<string, unknown>;
  const out = new Map<string, string>();
  for (const step of spec.steps ?? []) {
    if (step.kind !== 'model') continue;
    const text = typeof step.instructionVersion === 'string' ? prompts[step.instructionVersion] : undefined;
    const key = typeof step.id === 'string' ? step.id : String(step.instructionVersion);
    out.set(key, typeof text === 'string' && text.trim() !== '' ? createHash('sha256').update(text).digest('hex') : '');
  }
  return out;
}

export function checkSeedFacts(facts: SeedFacts, latestMigration: number): CheckResult[] {
  const results: CheckResult[] = [
    facts.runnerLeaseHeartbeatAt !== null ? pass('runner ready', 'runner_lease held') : fail('runner ready', 'no runner_lease row'),
    facts.schemaVersion === latestMigration
      ? pass('schema version', `v${String(facts.schemaVersion)}`)
      : fail('schema version', `v${String(facts.schemaVersion)}, expected v${String(latestMigration)}`),
    facts.catalogVersion !== null && facts.catalogModels >= 1
      ? pass('model catalog', `${facts.catalogVersion}, ${String(facts.catalogModels)} models`)
      : fail('model catalog', `version ${String(facts.catalogVersion)}, ${String(facts.catalogModels)} models`),
  ];
  if (facts.template === null) return [...results, fail('review-propose-fix v1', 'not seeded')];
  const shas = promptShasByStep(facts.template.specJson, facts.template.promptsJson);
  const missing = [...shas].filter(([, sha]) => sha === '').map(([k]) => k);
  const ok = shas.size > 0 && missing.length === 0;
  return [
    ...results,
    ok
      ? pass('review-propose-fix v1 prompts', `${String(shas.size)} model steps with prompt sha256`)
      : fail('review-propose-fix v1 prompts', shas.size === 0 ? 'no model steps' : `empty prompt for ${missing.join(', ')}`),
  ];
}

/** True when the seed facts are complete enough to assert (polling stops then). */
export function isSeedComplete(f: SeedFacts): boolean {
  return f.runnerLeaseHeartbeatAt !== null && f.catalogVersion !== null && f.template !== null;
}
