// 11 §K6 fixtures (@m2): every D-owned fake success fixture validates against its contracts output schema and each
// fixture patch applies cleanly to a fresh copy of tests/fixtures/sample-api; every K2 variant validates (truncated.json
// is asserted to FAIL parsing); the committed fixture tree still matches its manifest.
import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { OUTPUT_SCHEMAS } from '@relay/contracts';
import { FAKE_FIXTURES } from '@relay/providers';
import { SAMPLE_API_ROOT, checkFixtureTree } from '../helpers/fixture-hash.js';
import { FIXTURES_DIR, FIXTURE_SECRET_LINE, cleanupTempDirs, copyFixture } from '../helpers/temp-dirs.js';
import { applyUnifiedDiff } from '../helpers/unified-diff.js';

afterAll(async () => {
  await cleanupTempDirs();
});

/** Fixture name → contracts output schema id (connection-test is the `{ ok }` probe). */
const SCHEMA_OF: Readonly<Record<string, keyof typeof OUTPUT_SCHEMAS | 'connection-test'>> = {
  'findings.v1': 'findings.v1',
  'plan.v1': 'plan.v1',
  'patch.v1': 'patch.v1',
  'review.v1.accept': 'review.v1',
  'review.v1.revise': 'review.v1',
  'connection-test': 'connection-test',
};

const K2_DIR = join(FIXTURES_DIR, 'provider-responses');
const K2_SCHEMA: Readonly<Record<string, keyof typeof OUTPUT_SCHEMAS>> = {
  'plan.scope-expanded.json': 'plan.v1',
  'patch.outside-scope.json': 'patch.v1',
  'patch.does-not-apply.json': 'patch.v1',
  'findings.bad-ref.json': 'findings.v1',
};

interface PatchFile { readonly relPath: string; readonly changeType: string; readonly unifiedDiff: string }
interface SourceRef { readonly relPath: string; readonly startLine: number; readonly endLine: number }

function validate(schema: keyof typeof OUTPUT_SCHEMAS, value: unknown): string[] {
  const r = OUTPUT_SCHEMAS[schema].safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

async function applyAll(root: string, files: readonly PatchFile[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const f of files) out[f.relPath] = applyUnifiedDiff(await readFile(join(root, f.relPath), 'utf8'), f.unifiedDiff);
  return out;
}

describe('fixtures @m2', () => {
  it('every D fake success fixture is covered and validates against its contracts output schema @m2', () => {
    expect(Object.keys(FAKE_FIXTURES).sort()).toEqual(Object.keys(SCHEMA_OF).sort());
    for (const [name, schema] of Object.entries(SCHEMA_OF)) {
      const value = FAKE_FIXTURES[name];
      if (schema === 'connection-test') expect(value, name).toEqual({ ok: true });
      else expect(validate(schema, value), name).toEqual([]);
    }
  });

  it('the fake patch.v1 applies cleanly to a fresh copy of sample-api; its sourceRefs and the findings/plan refs exist @m2', async () => {
    const root = await copyFixture('sample-api');
    const patch = FAKE_FIXTURES['patch.v1'] as { files: PatchFile[] };

    const applied = await applyAll(root, patch.files);

    for (const [rel, result] of Object.entries(applied)) {
      expect(result, `${rel} applies`).not.toBeNull();
      expect(result, `${rel} changes`).not.toBe(await readFile(join(root, rel), 'utf8'));
    }
    const plan = FAKE_FIXTURES['plan.v1'] as { fileScope: string[] };
    expect(patch.files.map((f) => f.relPath).sort()).toEqual([...plan.fileScope].sort()); // patch ⊆ approved scope
    for (const name of ['findings.v1', 'plan.v1', 'patch.v1', 'review.v1.accept', 'review.v1.revise']) {
      for (const ref of (FAKE_FIXTURES[name] as { sourceRefs: SourceRef[] }).sourceRefs) {
        const lines = (await readFile(join(root, ref.relPath), 'utf8')).split('\n').length;
        expect(ref.startLine, `${name} ${ref.relPath}`).toBeGreaterThanOrEqual(1);
        expect(ref.endLine, `${name} ${ref.relPath}`).toBeLessThanOrEqual(lines);
      }
    }
  });

  it('K2 variants validate against their schemas; patch.does-not-apply does NOT apply, patch.outside-scope does (scope is the violation); truncated.json fails parsing @m2', async () => {
    const root = await copyFixture('sample-api');
    const names = readdirSync(K2_DIR).sort();
    expect(names).toEqual([...Object.keys(K2_SCHEMA), 'truncated.json'].sort());
    expect(names.some((n) => n.endsWith('.sse') || n.replace(/\.json$/, '') in FAKE_FIXTURES)).toBe(false); // no D-owned files

    for (const [file, schema] of Object.entries(K2_SCHEMA)) {
      expect(validate(schema, JSON.parse(readFileSync(join(K2_DIR, file), 'utf8'))), file).toEqual([]);
    }
    expect(() => JSON.parse(readFileSync(join(K2_DIR, 'truncated.json'), 'utf8')) as unknown).toThrow();

    const bad = JSON.parse(readFileSync(join(K2_DIR, 'patch.does-not-apply.json'), 'utf8')) as { files: PatchFile[] };
    expect(Object.values(await applyAll(root, bad.files))).toContain(null);
    const outside = JSON.parse(readFileSync(join(K2_DIR, 'patch.outside-scope.json'), 'utf8')) as { files: PatchFile[] };
    expect(Object.values(await applyAll(root, outside.files))).not.toContain(null);
    const plan = FAKE_FIXTURES['plan.v1'] as { fileScope: string[] };
    expect(outside.files.some((f) => !plan.fileScope.includes(f.relPath))).toBe(true);
    const expanded = JSON.parse(readFileSync(join(K2_DIR, 'plan.scope-expanded.json'), 'utf8')) as { fileScope: string[] };
    expect(expanded.fileScope.some((f) => !plan.fileScope.includes(f))).toBe(true);
  });

  it('copyFixture materialises the fake .env in the COPY only; the committed tree matches its manifest (never modified) @m2', async () => {
    const root = await copyFixture('sample-api');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(`${FIXTURE_SECRET_LINE}\n`);
    const check = await checkFixtureTree(SAMPLE_API_ROOT);
    expect(check).toEqual({ ok: true, treeHash: expect.any(String) as string });
  });
});
