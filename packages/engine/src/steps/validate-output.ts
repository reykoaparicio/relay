// 06 F8: output validation (§7.7) — observable checks only; model-reported confidence is never used.
// Wave 1 delivers the Zod check (the authority on validity). The semantic checks against the input snapshot
// (sourceRefs ∈ input files, plan scope, patch applies cleanly) land with F8 in Wave 2.
import { errors, toValidationIssues } from '@relay/contracts';
import type { TemplateRegistry } from '@relay/templates';
import type { ModelStepSnapshot } from '../ports.js';
import type { Validation } from '../retry.js';

/** Pure and synchronous: parses `json` with the step's contracts output schema. */
export function validateOutput(stepSnap: Pick<ModelStepSnapshot, 'outputSchema'>, json: unknown, templates: Pick<TemplateRegistry, 'schema'>): Validation {
  if (json === undefined) {
    return { ok: false, error: errors.outputInvalid([{ path: '', message: 'The response is not valid JSON.', code: 'invalid_json' }]) };
  }
  const parsed = templates.schema(stepSnap.outputSchema).safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: errors.outputInvalid(toValidationIssues(parsed.error.issues)) };
}
