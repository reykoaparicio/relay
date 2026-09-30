import { createReadStream, readdirSync } from 'fs';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { OUTPUT_SCHEMA_IDS, OUTPUT_SCHEMAS, workflowSpecSchema } from '@relay/contracts';
import { describe, expect, it } from 'vitest';
import { REPORT_LIMITATIONS } from './limitations.js';
import { createTemplateRegistry } from './registry.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPORT_LIMITATION_KEYS = [
  'patch_not_applied',
  'tests_not_run',
  'model_checks_only',
  'cost_tracked',
  'cost_estimated',
  'run_incomplete',
  'run_cancelled',
  'run_failed',
];

function modelSteps() {
  return createTemplateRegistry()
    .get('review-propose-fix')
    .steps.flatMap((s) => (s.kind === 'model' ? [s] : []));
}

/** Source files shipped by the package (tests excluded: they may read the tree to check it). */
function packageSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return ['node_modules', 'dist'].includes(entry.name) ? [] : packageSourceFiles(path);
    return /\.(ts|json)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('createTemplateRegistry', () => {
  it('get("review-propose-fix") returns the 5-step spec @m1', () => {
    const registry = createTemplateRegistry();

    const spec = registry.get('review-propose-fix');

    expect(spec.steps.map((s) => s.id)).toEqual(['review', 'plan', 'approve', 'implement', 'verify']);
    expect(registry.list()).toEqual([
      { slug: 'review-propose-fix', version: 1, name: 'Review and propose a fix' },
    ]);
  });

  it('throws for an unknown slug or instruction version', () => {
    const registry = createTemplateRegistry();

    expect(() => registry.get('nope')).toThrow(/no bundled template/);
    expect(() => registry.prompt('reviewer.v9')).toThrow(/no bundled prompt/);
  });

  it('prompt(v) resolves every instructionVersion, and each prompt ends with the output instruction', () => {
    const registry = createTemplateRegistry();

    const prompts = modelSteps().map((s) => registry.prompt(s.instructionVersion));

    expect(prompts).toHaveLength(4);
    for (const p of prompts) {
      expect(p.endsWith('Respond only with JSON matching the schema.')).toBe(true);
      expect(p).toContain('<untrusted_*>');
      expect(p).not.toMatch(/\b(IMPORTANT|MUST|NEVER|CRITICAL)\b/);
    }
  });

  it('each prompt names every top-level field of its output schema', () => {
    const registry = createTemplateRegistry();

    for (const step of modelSteps()) {
      const fields = Object.keys(registry.jsonSchema(step.outputSchema)['properties'] as object);
      const p = registry.prompt(step.instructionVersion);
      for (const field of fields) expect(p, `${step.instructionVersion} → ${field}`).toContain(field);
    }
  });

  it('schema(id) is the same object as the contracts export', () => {
    const registry = createTemplateRegistry();

    for (const id of OUTPUT_SCHEMA_IDS) expect(registry.schema(id)).toBe(OUTPUT_SCHEMAS[id]);
  });

  it('jsonSchema(id) is memoized and frozen', () => {
    const registry = createTemplateRegistry();

    const first = registry.jsonSchema('plan.v1');

    expect(registry.jsonSchema('plan.v1')).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first['additionalProperties']).toBe(false);
  });

  it('seedVersions() returns a validated version whose spec parses and whose prompts cover every model step', () => {
    const registry = createTemplateRegistry();

    const seeds = registry.seedVersions();

    expect(seeds).toHaveLength(1);
    const seed = seeds[0]!;
    expect(seed).toMatchObject({ slug: 'review-propose-fix', version: 1, status: 'validated' });
    expect(workflowSpecSchema.safeParse(seed.spec).success).toBe(true);
    expect(Object.keys(seed.promptsJson).sort()).toEqual(
      modelSteps()
        .map((s) => s.instructionVersion)
        .sort(),
    );
    for (const [version, body] of Object.entries(seed.promptsJson))
      expect(body).toBe(registry.prompt(version));
  });

  it('reportLimitations() has every key in the 07 G6 table', () => {
    const limitations = createTemplateRegistry().reportLimitations();

    expect(Object.keys(limitations).sort()).toEqual([...REPORT_LIMITATION_KEYS].sort());
    expect(limitations).toBe(REPORT_LIMITATIONS);
    for (const body of Object.values(limitations)) expect(body.length).toBeLessThanOrEqual(600); // report.v1 limit
  });

  it('the package imports no filesystem module and no raw-text imports (static bundling only)', async () => {
    const files = packageSourceFiles(PACKAGE_ROOT);
    const forbidden = [
      /from\s+['"](node:)?fs(\/promises)?['"]/,
      /(import|require)\s*\(\s*['"](node:)?fs(\/promises)?['"]/,
      /[?]raw['"]/,
      /\bread[F]ile/,
    ];

    const offenders: string[] = [];
    for (const file of files) {
      const source = await text(createReadStream(file));
      if (forbidden.some((re) => re.test(source))) offenders.push(file);
    }

    expect(files.some((f) => f.endsWith('registry.ts'))).toBe(true);
    expect(offenders).toEqual([]);
  });
});
