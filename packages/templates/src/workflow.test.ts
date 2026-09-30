import { DEFAULT_MAX_OUTPUT_TOKENS, OUTPUT_SCHEMAS, workflowSpecSchema } from '@relay/contracts';
import { describe, expect, it } from 'vitest';
import workflowJson from '../review-propose-fix/workflow.json' with { type: 'json' };
import { createTemplateRegistry } from './registry.js';

/** Fields 07 G6 adds to the spec §12.4 document. */
const ADDED_STEP_FIELDS = ['instructionVersion', 'maxOutputTokens'];

/** Spec §12.4, verbatim. */
const SPEC_12_4 = {
  schemaVersion: 1,
  id: 'review-propose-fix',
  version: 1,
  name: 'Review and propose a fix',
  limits: {
    budgetMicrousd: 3000000,
    maxRevisionCycles: 2,
    maxAttempts: 10,
    maxConcurrentSteps: 1,
    executionTimeoutSeconds: 900,
  },
  steps: [
    { id: 'review', kind: 'model', role: 'reviewer', profile: 'economy', outputSchema: 'findings.v1' },
    {
      id: 'plan',
      kind: 'model',
      role: 'planner',
      profile: 'balanced',
      dependsOn: ['review'],
      outputSchema: 'plan.v1',
    },
    { id: 'approve', kind: 'approval', dependsOn: ['plan'], bindTo: ['planHash', 'contextHash'] },
    {
      id: 'implement',
      kind: 'model',
      role: 'implementer',
      profile: 'capable',
      dependsOn: ['approve'],
      outputSchema: 'patch.v1',
    },
    {
      id: 'verify',
      kind: 'model',
      role: 'reviewer',
      profile: 'balanced',
      dependsOn: ['implement'],
      outputSchema: 'review.v1',
    },
  ],
  revisionPolicy: {
    triggerStep: 'verify',
    triggerOutcome: 'revise',
    repeatSteps: ['implement', 'verify'],
    approvalInvalidation: 'require_new_approval_if_plan_or_scope_changes',
    onLimit: 'incomplete',
  },
};

function modelSteps() {
  return workflowSpecSchema.parse(workflowJson).steps.flatMap((s) => (s.kind === 'model' ? [s] : []));
}

describe('review-propose-fix/workflow.json', () => {
  it('parses with the contracts workflowSpecSchema', () => {
    const result = workflowSpecSchema.safeParse(workflowJson);

    expect(result.error?.issues).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('is spec §12.4 verbatim apart from instructionVersion and maxOutputTokens', () => {
    const steps = workflowJson.steps.map((s) =>
      Object.fromEntries(Object.entries(s).filter(([k]) => !ADDED_STEP_FIELDS.includes(k))),
    );

    expect({ ...workflowJson, steps }).toEqual(SPEC_12_4);
  });

  it('every instructionVersion has a prompt module', () => {
    const registry = createTemplateRegistry();

    for (const step of modelSteps())
      expect(registry.prompt(step.instructionVersion).length).toBeGreaterThan(0);
  });

  it('every outputSchema id is registered', () => {
    for (const step of modelSteps()) expect(Object.keys(OUTPUT_SCHEMAS)).toContain(step.outputSchema);
  });

  it('maxOutputTokens defaults come from DEFAULT_MAX_OUTPUT_TOKENS for the prompt role', () => {
    for (const step of modelSteps()) {
      const role = step.instructionVersion.split('.')[0] as keyof typeof DEFAULT_MAX_OUTPUT_TOKENS;
      expect(step.maxOutputTokens, step.id).toBe(DEFAULT_MAX_OUTPUT_TOKENS[role]);
    }
  });
});
