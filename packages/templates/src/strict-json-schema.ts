import { z } from 'zod';

/** A JSON Schema document (plain JSON data). */
export type JsonSchema = Record<string, unknown>;

/**
 * Constraint keywords removed because at least one supported provider's structured-output mode rejects them
 * (Anthropic structured outputs: no numeric, string-length, or max-array constraints; OpenAI strict: no length
 * constraints). They are not lost: {@link describeConstraints} restates each one in the node's `description`,
 * so the model still sees the limit, and the engine's Zod parse still enforces it (06 F8).
 */
const DESCRIBED_KEYWORDS: ReadonlySet<string> = new Set([
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
]);

/**
 * Keywords dropped without a trace: `$schema` (providers take a bare schema object) and `default` (only on
 * required keys, since optional/defaulted keys are rejected; the model must emit the value anyway).
 */
const DROPPED_KEYWORDS: ReadonlySet<string> = new Set(['$schema', 'default']);

/**
 * Keywords with no strict-mode equivalent. Converting them would silently loosen or change the schema, so the
 * converter refuses: the output schema must be rewritten in the supported subset (02 §B11).
 */
const REJECTED_KEYWORDS: ReadonlySet<string> = new Set([
  'not',
  'allOf',
  'prefixItems',
  'additionalItems',
  'contains',
  'if',
  'then',
  'else',
  'patternProperties',
  'dependentSchemas',
  'dependentRequired',
  'unevaluatedProperties',
  'unevaluatedItems',
  'minProperties',
  'maxProperties',
  'propertyNames',
]);

/** A schema node must carry at least one of these; otherwise it accepts anything (`z.unknown()`, `z.any()`). */
const CONSTRAINING_KEYWORDS: readonly string[] = ['type', 'anyOf', 'enum', '$ref'];

/** String formats every supported provider accepts in strict mode. */
const SUPPORTED_FORMATS: ReadonlySet<string> = new Set(['date-time']);

/** Anthropic structured outputs accept `minItems` of 0 or 1 only. */
const MAX_STRICT_MIN_ITEMS = 1;

/** Zod's default integer bounds; they carry no information worth describing. */
const SAFE_INTEGER_BOUND = Number.MAX_SAFE_INTEGER;

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(schema: JsonSchema, key: string): number | undefined {
  const value = schema[key];
  return typeof value === 'number' ? value : undefined;
}

function fail(message: string): never {
  throw new Error(`toStrictJsonSchema: ${message}`);
}

/** "1–12 items.", "At most 20 items.", "At least 2 items.", "Exactly 3 items." */
function rangePhrase(min: number | undefined, max: number | undefined, unit: string): string | null {
  const lo = min !== undefined && min > 0 ? min : undefined;
  if (lo !== undefined && max !== undefined)
    return lo === max ? `Exactly ${String(lo)} ${unit}.` : `${String(lo)}–${String(max)} ${unit}.`;
  if (max !== undefined) return `At most ${String(max)} ${unit}.`;
  if (lo !== undefined) return `At least ${String(lo)} ${unit}.`;
  return null;
}

/** Plain-words bounds for a number/integer node ("Positive integer (≥ 1).", "Integer ≥ 0."). */
function numericPhrases(schema: JsonSchema): string[] {
  const integer = schema['type'] === 'integer';
  const phrases: string[] = [];
  let min = num(schema, 'minimum');
  const exMin = num(schema, 'exclusiveMinimum');
  let max = num(schema, 'maximum');
  const exMax = num(schema, 'exclusiveMaximum');
  if (min === -SAFE_INTEGER_BOUND) min = undefined;
  if (max === SAFE_INTEGER_BOUND) max = undefined;

  if (integer && exMin !== undefined) min = Math.max(min ?? -Infinity, Math.floor(exMin) + 1);
  if (min !== undefined) {
    if (integer && min === 1) phrases.push('Positive integer (≥ 1).');
    else if (integer && min === 0) phrases.push('Non-negative integer (≥ 0).');
    else phrases.push(`${integer ? 'Integer' : 'Number'} ≥ ${String(min)}.`);
  } else if (exMin !== undefined) {
    phrases.push(`Greater than ${String(exMin)}.`);
  }
  if (max !== undefined) phrases.push(`At most ${String(max)}.`);
  if (exMax !== undefined) phrases.push(`Less than ${String(exMax)}.`);
  const multipleOf = num(schema, 'multipleOf');
  if (multipleOf !== undefined) phrases.push(`Multiple of ${String(multipleOf)}.`);
  return phrases;
}

/** Restates every stripped constraint of one node in plain words. */
function describeConstraints(schema: JsonSchema): string[] {
  const phrases = numericPhrases(schema);
  const items = rangePhrase(num(schema, 'minItems'), num(schema, 'maxItems'), 'items');
  if (items !== null) phrases.push(items);
  if (schema['uniqueItems'] === true) phrases.push('Items must be unique.');
  const chars = rangePhrase(num(schema, 'minLength'), num(schema, 'maxLength'), 'characters');
  if (chars !== null) phrases.push(chars);
  const format = schema['format'];
  if (typeof format === 'string' && !SUPPORTED_FORMATS.has(format)) phrases.push(`Format: ${format}.`);
  return phrases;
}

/** Rewrites one object schema: every key required, `additionalProperties: false`. */
function strictObject(schema: JsonSchema, out: JsonSchema, path: string): void {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const required = new Set(Array.isArray(schema['required']) ? schema['required'] : []);
  const strictProperties: JsonSchema = {};
  for (const [key, value] of Object.entries(properties)) {
    // Strict mode has no optional keys. Turning one into a nullable key would let the provider emit null,
    // which the Zod parse then rejects; the output schema must say `.nullable()` itself.
    if (!required.has(key)) {
      fail(
        `optional or defaulted key "${key}" at ${path} is not allowed in strict mode; use .nullable() instead`,
      );
    }
    strictProperties[key] = strictNode(value, `${path}.${key}`);
  }
  out['properties'] = strictProperties;
  out['required'] = Object.keys(strictProperties);
  out['additionalProperties'] = false;
}

/** Copies one keyword into `out`, rejecting, stripping, or recursing as strict mode requires. */
function copyKeyword(schema: JsonSchema, key: string, value: unknown, out: JsonSchema, path: string): void {
  if (REJECTED_KEYWORDS.has(key)) fail(`"${key}" has no strict-mode equivalent (at ${path})`);
  if (DROPPED_KEYWORDS.has(key)) return;
  if (key === 'minItems') {
    if (typeof value === 'number' && value <= MAX_STRICT_MIN_ITEMS) out[key] = value;
    return; // larger values are restated in the description
  }
  if (DESCRIBED_KEYWORDS.has(key)) return;
  if (key === 'format') {
    if (typeof value === 'string' && SUPPORTED_FORMATS.has(value)) out[key] = value;
    return;
  }
  // Zod emits a regex that implements an unsupported format; it goes with the format.
  if (key === 'pattern' && typeof schema['format'] === 'string' && !SUPPORTED_FORMATS.has(schema['format']))
    return;
  // A literal becomes a single-value enum: some providers (Gemini) reject `const`.
  if (key === 'const') {
    out['enum'] = [value];
    return;
  }
  if (key === 'anyOf' || key === 'oneOf') {
    if (!Array.isArray(value)) fail(`"${key}" must be an array (at ${path})`);
    // oneOf is unsupported in strict mode; anyOf is looser, and the Zod parse stays authoritative (F8).
    out['anyOf'] = value.map((v, i) => strictNode(v, `${path}.${key}[${String(i)}]`));
    return;
  }
  if (key === 'items') {
    out[key] = strictNode(value, `${path}[]`);
    return;
  }
  if (key === '$defs' || key === 'definitions') {
    if (!isRecord(value)) fail(`"${key}" must be an object (at ${path})`);
    out[key] = Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, strictNode(v, `${path}.${key}.${k}`)]),
    );
    return;
  }
  out[key] = value;
}

function strictNode(node: unknown, path: string): JsonSchema {
  // Boolean schemas: `items: false` comes from tuples, `true` accepts anything. Neither is expressible.
  if (!isRecord(node)) fail(`boolean or non-object schema at ${path} is not allowed in strict mode`);
  const extra = node['additionalProperties'];
  if (isRecord(extra) || extra === true) {
    fail(`records/open objects cannot be expressed in strict mode (at ${path})`);
  }
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' || key === 'required' || key === 'additionalProperties') continue;
    copyKeyword(node, key, value, out, path);
  }
  if (!CONSTRAINING_KEYWORDS.some((k) => k in out)) {
    fail(`schema at ${path} accepts any value (z.unknown()/z.any()); give it a concrete type`);
  }
  if (node['type'] === 'object' || isRecord(node['properties'])) strictObject(node, out, path);
  const phrases = describeConstraints(node);
  if (phrases.length > 0) {
    const existing = typeof node['description'] === 'string' ? node['description'].trim() : '';
    out['description'] = [existing, ...phrases].filter((s) => s !== '').join(' ');
  }
  return out;
}

/**
 * Converts a contracts output schema to a JSON Schema that provider strict/structured-output modes accept
 * (07 G6): the root must be an object; every object gets `additionalProperties: false` and lists all keys in
 * `required`; `oneOf` becomes `anyOf`; `const` becomes a single-value `enum`; and length/range/count constraints
 * the providers reject are stripped and restated in the node's `description` (e.g. "At most 20 items."). The
 * result is looser than the Zod schema; the engine's Zod parse remains the authority on validity (06 F8).
 * @throws Error if the root is not an object; if a key is optional or defaulted (use `.nullable()`); if the schema
 *   contains an open object/record, `not`, `allOf`, a tuple, a boolean schema, an unconstrained (`unknown`/`any`)
 *   node, or a transform-only type.
 */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  // `io: 'input'` describes what the model must emit; branded-id transforms render as their input string.
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' });
  if (json['type'] !== 'object') fail('the root schema must be { type: "object" }');
  return strictNode(json, '$');
}
