import { z } from 'zod';

/** A JSON Schema document (plain JSON data). */
export type JsonSchema = Record<string, unknown>;

/**
 * Keywords removed because at least one supported provider's structured-output mode rejects them
 * (Anthropic structured outputs: no numeric, string-length, or max-array constraints; OpenAI strict: no length
 * constraints, no `default`). `$schema` is dropped because providers take a bare schema object.
 * `pattern` is kept: both providers accept the simple anchored patterns the output schemas use.
 */
const STRIPPED_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  'default',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'propertyNames',
]);

/** String formats every supported provider accepts in strict mode. */
const SUPPORTED_FORMATS: ReadonlySet<string> = new Set(['date-time']);

/** Anthropic structured outputs accept `minItems` of 0 or 1 only. */
const MAX_STRICT_MIN_ITEMS = 1;

/** Keywords whose value is an array of subschemas. */
const SCHEMA_ARRAY_KEYWORDS: ReadonlySet<string> = new Set(['anyOf', 'allOf', 'prefixItems']);
/** Keywords whose value is a single subschema. */
const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set(['items', 'not']);
/** Keywords whose value maps names to subschemas. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set(['$defs', 'definitions']);

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function acceptsNull(schema: JsonSchema): boolean {
  const type = schema['type'];
  if (type === 'null') return true;
  if (Array.isArray(type) && type.includes('null')) return true;
  const anyOf = schema['anyOf'];
  return Array.isArray(anyOf) && anyOf.some((s) => isRecord(s) && acceptsNull(s));
}

/** Strict mode has no optional keys: an optional property becomes required and nullable. */
function asNullable(schema: JsonSchema): JsonSchema {
  return acceptsNull(schema) ? schema : { anyOf: [schema, { type: 'null' }] };
}

function isObjectSchema(schema: JsonSchema): boolean {
  return schema['type'] === 'object' || isRecord(schema['properties']);
}

/** Rewrites one object schema: every key required, `additionalProperties: false`. */
function strictObject(schema: JsonSchema, out: JsonSchema): void {
  const extra = schema['additionalProperties'];
  if (isRecord(extra) || extra === true) {
    throw new Error('toStrictJsonSchema: records/open objects cannot be expressed in strict mode');
  }
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const required = new Set(Array.isArray(schema['required']) ? schema['required'] : []);
  const strictProperties: JsonSchema = {};
  for (const [key, value] of Object.entries(properties)) {
    const strictValue = strictNode(value);
    strictProperties[key] =
      required.has(key) || !isRecord(strictValue) ? strictValue : asNullable(strictValue);
  }
  out['properties'] = strictProperties;
  out['required'] = Object.keys(strictProperties);
  out['additionalProperties'] = false;
}

/** Copies one keyword into `out`, stripping or recursing as strict mode requires. */
function copyKeyword(schema: JsonSchema, key: string, value: unknown, out: JsonSchema): void {
  if (STRIPPED_KEYWORDS.has(key)) return;
  if (key === 'format') {
    if (typeof value === 'string' && SUPPORTED_FORMATS.has(value)) out[key] = value;
    return;
  }
  // Zod emits a regex that implements an unsupported format; it goes with the format.
  if (key === 'pattern' && typeof schema['format'] === 'string' && !SUPPORTED_FORMATS.has(schema['format']))
    return;
  if (key === 'minItems') {
    if (typeof value === 'number' && value <= MAX_STRICT_MIN_ITEMS) out[key] = value;
    return;
  }
  if (key === 'oneOf' || SCHEMA_ARRAY_KEYWORDS.has(key)) {
    // oneOf is unsupported in strict mode; anyOf is looser, and the Zod parse stays authoritative (F8).
    out[key === 'oneOf' ? 'anyOf' : key] = Array.isArray(value) ? value.map(strictNode) : value;
    return;
  }
  if (SCHEMA_KEYWORDS.has(key)) {
    out[key] = strictNode(value);
    return;
  }
  if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
    out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strictNode(v)]));
    return;
  }
  out[key] = value;
}

function strictNode(node: unknown): unknown {
  if (!isRecord(node)) return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' || key === 'required' || key === 'additionalProperties') continue;
    copyKeyword(node, key, value, out);
  }
  if (isObjectSchema(node)) strictObject(node, out);
  return out;
}

/**
 * Converts a contracts output schema to a JSON Schema that provider strict/structured-output modes accept
 * (07 G6): every object gets `additionalProperties: false` and lists all keys in `required` (optional keys become
 * nullable), `oneOf` becomes `anyOf`, and unsupported keywords are stripped. The result is looser than the Zod
 * schema; the engine's Zod parse remains the authority on validity (06 F8).
 * @throws Error if the schema contains a transform-only type or an open object/record (not expressible in strict mode).
 */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  // `io: 'input'` describes what the model must emit; branded-id transforms render as their input string.
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' });
  const strict = strictNode(json);
  if (!isRecord(strict)) throw new Error('toStrictJsonSchema: expected an object schema');
  return strict;
}
