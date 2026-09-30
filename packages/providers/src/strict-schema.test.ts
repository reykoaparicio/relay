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

  it('requires the root to be type object (not a union, array, or primitive)', () => {
    const obj = { type: 'object', properties: {}, required: [], additionalProperties: false };

    expect(strictSchemaProblems({ anyOf: [obj, { type: 'null' }] })).toContain('$: root schema must have type "object"');
    expect(strictSchemaProblems({ type: 'array', items: obj })).toContain('$: root schema must have type "object"');
    expect(strictSchemaProblems({ type: 'string' })).toEqual(['$: root schema must have type "object"']);
    expect(strictSchemaProblems({ type: ['object', 'null'], properties: {}, required: [], additionalProperties: false })).toEqual([
      '$: root schema must have type "object"',
    ]);
    expect(strictSchemaProblems(obj)).toEqual([]);
  });

  it('rejects tuple-form items arrays and prefixItems, and still walks their members', () => {
    const loose = { type: 'object', properties: { x: { type: 'string' } } };
    const schema = {
      type: 'object',
      properties: {
        tuple: { type: 'array', items: [{ type: 'string' }, loose] },
        prefixed: { type: 'array', prefixItems: [loose], items: false },
      },
      required: ['tuple', 'prefixed'],
      additionalProperties: false,
    };

    expect(strictSchemaProblems(schema)).toEqual([
      '$.properties.tuple.items: tuple-form items arrays are not supported',
      '$.properties.tuple.items[1]: additionalProperties must be false',
      '$.properties.tuple.items[1].properties.x: must be listed in required',
      '$.properties.prefixed.prefixItems: tuple schemas (prefixItems) are not supported',
      '$.properties.prefixed.prefixItems[0]: additionalProperties must be false',
      '$.properties.prefixed.prefixItems[0].properties.x: must be listed in required',
    ]);
    expect(() => { assertStrictCompatible(schema); }).toThrow(/tuple-form items/);
  });
});
