// Shared fixtures for the colocated unit tests of this package. Not exported from the public index.
import { ID_PREFIX } from './ids.js';
import type { IdPrefixKey } from './ids.js';

const BODY = '01J9ZZZZZZZZZZZZZZZZZZZZZ';

/** A well-formed id string for prefix key `p` (the optional digit varies the last char). */
export function fakeId(p: IdPrefixKey, n = 0): string {
  return `${ID_PREFIX[p]}_${BODY}${String(n % 10)}`;
}

/** A well-formed lowercase sha256 made of one repeated hex char. */
export function fakeSha(ch = 'a'): string {
  return ch.repeat(64);
}

/** A schema-valid cost summary (input shape). */
export function costSummaryFixture(): Record<string, unknown> {
  return {
    allowance: 3_000_000,
    settledReported: 100,
    settledCalculated: 200,
    settledEstimated: 0,
    reserved: 50,
    unknown: 0,
    remaining: 2_999_650,
    overrun: false,
  };
}

/** A minimal handoff base (every model output extends it). */
export function handoffFixture(): Record<string, unknown> {
  return {
    summary: 'Summary.',
    sourceRefs: [{ relPath: 'src/a.ts', startLine: 1, endLine: 2 }],
    unresolvedQuestions: [],
  };
}

/** A schema-valid findings.v1 value. */
export function findingsFixture(): Record<string, unknown> {
  return {
    ...handoffFixture(),
    outcome: 'findings',
    findings: [
      {
        id: 'F1',
        title: 'Missing validation',
        severity: 'high',
        category: 'validation',
        description: 'Input is not validated.',
        sourceRefs: [{ relPath: 'src/a.ts', startLine: 3, endLine: null }],
      },
    ],
  };
}

/** A schema-valid plan.v1 value. */
export function planFixture(): Record<string, unknown> {
  return {
    ...handoffFixture(),
    outcome: 'plan',
    goalRestatement: 'Validate input.',
    steps: [{ n: 1, action: 'Add zod schema', rationale: 'F1', findingIds: ['F1'] }],
    fileScope: ['src/a.ts'],
    testSuggestions: [],
    risks: [],
    decisions: [],
  };
}

/** A schema-valid patch.v1 value. */
export function patchFixture(): Record<string, unknown> {
  return {
    ...handoffFixture(),
    outcome: 'patch',
    files: [{ relPath: 'src/a.ts', changeType: 'modify', unifiedDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n' }],
    testSuggestions: [{ relPath: null, description: 'Test invalid input.' }],
    notes: '',
  };
}

/** A schema-valid review.v1 value. */
export function reviewFixture(): Record<string, unknown> {
  return {
    ...handoffFixture(),
    outcome: 'accept',
    verdictRationale: 'Meets the goal.',
    requestedChanges: [],
    checks: [{ name: 'scope', passed: true, detail: 'Only planned files changed.' }],
    memoryProposals: [],
  };
}

/** A schema-valid report.v1 value for a completed run. */
export function reportFixture(): Record<string, unknown> {
  return {
    schemaId: 'report.v1',
    runId: fakeId('run'),
    projectId: fakeId('project'),
    goal: 'Fix validation',
    status: 'completed',
    verdict: 'accept',
    workflow: { id: fakeId('workflow'), version: 1, contentHash: fakeSha() },
    steps: [
      {
        stepKey: 'review',
        revisionIndex: 0,
        retryIndex: 0,
        state: 'succeeded',
        profileName: 'Economy',
        providerId: 'fake',
        modelId: 'fake-model',
        cost: { settledMicrousd: 100, certainty: 'calculated', unknownMicrousd: 0 },
      },
    ],
    totals: costSummaryFixture(),
    unknownLiabilities: [
      { attemptId: fakeId('attempt'), stepKey: 'plan', liabilityMicrousd: 10, state: 'abandoned' },
    ],
    artifacts: { findings: fakeId('artifact', 1), plan: null, patch: null, review: null },
    limitations: ['Relay proposed a patch. It was not applied to your project.'],
    snapshotUsed: false,
    generatedAt: 1_700_000_000_000,
  };
}

/** A G4-shaped context manifest. */
export function manifestFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: fakeId('run'),
    stepKey: 'review',
    revisionIndex: 0,
    attemptPurpose: 'initial',
    profile: { name: 'Economy', providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
    priceCatalogVersion: '2026-09-25',
    instructions: { version: 'reviewer.v1', sha256: fakeSha('b') },
    files: [
      {
        relPath: 'src/a.ts',
        sha256: fakeSha('c'),
        sizeBytes: 120,
        tokens: 40,
        included: true,
        reason: 'selected',
      },
    ],
    memory: [
      {
        recordId: fakeId('memory'),
        revision: 1,
        type: 'user_rule',
        included: true,
        pinned: true,
        stale: false,
        score: 1,
      },
    ],
    upstream: [
      { stepKey: 'review', artifactId: fakeId('artifact'), schemaId: 'findings.v1', sha256: fakeSha('d') },
    ],
    omitted: [{ kind: 'file', ref: 'src/big.ts', reason: 'token_budget' }],
    tokens: { estimatedInput: 1000, budget: 200_000, basis: 'local_estimate' },
    contextHash: fakeSha('e'),
    providersReceivingContext: ['anthropic'],
  };
}

/** A schema-valid step view. */
export function stepViewFixture(): Record<string, unknown> {
  return {
    id: fakeId('stepRun'),
    stepKey: 'review',
    revisionIndex: 0,
    retryIndex: 0,
    state: 'succeeded',
    profileName: 'Economy',
    providerId: 'fake',
    modelId: 'fake-model',
    outcome: 'findings',
    outputArtifactId: fakeId('artifact'),
    error: null,
  };
}

/** A schema-valid run event. */
export function runEventFixture(type = 'run.created'): Record<string, unknown> {
  return { id: fakeId('event'), runId: fakeId('run'), seq: 1, type, at: 1_700_000_000_000, payload: {} };
}
