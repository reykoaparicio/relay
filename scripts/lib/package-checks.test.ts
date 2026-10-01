import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTemplateRegistry } from '@relay/templates';
import {
  checkAdhocSignature,
  checkForbiddenMembers,
  checkFuses,
  checkRunnerBundle,
  checkSampleResource,
  checkSeedFacts,
  FUSE_DISABLE,
  FUSE_ENABLE,
  isForbiddenAsarMember,
  promptShasByStep,
  type SeedFacts,
} from './package-checks.js';

const RUNNER_SRC = 'import{DatabaseSync}from"node:sqlite";const sql=`CREATE TABLE runs (id TEXT)`;';

describe('checkRunnerBundle', () => {
  it('passes for a runner chunk with embedded migrations and a node:sqlite import', () => {
    const members = ['/out', '/out/main', '/out/main/index.js', '/out/main/runner-D4ZsjTgV.js'];

    const r = checkRunnerBundle(members, () => RUNNER_SRC);

    expect(r.map((c) => c.ok)).toEqual([true, true, true]);
  });

  it('fails when the runner chunk is missing or lacks the SQL / import', () => {
    expect(checkRunnerBundle(['/out/main/index.js'], () => RUNNER_SRC)[0]?.ok).toBe(false);
    const r = checkRunnerBundle(['/out/main/runner-x.js'], () => 'const x = require("better-sqlite3");');
    expect(r.filter((c) => !c.ok).map((c) => c.name)).toEqual(['embedded migrations', 'node:sqlite runtime import']);
  });
});

describe('forbidden asar members', () => {
  it('rejects .env, sqlite files and anything under tests/', () => {
    expect(isForbiddenAsarMember('/out/.env')).toBe(true);
    expect(isForbiddenAsarMember('/.env.local')).toBe(true);
    expect(isForbiddenAsarMember('/relay.sqlite')).toBe(true);
    expect(isForbiddenAsarMember('/data/relay.sqlite-wal')).toBe(true);
    expect(isForbiddenAsarMember('/tests/fixtures/x.ts')).toBe(true);
    expect(isForbiddenAsarMember('/node_modules/@relay/contracts/dist/redaction.test.js')).toBe(true);
    expect(isForbiddenAsarMember('/node_modules/zod/index.js')).toBe(true);
    expect(isForbiddenAsarMember('/out/main/a.spec.mjs')).toBe(true);
    expect(isForbiddenAsarMember('/out/main/latest.js')).toBe(false);
    expect(isForbiddenAsarMember('/tests')).toBe(false); // the bare dir entry carries no content
    expect(isForbiddenAsarMember('/out/main/index.js')).toBe(false);
    expect(isForbiddenAsarMember('/.env.example')).toBe(false);
  });

  it('lists the offending members', () => {
    expect(checkForbiddenMembers(['/package.json', '/tests/a.ts']).detail).toBe('1 members, e.g. /tests/a.ts');
    expect(checkForbiddenMembers(['/package.json']).ok).toBe(true);
  });
});

describe('checkSampleResource', () => {
  it('requires the sample with package.json and without .env', () => {
    expect(checkSampleResource(null)[0]?.ok).toBe(false);
    expect(checkSampleResource(['package.json', 'src/server.ts']).every((c) => c.ok)).toBe(true);
    expect(checkSampleResource(['package.json', '.env'])[1]?.ok).toBe(false);
  });
});

describe('checkFuses', () => {
  const good = { version: '1', 0: FUSE_DISABLE, 1: FUSE_ENABLE, 2: FUSE_DISABLE, 3: FUSE_DISABLE, 4: FUSE_ENABLE, 5: FUSE_ENABLE, 6: FUSE_DISABLE };

  it('passes for the electron-builder.yml fuse configuration', () => {
    expect(checkFuses(good).every((c) => c.ok)).toBe(true);
  });

  it('fails RunAsNode enabled and OnlyLoadAppFromAsar disabled', () => {
    const r = checkFuses({ ...good, 0: FUSE_ENABLE, 5: FUSE_DISABLE });

    expect(r.filter((c) => !c.ok).map((c) => c.detail)).toEqual([
      'RunAsNode=enabled, expected disabled',
      'OnlyLoadAppFromAsar=disabled, expected enabled',
    ]);
  });
});

describe('checkAdhocSignature', () => {
  it('requires Signature=adhoc and a zero exit code', () => {
    const out = 'Executable=/x/Relay.app/Contents/MacOS/Relay\nIdentifier=dev.relay.prototype\nSignature=adhoc\nTeamIdentifier=not set\n';

    expect(checkAdhocSignature(0, out).ok).toBe(true);
    expect(checkAdhocSignature(1, 'Relay.app: code object is not signed at all').ok).toBe(false);
    expect(checkAdhocSignature(0, 'Authority=Developer ID Application: X\n').ok).toBe(false);
  });
});

describe('seed facts', () => {
  // The real bundled workflow (a valid contracts workflowSpec), with test prompt texts.
  const bundled = createTemplateRegistry().get('review-propose-fix');
  const spec = JSON.stringify(bundled);
  const modelSteps = bundled.steps.flatMap((s) => (s.kind === 'model' ? [s] : []));
  const prompts = JSON.stringify(Object.fromEntries(modelSteps.map((s) => [s.instructionVersion, `You are ${s.id}.`])));
  const facts: SeedFacts = {
    schemaVersion: 1,
    runnerLeaseHeartbeatAt: 1,
    catalogVersion: '2026-09-25',
    catalogModels: 5,
    template: { specJson: spec, promptsJson: prompts },
  };

  it('hashes the prompt of every model step', () => {
    const shas = promptShasByStep(spec, prompts);

    expect([...shas.keys()]).toEqual(modelSteps.map((s) => s.id));
    expect(shas.get('plan')).toBe(createHash('sha256').update('You are plan.').digest('hex'));
  });

  it('treats a spec that is not a valid workflow spec, or non-JSON prompts, as having no hashed prompts', () => {
    expect(promptShasByStep(JSON.stringify({ steps: [{ id: 'x', kind: 'model', instructionVersion: 'reviewer.v1' }] }), prompts).size).toBe(0);
    expect(promptShasByStep('{not json', prompts).size).toBe(0);
    expect([...promptShasByStep(spec, '[1,2]').values()].every((sha) => sha === '')).toBe(true);
  });

  it('passes a fully seeded database', () => {
    expect(checkSeedFacts(facts, 1).every((c) => c.ok)).toBe(true);
  });

  it('names each missing fact', () => {
    const bad: SeedFacts = {
      schemaVersion: 0,
      runnerLeaseHeartbeatAt: null,
      catalogVersion: null,
      catalogModels: 0,
      template: { specJson: spec, promptsJson: JSON.stringify({ 'reviewer.v1': ' ' }) },
    };

    const failed = checkSeedFacts(bad, 1).filter((c) => !c.ok);

    expect(failed.map((c) => c.name)).toEqual(['runner ready', 'schema version', 'model catalog', 'review-propose-fix v1 prompts']);
    expect(failed.at(-1)?.detail).toBe(`empty prompt for ${modelSteps.map((s) => s.id).join(', ')}`);
    expect(checkSeedFacts({ ...facts, template: null }, 1).at(-1)?.ok).toBe(false);
  });
});
