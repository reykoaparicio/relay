// 04 §D5: OpenAI strict structured outputs accept only a JSON-schema subset. Templates produce it with
// `toStrictJsonSchema()` (07 §G6); this package only asserts the invariant before dispatch (a programmer error).

type Json = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkObject(node: Json, path: string, problems: string[]): void {
  const props = node['properties'];
  if (node['additionalProperties'] !== false) problems.push(`${path}: additionalProperties must be false`);
  if (!isRecord(props)) return;
  const required = Array.isArray(node['required']) ? (node['required'] as unknown[]) : [];
  for (const key of Object.keys(props)) {
    if (!required.includes(key)) problems.push(`${path}.properties.${key}: must be listed in required`);
  }
}

function walk(node: unknown, path: string, problems: string[]): void {
  if (!isRecord(node)) return;
  const type = node['type'];
  const isObject = type === 'object' || (Array.isArray(type) && type.includes('object')) || isRecord(node['properties']);
  if (isObject) checkObject(node, path, problems);
  const props = node['properties'];
  if (isRecord(props)) for (const [k, v] of Object.entries(props)) walk(v, `${path}.properties.${k}`, problems);
  walk(node['items'], `${path}.items`, problems);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = node[key];
    if (Array.isArray(list)) list.forEach((v, i) => { walk(v, `${path}.${key}[${String(i)}]`, problems); });
  }
  for (const key of ['$defs', 'definitions'] as const) {
    const defs = node[key];
    if (isRecord(defs)) for (const [k, v] of Object.entries(defs)) walk(v, `${path}.${key}.${k}`, problems);
  }
}

/** Problems that make `schema` incompatible with OpenAI strict mode (empty when compatible). */
export function strictSchemaProblems(schema: Readonly<Record<string, unknown>>): string[] {
  const problems: string[] = [];
  walk(schema, '$', problems);
  return problems;
}

/**
 * Asserts the OpenAI strict subset: every object has `additionalProperties: false` and lists every property in
 * `required` (optional fields are `null` unions instead).
 * @throws Error naming the first offending paths (a programmer error: templates must emit strict schemas).
 */
export function assertStrictCompatible(schema: Readonly<Record<string, unknown>>): void {
  const problems = strictSchemaProblems(schema);
  if (problems.length > 0) throw new Error(`output schema is not OpenAI strict-compatible: ${problems.slice(0, 3).join('; ')}`);
}
