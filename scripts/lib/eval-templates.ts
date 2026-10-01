// 13 §M4: the evaluation-only `single-step` template variant. The spec lives in
// tests/evaluations/templates/single-step.workflow.json (never shipped); this wraps the bundled registry so
// `createRuntime({ templates })` (06 F16) seeds and runs both the shipped template and the variant.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workflowSpecSchema } from '@relay/contracts';
import { createTemplateRegistry } from '@relay/templates';
import type { TemplateRegistry, WorkflowSeed } from '@relay/templates';

/** Slug of the shipped multi-step template (`relay` config). */
export const RELAY_SLUG = 'review-propose-fix';
/** Slug of the evaluation-only variant (`single-agent` config). */
export const SINGLE_STEP_SLUG = 'eval-single-step';

/** Loads and validates the variant spec, snapshotting the bundled prompts it names. */
export function loadSingleStepSeed(repoRoot: string, base: TemplateRegistry = createTemplateRegistry()): WorkflowSeed {
  const raw = JSON.parse(readFileSync(join(repoRoot, 'tests', 'evaluations', 'templates', 'single-step.workflow.json'), 'utf8')) as unknown;
  const spec = workflowSpecSchema.parse(raw);
  if (spec.id !== SINGLE_STEP_SLUG) throw new Error(`single-step variant must have id ${SINGLE_STEP_SLUG}`);
  const promptsJson: Record<string, string> = {};
  for (const step of spec.steps) if (step.kind === 'model') promptsJson[step.instructionVersion] = base.prompt(step.instructionVersion);
  return { slug: spec.id, version: spec.version, spec, status: 'validated', promptsJson };
}

/** The bundled registry plus the `single-step` variant. */
export function createEvalRegistry(repoRoot: string): TemplateRegistry {
  const base = createTemplateRegistry();
  const variant = loadSingleStepSeed(repoRoot, base);
  return {
    ...base,
    list: () => [...base.list(), { slug: variant.slug, version: variant.version, name: variant.spec.name }],
    get: (slug) => (slug === variant.slug ? variant.spec : base.get(slug)),
    seedVersions: () => [...base.seedVersions(), variant],
  };
}
