import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  findingsFixture,
  patchFixture,
  planFixture,
  reportFixture,
  reviewFixture,
} from '../test-fixtures.js';
import { MODEL_OUTPUT_SCHEMA_IDS, OUTPUT_SCHEMA_IDS, OUTPUT_SCHEMAS } from './index.js';

const FIXTURES: Record<(typeof OUTPUT_SCHEMA_IDS)[number], () => Record<string, unknown>> = {
  'findings.v1': findingsFixture,
  'plan.v1': planFixture,
  'patch.v1': patchFixture,
  'review.v1': reviewFixture,
  'report.v1': reportFixture,
};

describe('output schemas', () => {
  it('OUTPUT_SCHEMAS has one entry per OUTPUT_SCHEMA_IDS member', () => {
    expect(Object.keys(OUTPUT_SCHEMAS)).toEqual([...OUTPUT_SCHEMA_IDS]);
    for (const id of MODEL_OUTPUT_SCHEMA_IDS) expect(OUTPUT_SCHEMA_IDS).toContain(id);
    expect(MODEL_OUTPUT_SCHEMA_IDS).not.toContain('report.v1');
  });

  it.each(OUTPUT_SCHEMA_IDS)(
    '%s accepts a minimal valid fixture and rejects a missing required key',
    (id) => {
      const schema = OUTPUT_SCHEMAS[id];
      const fixture = FIXTURES[id]();

      expect(schema.safeParse(fixture).success).toBe(true);
      for (const key of Object.keys(fixture)) {
        const rest = Object.fromEntries(Object.entries(fixture).filter(([k]) => k !== key));
        expect(schema.safeParse(rest).success, `missing ${key}`).toBe(false);
      }
    },
  );

  it('patch.v1 rejects changeType add (P0 patches only modify or delete provided files)', () => {
    const file = { relPath: 'src/a.ts', changeType: 'add', unifiedDiff: '--- a\n+++ b\n' };
    const shape = OUTPUT_SCHEMAS['patch.v1'];
    const parsed = shape.safeParse({ ...patchFixture(), files: [file] });

    expect(parsed.success).toBe(false);
  });

  it('review.v1 with outcome revise and no requested changes is an issue', () => {
    const r = OUTPUT_SCHEMAS['review.v1'].safeParse({ ...reviewFixture(), outcome: 'revise' });
    const ok = OUTPUT_SCHEMAS['review.v1'].safeParse({
      ...reviewFixture(),
      outcome: 'revise',
      requestedChanges: [{ relPath: 'src/a.ts', description: 'Handle null.' }],
    });

    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(['requestedChanges']);
    expect(ok.success).toBe(true);
  });

  it('findings.v1 rejects a finding with 0 sourceRefs and more than 20 findings', () => {
    const base = findingsFixture();
    const finding = (base['findings'] as Record<string, unknown>[])[0] ?? {};

    const noRefs = { ...base, findings: [{ ...finding, sourceRefs: [] }] };
    const tooMany = {
      ...base,
      findings: Array.from({ length: 21 }, (_, i) => ({ ...finding, id: `F${String(i)}` })),
    };
    const exactly20 = {
      ...base,
      findings: Array.from({ length: 20 }, (_, i) => ({ ...finding, id: `F${String(i)}` })),
    };

    expect(OUTPUT_SCHEMAS['findings.v1'].safeParse(noRefs).success).toBe(false);
    expect(OUTPUT_SCHEMAS['findings.v1'].safeParse(tooMany).success).toBe(false);
    expect(OUTPUT_SCHEMAS['findings.v1'].safeParse(exactly20).success).toBe(true);
  });

  it('plan.v1 enforces steps 1–12 and fileScope 1–20', () => {
    const base = planFixture();
    const step = (base['steps'] as unknown[])[0];
    const schema = OUTPUT_SCHEMAS['plan.v1'];

    expect(schema.safeParse({ ...base, steps: [] }).success).toBe(false);
    expect(schema.safeParse({ ...base, steps: Array(13).fill(step) }).success).toBe(false);
    expect(schema.safeParse({ ...base, steps: Array(12).fill(step) }).success).toBe(true);
    expect(schema.safeParse({ ...base, fileScope: [] }).success).toBe(false);
    expect(schema.safeParse({ ...base, fileScope: Array(21).fill('a.ts') }).success).toBe(false);
    expect(schema.safeParse({ ...base, fileScope: Array(20).fill('a.ts') }).success).toBe(true);
  });

  it('z.toJSONSchema succeeds for every model output schema (no transforms)', () => {
    for (const id of MODEL_OUTPUT_SCHEMA_IDS) {
      const json = z.toJSONSchema(OUTPUT_SCHEMAS[id]) as { type?: string; required?: string[] };

      expect(json.type).toBe('object');
      expect(json.required?.length).toBeGreaterThan(0);
    }
  });

  it('model output schemas mark every property required (nullable instead of optional)', () => {
    const walk = (node: unknown): void => {
      if (typeof node !== 'object' || node === null) return;
      const n = node as { properties?: Record<string, unknown>; required?: string[] };
      if (n.properties !== undefined) {
        expect([...(n.required ?? [])].sort()).toEqual(Object.keys(n.properties).sort());
      }
      for (const v of Object.values(node)) walk(v);
    };

    for (const id of MODEL_OUTPUT_SCHEMA_IDS) walk(z.toJSONSchema(OUTPUT_SCHEMAS[id]));
  });

  it('report.v1 parses a terminal-run fixture and rejects status running', () => {
    const schema = OUTPUT_SCHEMAS['report.v1'];

    for (const status of ['completed', 'incomplete', 'cancelled', 'failed']) {
      expect(schema.safeParse({ ...reportFixture(), status }).success).toBe(true);
    }
    expect(schema.safeParse({ ...reportFixture(), status: 'running' }).success).toBe(false);
  });
});
