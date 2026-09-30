// Schema-validated fixtures for component tests (09 I6). Every builder parses through the contracts
// schema, so a fixture that drifts from the contract fails loudly instead of testing a fake shape.
import {
  approvalViewSchema,
  appErrorSchema,
  attemptViewSchema,
  budgetBreakdownSchema,
  capabilityWarningSchema,
  catalogModelSchema,
  contextManifestSchema,
  costSummarySchema,
  memoryRecordViewSchema,
  planV1Schema,
  runDetailSchema,
  stepViewSchema,
} from '@relay/contracts';
import type {
  AppError,
  ApprovalView,
  AttemptView,
  BudgetBreakdown,
  CapabilityWarning,
  CatalogModel,
  ContextManifest,
  CostSummary,
  MemoryRecordView,
  PlanV1,
  RunDetail,
  StepView,
} from '@relay/contracts';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Deterministic valid id: `prefix_` + 26 Crockford base32 chars. */
export function fakeId(prefix: string, n: number): string {
  const body = String(n).padStart(26, '0').split('').map((d) => ULID_ALPHABET[Number(d)] ?? '0').join('');
  return `${prefix}_${body}`;
}

/** Deterministic lowercase sha256-shaped hex. */
export function fakeSha(seed: string): string {
  const head = seed.replaceAll(/[^0-9a-f]/g, '').slice(0, 8).padEnd(8, 'a');
  return `${head}${'0'.repeat(52)}b18c`;
}

export const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);

export function costSummary(overrides: Partial<Record<keyof CostSummary, number | boolean>> = {}): CostSummary {
  return costSummarySchema.parse({
    allowance: 3_000_000,
    settledReported: 400_000,
    settledCalculated: 80_000,
    settledEstimated: 120_000,
    reserved: 1_100_000,
    unknown: 50_000,
    remaining: 1_250_000,
    overrun: false,
    ...overrides,
  });
}

export function budgetBreakdown(overrides: Record<string, unknown> = {}): BudgetBreakdown {
  return budgetBreakdownSchema.parse({
    L: 3_000_000, C: 1_200_000, R: 400_000, U: 0, N: 1_500_000, scope: 'run', total: 3_100_000, allowed: false,
    ...overrides,
  });
}

export function plan(): PlanV1 {
  return planV1Schema.parse({
    summary: 'Tighten request validation in the users route.',
    sourceRefs: [{ relPath: 'src/routes/users.ts', startLine: 12, endLine: 30 }],
    unresolvedQuestions: [],
    outcome: 'plan',
    goalRestatement: 'Validate user input and return 422 for invalid payloads.',
    steps: [
      { n: 1, action: 'Add a schema for the create-user payload', rationale: 'Finding F1', findingIds: ['F1'] },
      { n: 2, action: 'Return 422 with field errors', rationale: 'Finding F2', findingIds: ['F2'] },
    ],
    fileScope: ['src/routes/users.ts'],
    testSuggestions: ['Post an empty body and expect 422'],
    risks: ['Clients relying on 400 responses'],
    decisions: [],
  });
}

export function approval(overrides: Record<string, unknown> = {}): ApprovalView {
  return approvalViewSchema.parse({
    id: fakeId('apr', 1),
    planHash: fakeSha('6f4a'),
    contextHash: fakeSha('c0ffee'),
    fileScope: ['src/routes/users.ts'],
    providers: ['anthropic'],
    planArtifactId: fakeId('art', 1),
    decision: null,
    createdAt: T0,
    ...overrides,
  });
}

export function step(n: number, overrides: Record<string, unknown> = {}): StepView {
  return stepViewSchema.parse({
    id: fakeId('stp', n),
    stepKey: 'review',
    revisionIndex: 0,
    retryIndex: 0,
    state: 'succeeded',
    profileName: 'Balanced',
    providerId: 'anthropic',
    modelId: 'claude-opus-5-5',
    outcome: null,
    outputArtifactId: null,
    error: null,
    ...overrides,
  });
}

export function attempt(n: number, overrides: Record<string, unknown> = {}): AttemptView {
  return attemptViewSchema.parse({
    id: fakeId('att', n),
    stepRunId: fakeId('stp', 1),
    stepKey: 'review',
    seq: n,
    purpose: 'initial',
    state: 'succeeded',
    providerId: 'anthropic',
    modelId: 'claude-opus-5-5',
    usage: { uncachedInputTokens: 12_000, cacheReadInputTokens: 400, cacheWriteInputTokens: 0, outputTokens: 2_100 },
    cost: { microusd: 480_000, certainty: 'reported' },
    providerLatencyMs: 41_000,
    appElapsedMs: 43_500,
    providerRequestId: 'req_123',
    startedAt: T0,
    finishedAt: T0 + 43_500,
    ...overrides,
  });
}

export function catalogModel(overrides: Record<string, unknown> = {}): CatalogModel {
  return catalogModelSchema.parse({
    providerId: 'anthropic',
    modelId: 'claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    capabilities: {
      structuredOutput: true,
      streaming: true,
      tools: false,
      supportsRequestLookup: false,
      supportsTokenCounting: true,
      effortLevels: ['low', 'medium', 'high'],
      thinkingAlwaysOn: false,
    },
    prices: { input: 5_000_000, output: 25_000_000, cacheRead: 500_000, cacheWrite: 6_250_000 },
    effectiveDate: '2026-09-01',
    source: 'https://example.com/pricing',
    sourceRetrievedAt: '2026-09-30',
    catalogVersion: '2026-09-30',
    ...overrides,
  });
}

export function capabilityWarning(overrides: Record<string, unknown> = {}): CapabilityWarning {
  return capabilityWarningSchema.parse({
    stepKey: 'plan',
    profileId: fakeId('prf', 1),
    code: 'output_budget_low',
    message: 'Max output tokens is below the recommended 8,000 for this role.',
    ...overrides,
  });
}

export function manifest(): ContextManifest {
  return contextManifestSchema.parse({
    schemaVersion: 1,
    runId: fakeId('run', 1),
    stepKey: 'review',
    revisionIndex: 0,
    attemptPurpose: 'initial',
    profile: { name: 'Balanced', providerId: 'anthropic', modelId: 'claude-opus-5-5' },
    priceCatalogVersion: '2026-09-30',
    instructions: { version: 'review@1', sha256: fakeSha('1a2b') },
    files: [
      { relPath: 'src/routes/users.ts', sha256: fakeSha('abcd'), sizeBytes: 2048, tokens: 640, included: true, reason: 'selected' },
      { relPath: 'src/big.ts', sha256: fakeSha('dcba'), sizeBytes: 90_000, tokens: 30_000, included: false, reason: 'selected' },
    ],
    memory: [
      { recordId: fakeId('mem', 1), revision: 3, type: 'user_rule', included: true, pinned: true, stale: false, score: 1 },
    ],
    upstream: [],
    omitted: [{ kind: 'file', ref: 'src/big.ts', reason: 'token_budget' }],
    tokens: { estimatedInput: 12_400, budget: 150_000, basis: 'local_estimate' },
    contextHash: fakeSha('c0ffee'),
    providersReceivingContext: ['anthropic'],
  });
}

export function memoryRecord(n: number, overrides: Record<string, unknown> = {}): MemoryRecordView {
  return memoryRecordViewSchema.parse({
    id: fakeId('mem', n),
    projectId: fakeId('prj', 1),
    type: 'project_decision',
    status: 'approved',
    title: `Response format ${String(n)}`,
    excerpt: 'Validation errors return 422 with a field list.',
    scope: { roles: 'all' },
    pinned: false,
    currentRevision: 1,
    source: { kind: 'user' },
    createdAt: T0,
    updatedAt: T0,
    expiresAt: null,
    reviewAt: null,
    supersededById: null,
    stale: false,
    conflictsWith: [],
    ...overrides,
  });
}

export function appError(overrides: Record<string, unknown> = {}): AppError {
  return appErrorSchema.parse({
    code: 'BUDGET_BLOCKED',
    userMessage: 'The next request would exceed the run allowance.',
    retryable: false,
    nextAction: 'increase_allowance',
    alternatives: ['choose_profile', 'stop'],
    ...overrides,
  });
}

export function runDetail(overrides: Record<string, unknown> = {}): RunDetail {
  return runDetailSchema.parse({
    id: fakeId('run', 1),
    projectId: fakeId('prj', 1),
    goal: 'Fix validation',
    workflow: { id: fakeId('wfl', 1), version: 1, name: 'Review, propose, fix' },
    status: 'interrupted',
    pauseReason: null,
    stepProgress: { done: 1, total: 5 },
    cost: costSummary(),
    createdAt: T0,
    startedAt: T0,
    endedAt: null,
    limits: {
      budgetMicrousd: 3_000_000, maxRevisionCycles: 2, maxAttempts: 10, maxConcurrentSteps: 1,
      executionTimeoutSeconds: 900, maxToolCalls: 0,
    },
    input: { kind: 'files', relPaths: ['src/routes/users.ts'] },
    contextHash: fakeSha('c0ffee'),
    steps: [step(1), step(2, { stepKey: 'plan', state: 'unknown' })],
    pendingApproval: null,
    unresolvedAttempts: [attempt(2, { state: 'unknown', cost: { microusd: 900_000, certainty: 'unknown' } })],
    executionMsUsed: 60_000,
    revisionCycle: 0,
    statusDetail: null,
    reportArtifactId: null,
    availableActions: ['review_recovery', 'decide_unknown', 'stop'],
    ...overrides,
  });
}
