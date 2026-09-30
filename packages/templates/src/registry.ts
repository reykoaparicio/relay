import { invariant, OUTPUT_SCHEMAS, workflowSpecSchema } from '@relay/contracts';
import type { OutputSchemaId, WorkflowSpec } from '@relay/contracts';
// Static imports only: no runtime fs reads, so Node, tsx, Vitest, and Vite bundles load this identically (07 G6).
import workflowJson from '../review-propose-fix/workflow.json' with { type: 'json' };
import { prompt as implementerV1 } from '../review-propose-fix/prompts/implementer.v1.js';
import { prompt as plannerV1 } from '../review-propose-fix/prompts/planner.v1.js';
import { prompt as reviewerV1 } from '../review-propose-fix/prompts/reviewer.v1.js';
import { prompt as verifierV1 } from '../review-propose-fix/prompts/verifier.v1.js';
import { REPORT_LIMITATIONS } from './limitations.js';
import type { ReportLimitations } from './limitations.js';
import { toStrictJsonSchema } from './strict-json-schema.js';
import type { JsonSchema } from './strict-json-schema.js';

/** A bundled template version, as listed by {@link TemplateRegistry.list}. */
export interface TemplateSummary {
  readonly slug: string;
  readonly version: number;
  readonly name: string;
}

/** Seed data for one bundled workflow version (inserted idempotently by the engine's `seedDatabase`, 06 F16). */
export interface WorkflowSeed {
  readonly slug: string;
  readonly version: number;
  readonly spec: WorkflowSpec;
  readonly status: 'validated';
  /** instructionVersion → exact prompt text (stored as `workflow_versions.prompts_json`, 03). */
  readonly promptsJson: Readonly<Record<string, string>>;
}

/** Bundled workflow templates, their prompts, and the output schemas they use (07 G6). */
export interface TemplateRegistry {
  /** Every bundled template version. */
  list(): readonly TemplateSummary[];
  /**
   * The latest bundled spec for a template slug.
   * @throws Error if no bundled template has this slug.
   */
  get(slug: string): WorkflowSpec;
  /**
   * The bundled prompt text for an instruction version (e.g. `reviewer.v1`). Runs use the prompt snapshot stored
   * with their workflow version, not this live text (07 G1 step 1).
   * @throws Error if no bundled prompt has this version.
   */
  prompt(instructionVersion: string): string;
  /** The contracts Zod schema for an output id (the same object as `OUTPUT_SCHEMAS[id]`). */
  schema<Id extends OutputSchemaId>(id: Id): (typeof OUTPUT_SCHEMAS)[Id];
  /** The strict-mode JSON Schema for an output id (memoized, frozen). */
  jsonSchema(id: OutputSchemaId): JsonSchema;
  /** Seed rows for every bundled template version, each spec parsed by `workflowSpecSchema`. */
  seedVersions(): readonly WorkflowSeed[];
  /** Fixed limitation texts for report.v1 (placed by the engine, 06 F17). */
  reportLimitations(): ReportLimitations;
}

/** Every bundled prompt, keyed by instruction version. */
const BUNDLED_PROMPTS: Readonly<Record<string, string>> = {
  'reviewer.v1': reviewerV1,
  'planner.v1': plannerV1,
  'implementer.v1': implementerV1,
  'verifier.v1': verifierV1,
};

/** Every bundled workflow spec document (JSON, unparsed). */
const BUNDLED_WORKFLOWS: readonly unknown[] = [workflowJson];

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function lookupPrompt(instructionVersion: string): string {
  const text = BUNDLED_PROMPTS[instructionVersion];
  invariant(text !== undefined, `no bundled prompt "${instructionVersion}"`);
  return text;
}

/** Parses a bundled spec and snapshots the prompts its model steps name. */
function buildSeed(document: unknown): WorkflowSeed {
  const spec = deepFreeze(workflowSpecSchema.parse(document));
  const promptsJson: Record<string, string> = {};
  for (const step of spec.steps) {
    if (step.kind === 'model') promptsJson[step.instructionVersion] = lookupPrompt(step.instructionVersion);
  }
  return deepFreeze({ slug: spec.id, version: spec.version, spec, status: 'validated', promptsJson });
}

/**
 * Creates the registry of bundled templates. Specs are parsed once, on creation.
 * @throws ZodError if a bundled spec is invalid (a packaging bug caught by the templates tests).
 */
export function createTemplateRegistry(): TemplateRegistry {
  const seeds: readonly WorkflowSeed[] = deepFreeze(BUNDLED_WORKFLOWS.map(buildSeed));
  const jsonSchemas = new Map<OutputSchemaId, JsonSchema>();

  return {
    list: () => seeds.map((s) => ({ slug: s.slug, version: s.version, name: s.spec.name })),
    get: (slug) => {
      const latest = seeds.filter((s) => s.slug === slug).sort((a, b) => b.version - a.version)[0];
      invariant(latest !== undefined, `no bundled template "${slug}"`);
      return latest.spec;
    },
    prompt: lookupPrompt,
    schema: (id) => OUTPUT_SCHEMAS[id],
    jsonSchema: (id) => {
      const cached = jsonSchemas.get(id);
      if (cached !== undefined) return cached;
      const strict = deepFreeze(toStrictJsonSchema(OUTPUT_SCHEMAS[id]));
      jsonSchemas.set(id, strict);
      return strict;
    },
    seedVersions: () => seeds,
    reportLimitations: () => REPORT_LIMITATIONS,
  };
}
