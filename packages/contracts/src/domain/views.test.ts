import { describe, expect, it } from 'vitest';
import { RUN_LIMIT_MAXIMUMS } from '../defaults.js';
import {
  costSummaryFixture,
  fakeId,
  fakeSha,
  findingsFixture,
  manifestFixture,
  planFixture,
  reviewFixture,
  runEventFixture,
  stepViewFixture,
} from '../test-fixtures.js';
import { catalogFileSchema } from './catalog.js';
import { memoryRecordDetailSchema } from './memory.js';
import { profileSnapshotSchema } from './profile.js';
import { projectSchema } from './project.js';
import { runDetailSchema, runStartInputSchema } from './run.js';
import { appSettingsSchema, previewResultSchema, recoveryDecisionSchema, stepDetailSchema } from './views.js';
import { workflowDraftPatchSchema } from './workflow.js';

const capabilities = {
  structuredOutput: true,
  streaming: true,
  tools: false,
  supportsRequestLookup: false,
  supportsTokenCounting: true,
  effortLevels: ['low', 'high'],
  thinkingAlwaysOn: false,
};
const prices = { input: 1_000_000, output: 5_000_000, cacheRead: 100_000, cacheWrite: 1_250_000 };

describe('stepDetailSchema', () => {
  it('discriminates the output union on schemaId', () => {
    const detail = (schemaId: string, value: unknown) => ({
      step: stepViewFixture(),
      output: { schemaId, value },
      manifest: manifestFixture(),
      attempts: [],
      events: [runEventFixture()],
    });

    expect(stepDetailSchema.safeParse(detail('findings.v1', findingsFixture())).success).toBe(true);
    expect(stepDetailSchema.safeParse(detail('plan.v1', planFixture())).success).toBe(true);
    expect(stepDetailSchema.safeParse(detail('plan.v1', findingsFixture())).success).toBe(false);
    expect(stepDetailSchema.safeParse(detail('review.v2', reviewFixture())).success).toBe(false);
    expect(stepDetailSchema.safeParse({ ...detail('plan.v1', planFixture()), output: null }).success).toBe(true);
  });
});

describe('recoveryDecisionSchema', () => {
  it('rejects raise_limits with no fields and with maxAttempts above the maximum', () => {
    expect(recoveryDecisionSchema.safeParse({ kind: 'raise_limits' }).success).toBe(false);
    expect(
      recoveryDecisionSchema.safeParse({ kind: 'raise_limits', maxAttempts: RUN_LIMIT_MAXIMUMS.maxAttempts + 1 }).success,
    ).toBe(false);
    expect(recoveryDecisionSchema.safeParse({ kind: 'raise_limits', executionTimeoutSeconds: 1800 }).success).toBe(true);
  });

  it('accepts every other decision kind', () => {
    for (const kind of ['continue', 'use_preserved_snapshot', 'resnapshot_and_replan', 'acknowledge_overrun']) {
      expect(recoveryDecisionSchema.safeParse({ kind }).success).toBe(true);
    }
    expect(
      recoveryDecisionSchema.safeParse({ kind: 'switch_profile', stepKey: 'plan', profileId: fakeId('profile') }).success,
    ).toBe(true);
  });
});

describe('workflowDraftPatchSchema', () => {
  it('rejects an unknown top-level key and accepts P0-editable fields', () => {
    expect(workflowDraftPatchSchema.safeParse({ steps: {}, revisionPolicy: {} }).success).toBe(false);
    expect(
      workflowDraftPatchSchema.safeParse({
        prompts: { 'reviewer.v1': 'Review the files.' },
        limits: { maxAttempts: 12 },
        steps: { review: { profile: 'economy', retryPolicy: { transport: 2, schemaRepair: 1, rateLimitWaits: 3 } } },
      }).success,
    ).toBe(true);
    expect(workflowDraftPatchSchema.safeParse({ steps: { review: { outputSchema: 'plan.v1' } } }).success).toBe(false);
  });
});

describe('runStartInputSchema', () => {
  const base = {
    idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZZ',
    projectId: fakeId('project'),
    workflowId: fakeId('workflow'),
    workflowVersion: 1,
    goal: 'Fix validation',
    input: { kind: 'files', relPaths: ['src/a.ts'] },
  };

  it('accepts profileOverrides keyed by step key', () => {
    const r = runStartInputSchema.safeParse({ ...base, profileOverrides: { review: fakeId('profile') } });

    expect(r.success).toBe(true);
    expect(runStartInputSchema.safeParse({ ...base, profileOverrides: { Review: fakeId('profile') } }).success).toBe(false);
  });

  it('validates the input union and limit overrides', () => {
    expect(runStartInputSchema.safeParse({ ...base, input: { kind: 'diff', diffArtifactId: fakeId('artifact') } }).success).toBe(true);
    expect(runStartInputSchema.safeParse({ ...base, input: { kind: 'files', relPaths: [] } }).success).toBe(false);
    expect(runStartInputSchema.safeParse({ ...base, limitOverrides: { maxToolCalls: 1 } }).success).toBe(false);
    expect(runStartInputSchema.safeParse({ ...base, limitOverrides: { executionTimeoutSeconds: 59 } }).success).toBe(false);
  });
});

describe('profile and catalog schemas', () => {
  it('profileSnapshotSchema requires prices', () => {
    const snapshot = {
      id: fakeId('profile'),
      name: 'Economy',
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5',
      params: { maxOutputTokens: 8000 },
      revision: 1,
      updatedAt: 1,
      capabilities,
      prices,
      priceCatalogVersion: '2026-09-25',
    };
    const withoutPrices = Object.fromEntries(Object.entries(snapshot).filter(([k]) => k !== 'prices'));

    const parsed = profileSnapshotSchema.parse(snapshot);

    expect(parsed.params.refusalFallback).toBe('off');
    expect(profileSnapshotSchema.safeParse(withoutPrices).success).toBe(false);
  });

  it('catalogFileSchema requires an https source and integer prices', () => {
    const entry = {
      providerId: 'fake',
      modelId: 'fake-model',
      displayName: 'Fake',
      capabilities,
      prices,
      effectiveDate: '2026-09-25',
      source: 'https://relay.invalid/docs/fake-provider',
      sourceRetrievedAt: '2026-09-25',
    };
    const file = { catalogVersion: '2026-09-25', currency: 'USD', entries: [entry] };

    expect(catalogFileSchema.safeParse(file).success).toBe(true);
    expect(catalogFileSchema.safeParse({ ...file, entries: [{ ...entry, source: 'http://x' }] }).success).toBe(false);
    expect(catalogFileSchema.safeParse({ ...file, entries: [{ ...entry, prices: { ...prices, input: 1.5 } }] }).success).toBe(false);
    expect(catalogFileSchema.safeParse({ ...file, entries: [] }).success).toBe(false);
  });
});

describe('project, run, memory, and settings DTOs', () => {
  it('projectSchema fills provider option defaults', () => {
    const project = projectSchema.parse({
      id: fakeId('project'),
      name: 'sample-api',
      rootDisplayPath: '~/code/sample-api',
      exclusions: [],
      providerPolicy: { allowedProviderIds: ['anthropic'] },
      monthlyAllowanceMicrousd: null,
      isDemo: true,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
    });

    expect(project.providerPolicy.providerOptions.openai.storeResponses).toBe(true);
  });

  it('runDetailSchema parses a paused run with actions', () => {
    const detail = {
      id: fakeId('run'),
      projectId: fakeId('project'),
      goal: 'Fix',
      workflow: { id: fakeId('workflow'), version: 1, name: 'Review and propose a fix' },
      status: 'paused',
      pauseReason: 'budget_run',
      stepProgress: { done: 1, total: 7 },
      cost: costSummaryFixture(),
      createdAt: 1,
      startedAt: 2,
      endedAt: null,
      limits: {
        budgetMicrousd: 3_000_000,
        maxRevisionCycles: 2,
        maxAttempts: 10,
        maxConcurrentSteps: 1,
        executionTimeoutSeconds: 900,
        maxToolCalls: 0,
      },
      input: { kind: 'files', relPaths: ['src/a.ts'] },
      contextHash: fakeSha(),
      steps: [stepViewFixture()],
      pendingApproval: null,
      unresolvedAttempts: [],
      executionMsUsed: 1000,
      revisionCycle: 0,
      statusDetail: null,
      reportArtifactId: null,
      availableActions: ['increase_allowance', 'choose_profile', 'stop'],
    };

    expect(runDetailSchema.safeParse(detail).success).toBe(true);
    expect(runDetailSchema.safeParse({ ...detail, availableActions: ['explode'] }).success).toBe(false);
  });

  it('memoryRecordDetailSchema accepts user and run authors only', () => {
    const detail = {
      id: fakeId('memory'),
      projectId: fakeId('project'),
      type: 'user_rule',
      status: 'approved',
      title: 'Use pnpm',
      excerpt: 'Use pnpm',
      scope: { roles: 'all' },
      pinned: true,
      currentRevision: 1,
      source: { kind: 'user' },
      createdAt: 1,
      updatedAt: 1,
      expiresAt: null,
      reviewAt: null,
      supersededById: null,
      stale: false,
      conflictsWith: [],
      content: 'Use pnpm, never npm.',
      revisions: [{ revision: 1, title: 'Use pnpm', content: 'x', author: `run:${fakeId('run')}`, createdAt: 1, sourceRefs: [] }],
      events: [{ event: 'approved', revision: 1, actor: 'user', createdAt: 1 }],
      usedByRuns: 0,
    };

    expect(memoryRecordDetailSchema.safeParse(detail).success).toBe(true);
    expect(
      memoryRecordDetailSchema.safeParse({ ...detail, events: [{ event: 'approved', revision: 1, actor: 'bot', createdAt: 1 }] })
        .success,
    ).toBe(false);
    expect(memoryRecordDetailSchema.safeParse({ ...detail, scope: { roles: [] } }).success).toBe(false);
  });

  it('previewResultSchema and appSettingsSchema validate enums and bounds', () => {
    expect(
      previewResultSchema.safeParse({
        included: [{ relPath: 'src/a.ts', sizeBytes: 1, sha256: null }],
        excluded: [{ relPath: 'node_modules', reason: 'dependency_dir' }],
        totals: { files: 1, bytes: 1, capBytes: 524288, capFiles: 200 },
      }).success,
    ).toBe(true);
    expect(
      appSettingsSchema.safeParse({
        theme: 'dark',
        activeProjectId: null,
        onboardingCompletedAt: null,
        rawResponseRetentionDays: 400,
        setupAllowanceMicrousd: 50_000,
      }).success,
    ).toBe(false);
  });
});
