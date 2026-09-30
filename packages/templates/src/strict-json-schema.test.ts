import { OUTPUT_SCHEMA_IDS, OUTPUT_SCHEMAS } from '@relay/contracts';
import type { OutputSchemaId } from '@relay/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toStrictJsonSchema } from './strict-json-schema.js';
import type { JsonSchema } from './strict-json-schema.js';

const ID_BODY = '01J9ZZZZZZZZZZZZZZZZZZZZZ0';
const SHA = 'a'.repeat(64);
const handoff = {
  summary: 'Summary.',
  sourceRefs: [{ relPath: 'src/a.ts', startLine: 1, endLine: 2 }],
  unresolvedQuestions: [],
};

/** One schema-valid value per output schema (mirrors the contracts fixtures, which are not exported). */
const FIXTURES: Record<OutputSchemaId, unknown> = {
  'findings.v1': {
    ...handoff,
    outcome: 'findings',
    findings: [
      {
        id: 'F1',
        title: 'Missing validation',
        severity: 'high',
        category: 'validation',
        description: 'Input is not validated.',
        sourceRefs: [{ relPath: 'src/a.ts', startLine: 3, endLine: null }],
      },
    ],
  },
  'plan.v1': {
    ...handoff,
    outcome: 'plan',
    goalRestatement: 'Validate input.',
    steps: [{ n: 1, action: 'Add a schema', rationale: 'F1', findingIds: ['F1'] }],
    fileScope: ['src/a.ts'],
    testSuggestions: [],
    risks: [],
    decisions: [],
  },
  'patch.v1': {
    ...handoff,
    outcome: 'patch',
    files: [{ relPath: 'src/a.ts', changeType: 'modify', unifiedDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n' }],
    testSuggestions: [{ relPath: null, description: 'Test invalid input.' }],
    notes: '',
  },
  'review.v1': {
    ...handoff,
    outcome: 'accept',
    verdictRationale: 'Meets the goal.',
    requestedChanges: [],
    checks: [{ name: 'scope', passed: true, detail: 'Only planned files changed.' }],
    memoryProposals: [],
  },
  'report.v1': {
    schemaId: 'report.v1',
    runId: `run_${ID_BODY}`,
    projectId: `prj_${ID_BODY}`,
    goal: 'Fix validation',
    status: 'completed',
    verdict: 'accept',
    workflow: { id: `wfl_${ID_BODY}`, version: 1, contentHash: SHA },
    steps: [
      {
        stepKey: 'review',
        revisionIndex: 0,
        retryIndex: 0,
        state: 'succeeded',
        profileName: 'Economy',
        providerId: 'fake',
        modelId: 'fake-model',
        cost: { settledMicrousd: 100, certainty: 'calculated', unknownMicrousd: 0 },
      },
    ],
    totals: {
      allowance: 3_000_000,
      settledReported: 100,
      settledCalculated: 200,
      settledEstimated: 0,
      reserved: 50,
      unknown: 0,
      remaining: 2_999_650,
      overrun: false,
    },
    unknownLiabilities: [
      { attemptId: `att_${ID_BODY}`, stepKey: 'plan', liabilityMicrousd: 10, state: 'abandoned' },
    ],
    artifacts: { findings: `art_${ID_BODY}`, plan: null, patch: null, review: null },
    limitations: ['Relay proposed a patch.'],
    snapshotUsed: false,
    generatedAt: 1_700_000_000_000,
  },
};

const UNSUPPORTED = [
  '$schema',
  'default',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'maxItems',
  'oneOf',
];

/** Every schema node reachable through the subschema keywords the converter emits. */
function schemaNodes(node: unknown): JsonSchema[] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return [];
  const n = node as JsonSchema;
  const children: unknown[] = [];
  const properties = n['properties'] as JsonSchema | undefined;
  if (properties !== undefined) children.push(...Object.values(properties));
  const anyOf: unknown = n['anyOf'];
  if (Array.isArray(anyOf)) children.push(...(anyOf as unknown[]));
  if (n['items'] !== undefined) children.push(n['items']);
  return [n, ...children.flatMap(schemaNodes)];
}

describe('toStrictJsonSchema', () => {
  it.each(OUTPUT_SCHEMA_IDS)('%s: every object is closed and lists every key as required', (id) => {
    const nodes = schemaNodes(toStrictJsonSchema(OUTPUT_SCHEMAS[id]));

    const objects = nodes.filter((n) => n['type'] === 'object');

    expect(objects.length).toBeGreaterThan(0);
    for (const o of objects) {
      expect(o['additionalProperties']).toBe(false);
      expect(o['required']).toEqual(Object.keys(o['properties'] as JsonSchema));
    }
  });

  it.each(OUTPUT_SCHEMA_IDS)('%s: unsupported keywords are stripped and minItems is at most 1', (id) => {
    const nodes = schemaNodes(toStrictJsonSchema(OUTPUT_SCHEMAS[id]));

    for (const n of nodes) {
      for (const key of UNSUPPORTED) expect(n, key).not.toHaveProperty(key);
      if (n['minItems'] !== undefined) expect(n['minItems']).toBeLessThanOrEqual(1);
    }
  });

  it.each(OUTPUT_SCHEMA_IDS)('%s: the strict schema still accepts the contracts fixture', (id) => {
    const strict = toStrictJsonSchema(OUTPUT_SCHEMAS[id]);

    const validator = z.fromJSONSchema(strict);

    expect(OUTPUT_SCHEMAS[id].safeParse(FIXTURES[id]).success).toBe(true);
    expect(validator.safeParse(FIXTURES[id]).success).toBe(true);
    expect(validator.safeParse({ ...(FIXTURES[id] as object), extra: 1 }).success).toBe(false);
  });

  it('turns optional keys into required nullable keys and oneOf into anyOf', () => {
    const schema = z.strictObject({
      a: z.string().optional(),
      b: z.string().nullable().optional(),
      u: z.discriminatedUnion('k', [
        z.strictObject({ k: z.literal('x') }),
        z.strictObject({ k: z.literal('y') }),
      ]),
    });

    const strict = toStrictJsonSchema(schema);
    const props = strict['properties'] as Record<string, JsonSchema>;

    expect(strict['required']).toEqual(['a', 'b', 'u']);
    expect(props['a']).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(props['b']).toEqual({ type: ['string', 'null'] }); // already nullable: left as is
    expect(props['u']).not.toHaveProperty('oneOf');
    expect(props['u']?.['anyOf']).toHaveLength(2);
  });

  it('keeps date-time formats and drops other formats with their generated pattern', () => {
    const strict = toStrictJsonSchema(
      z.strictObject({ at: z.iso.datetime(), mail: z.email(), code: z.string().regex(/^F\d$/) }),
    );
    const props = strict['properties'] as Record<string, JsonSchema>;

    expect(props['at']?.['format']).toBe('date-time');
    expect(props['mail']).toEqual({ type: 'string' });
    expect(props['code']).toEqual({ type: 'string', pattern: '^F\\d$' });
  });

  it('throws for records, which strict mode cannot express', () => {
    expect(() => toStrictJsonSchema(z.strictObject({ r: z.record(z.string(), z.number()) }))).toThrow(
      /strict mode/,
    );
  });

  it('does not mutate the Zod-generated schema between calls (pure)', () => {
    expect(toStrictJsonSchema(OUTPUT_SCHEMAS['plan.v1'])).toEqual(
      toStrictJsonSchema(OUTPUT_SCHEMAS['plan.v1']),
    );
  });
});
