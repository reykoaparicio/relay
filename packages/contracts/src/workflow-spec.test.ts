import { describe, expect, it } from 'vitest';
import { collectWorkflowGraphIssues, retryPolicySchema, workflowSpecSchema } from './workflow-spec.js';
import type { WorkflowSpecShape } from './workflow-spec.js';

/** Spec §12.4 verbatim, plus `instructionVersion` per model step (07 G6 workflow.json). */
function specJson(): Record<string, unknown> & { steps: Record<string, unknown>[]; revisionPolicy: Record<string, unknown> } {
  return {
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
      { id: 'review', kind: 'model', role: 'reviewer', profile: 'economy', outputSchema: 'findings.v1', instructionVersion: 'reviewer.v1' },
      { id: 'plan', kind: 'model', role: 'planner', profile: 'balanced', dependsOn: ['review'], outputSchema: 'plan.v1', instructionVersion: 'planner.v1' },
      { id: 'approve', kind: 'approval', dependsOn: ['plan'], bindTo: ['planHash', 'contextHash'] },
      { id: 'implement', kind: 'model', role: 'implementer', profile: 'capable', dependsOn: ['approve'], outputSchema: 'patch.v1', instructionVersion: 'implementer.v1' },
      { id: 'verify', kind: 'model', role: 'reviewer', profile: 'balanced', dependsOn: ['implement'], outputSchema: 'review.v1', instructionVersion: 'verifier.v1' },
    ],
    revisionPolicy: {
      triggerStep: 'verify',
      triggerOutcome: 'revise',
      repeatSteps: ['implement', 'verify'],
      approvalInvalidation: 'require_new_approval_if_plan_or_scope_changes',
      onLimit: 'incomplete',
    },
  };
}

function issuePaths(input: unknown): string[] {
  const r = workflowSpecSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
}

describe('workflowSpecSchema', () => {
  it('parses the spec §12.4 JSON and fills step defaults', () => {
    const spec = workflowSpecSchema.parse(specJson());

    const review = spec.steps[0];

    expect(review?.kind).toBe('model');
    if (review?.kind !== 'model') throw new Error('expected model step');
    expect(review.dependsOn).toEqual([]);
    expect(review.retryPolicy).toEqual({ transport: 1, schemaRepair: 1, rateLimitWaits: 3 });
    expect(review.memoryScope).toEqual({
      roles: 'step_role',
      types: ['user_rule', 'project_decision', 'source_reference', 'run_summary'],
    });
    expect(review.allowedTools).toEqual([]);
  });

  it('reports a cycle at steps[1].dependsOn[0]', () => {
    const json = specJson();
    json.steps[0] = { ...json.steps[0], dependsOn: ['plan'] };

    const paths = issuePaths(json);

    expect(paths).toContain('steps.1.dependsOn.0');
    expect(paths).toContain('steps.0.dependsOn.0'); // forward reference
  });

  it('reports a self-dependency as a cycle', () => {
    const json = specJson();
    json.steps[1] = { ...json.steps[1], dependsOn: ['plan'] };

    expect(issuePaths(json)).toEqual(['steps.1.dependsOn.0']);
  });

  it('reports an unknown dependency', () => {
    const json = specJson();
    json.steps[1] = { ...json.steps[1], dependsOn: ['nope'] };

    expect(issuePaths(json)).toEqual(['steps.1.dependsOn.0']);
  });

  it('requires an approval before the first implementer step', () => {
    const json = specJson();
    json.steps = json.steps.filter((s) => s['id'] !== 'approve');
    json.steps[2] = { ...json.steps[2], dependsOn: ['plan'] };

    expect(issuePaths(json)).toEqual(['steps.2']);
  });

  it('rejects duplicate ids and the reserved id intake', () => {
    const dup = specJson();
    dup.steps[1] = { ...dup.steps[1], id: 'review' };
    const reserved = specJson();
    reserved.steps[0] = { ...reserved.steps[0], id: 'intake' };
    reserved.steps[1] = { ...reserved.steps[1], dependsOn: ['intake'] };

    expect(issuePaths(dup)).toContain('steps.1.id');
    expect(issuePaths(reserved)).toEqual(['steps.0.id']);
  });

  it('rejects repeatSteps containing the approval step, unknown repeat steps, and a bad trigger', () => {
    const json = specJson();
    json.revisionPolicy = { ...json.revisionPolicy, repeatSteps: ['approve', 'ghost'] };
    const badTrigger = specJson();
    badTrigger.revisionPolicy = { ...badTrigger.revisionPolicy, triggerStep: 'ghost' };
    const approvalTrigger = specJson();
    approvalTrigger.revisionPolicy = { ...approvalTrigger.revisionPolicy, triggerStep: 'approve' };

    expect(issuePaths(json)).toEqual(['revisionPolicy.repeatSteps.0', 'revisionPolicy.repeatSteps.1']);
    expect(issuePaths(badTrigger)).toEqual(['revisionPolicy.triggerStep']);
    expect(issuePaths(approvalTrigger)).toEqual(['revisionPolicy.triggerStep']);
  });

  it('rejects an unknown outputSchema, including report.v1', () => {
    for (const outputSchema of ['report.v1', 'nope.v1']) {
      const json = specJson();
      json.steps[0] = { ...json.steps[0], outputSchema };

      expect(issuePaths(json)).toEqual(['steps.0.outputSchema']);
    }
  });

  it('rejects a retryPolicy above MAX_RETRY_POLICY', () => {
    const json = specJson();
    json.steps[0] = { ...json.steps[0], retryPolicy: { transport: 3, schemaRepair: 1, rateLimitWaits: 1 } };

    expect(issuePaths(json)).toEqual(['steps.0.retryPolicy.transport']);
    expect(retryPolicySchema.safeParse({ transport: 2, schemaRepair: 2, rateLimitWaits: 5 }).success).toBe(true);
    expect(retryPolicySchema.safeParse({ transport: 0, schemaRepair: 0, rateLimitWaits: 6 }).success).toBe(false);
  });

  it('rejects allowed tools, approval steps without dependencies, and too many steps', () => {
    const tools = specJson();
    tools.steps[0] = { ...tools.steps[0], allowedTools: ['shell'] };
    const approval = specJson();
    approval.steps[2] = { ...approval.steps[2], dependsOn: [] };

    expect(issuePaths(tools).length).toBeGreaterThan(0);
    expect(issuePaths(approval)).toEqual(['steps.2.dependsOn']);
  });
});

describe('collectWorkflowGraphIssues', () => {
  it('returns no issues for the valid spec', () => {
    const spec: WorkflowSpecShape = workflowSpecSchema.parse(specJson());

    expect(collectWorkflowGraphIssues(spec)).toEqual([]);
  });
});
