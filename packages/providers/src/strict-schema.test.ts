import { describe, expect, it } from 'vitest';
import { CONNECTION_TEST_SCHEMA } from './connection-test.js';
import { assertStrictCompatible, strictSchemaProblems } from './strict-schema.js';

describe('assertStrictCompatible', () => {
  it('accepts a strict schema with nested objects, arrays, anyOf and $defs', () => {
    const item = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false };
    const schema = {
      type: 'object',
      properties: {
        items: { type: 'array', items: item },
        maybe: { anyOf: [item, { type: 'null' }] },
        ref: { $ref: '#/$defs/Item' },
      },
      required: ['items', 'maybe', 'ref'],
      additionalProperties: false,
      $defs: { Item: item },
    };

    expect(() => { assertStrictCompatible(schema); }).not.toThrow();
    expect(() => { assertStrictCompatible(CONNECTION_TEST_SCHEMA.jsonSchema); }).not.toThrow();
  });

  it('reports a missing additionalProperties:false and a property missing from required, at any depth', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'object', properties: { b: { type: 'string' } }, required: [], additionalProperties: false },
        list: { type: 'array', items: { type: ['object', 'null'], properties: {}, additionalProperties: true } },
        u: { oneOf: [{ type: 'object', properties: {} }] },
      },
      required: ['a', 'list', 'u'],
      additionalProperties: false,
      definitions: { D: { type: 'object', additionalProperties: {} } },
    };

    expect(strictSchemaProblems(schema)).toEqual([
      '$.properties.a.properties.b: must be listed in required',
      '$.properties.list.items: additionalProperties must be false',
      '$.properties.u.oneOf[0]: additionalProperties must be false',
      '$.definitions.D: additionalProperties must be false',
    ]);
    expect(() => { assertStrictCompatible(schema); }).toThrow(/not OpenAI strict-compatible/);
  });
});
