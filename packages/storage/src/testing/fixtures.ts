// Test fixtures for the colocated storage unit tests. Not exported from the package barrel.
import type {
  AttemptId,
  Clock,
  EpochMs,
  ProfileSnapshot,
  ProjectId,
  RunId,
  RunLimits,
  StepKey,
  StepRunId,
  WorkflowSpec,
  WorkflowVersionId,
} from '@relay/contracts';
import { randomBytes } from 'node:crypto';
import type { IdOf, IdPrefixKey } from '@relay/contracts';
import { DEFAULT_LIMITS, createIdGen, epochMs, profileSnapshotSchema, runLimitsSchema, systemClock, workflowSpecSchema } from '@relay/contracts';
import type { Migration } from '../../migrations/index.js';
import type { AttemptRow, Db, ProjectRow, RunRow, StepRow } from '../types.js';
import type { TestDb } from '../unit-of-work.js';
import { openTestDb } from '../unit-of-work.js';

/** A controllable clock. */
export interface ManualClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

export function manualClock(start = 1_700_000_000_000): ManualClock {
  let t = start;
  return {
    now: () => epochMs(t),
    set(ms) {
      t = ms;
    },
    advance(ms) {
      t += ms;
    },
  };
}

export const sha = (ch = 'a'): string => ch.repeat(64);

export interface FixtureDb {
  readonly db: TestDb;
  readonly clock: ManualClock;
}

export async function openFixtureDb(
  opts: { isPidAlive?: (pid: number) => boolean; migrations?: readonly Migration[] } = {},
): Promise<FixtureDb> {
  const clock = manualClock();
  const db = await openTestDb({ clock, ...opts });
  return { db, clock };
}

export const LIMITS: RunLimits = runLimitsSchema.parse(DEFAULT_LIMITS);

export const SPEC: WorkflowSpec = workflowSpecSchema.parse({
  schemaVersion: 1,
  id: 'review-propose-fix',
  version: 1,
  name: 'Review',
  limits: {},
  steps: [
    { id: 'review', kind: 'model', role: 'reviewer', profile: 'Economy', outputSchema: 'findings.v1', instructionVersion: 'reviewer.v1' },
  ],
  revisionPolicy: {
    triggerStep: 'review',
    triggerOutcome: 'revise',
    repeatSteps: ['review'],
    approvalInvalidation: 'require_new_approval_if_plan_or_scope_changes',
    onLimit: 'incomplete',
  },
});

export const CAPABILITIES = {
  structuredOutput: true,
  streaming: true,
  tools: false,
  supportsRequestLookup: false,
  supportsTokenCounting: true,
  effortLevels: [],
  thinkingAlwaysOn: false,
};

export function profileSnapshot(): ProfileSnapshot {
  return profileSnapshotSchema.parse({
    id: 'prf_01J9ZZZZZZZZZZZZZZZZZZZZZ0',
    name: 'Economy',
    providerId: 'fake',
    modelId: 'fake-model',
    params: { maxOutputTokens: 8000 },
    revision: 1,
    updatedAt: 1,
    capabilities: CAPABILITIES,
    prices: { input: 1_000_000, output: 5_000_000, cacheRead: 100_000, cacheWrite: 1_250_000 },
    priceCatalogVersion: '2026-09-25',
  });
}

export function seedProject(db: Db, clock: Clock, over: Partial<{ name: string; root: string }> = {}): ProjectRow {
  return db.repos.projects.insert({
    id: newId('project'),
    name: over.name ?? 'sample-api',
    rootRealpath: over.root ?? `/tmp/${Math.random().toString(36).slice(2)}`,
    rootDisplayPath: '~/code/sample-api',
    exclusions: [],
    providerPolicy: { allowedProviderIds: ['fake'], providerOptions: { openai: { storeResponses: true } } },
    monthlyAllowanceMicrousd: null,
    isDemo: false,
    createdAt: clock.now(),
  });
}

const ID_GEN = createIdGen(systemClock, (n) => randomBytes(n));

/** Mints a well-formed id (same format as the repos' IdGen). */
export function newId<P extends IdPrefixKey>(p: P): IdOf<P> {
  return ID_GEN.next(p);
}

export function seedWorkflowVersion(db: Db, clock: Clock): WorkflowVersionId {
  const wf = db.repos.workflows.ensureWorkflow('review-propose-fix', 'Review');
  const existing = db.repos.workflows.getVersion(wf.id, 1);
  if (existing !== undefined) {
    return existing.id;
  }
  return db.repos.workflows.insertVersion({
    id: newId('workflowVersion'),
    workflowId: wf.id,
    version: 1,
    status: 'validated',
    schemaVersion: 1,
    spec: SPEC,
    prompts: { 'reviewer.v1': 'Review.' },
    contentHash: sha('c'),
    basedOnVersion: null,
    createdAt: clock.now(),
    validatedAt: clock.now(),
  }).id;
}

export function seedRun(
  db: Db,
  clock: Clock,
  projectId: ProjectId,
  over: Partial<{ createdAt: EpochMs; id: RunId }> = {},
): RunRow {
  const wfv = seedWorkflowVersion(db, clock);
  const id = over.id ?? newId('run');
  return db.repos.runs.insert({
    id,
    projectId,
    workflowVersionId: wfv,
    goal: 'Fix validation',
    input: { kind: 'files', relPaths: ['src/a.ts'] as never },
    snapshot: { steps: {} },
    limits: LIMITS,
    idempotencyKey: `key-${id}`,
    createdAt: over.createdAt ?? clock.now(),
  });
}

export function seedStep(
  db: Db,
  clock: Clock,
  runId: RunId,
  over: Partial<{ stepKey: string; ordinal: number; revisionIndex: number; state: StepRow['state'] }> = {},
): StepRow {
  const [row] = db.repos.steps.insertMany([
    {
      id: newId('stepRun'),
      runId,
      stepKey: (over.stepKey ?? 'review') as StepKey,
      ordinal: over.ordinal ?? 1,
      revisionIndex: over.revisionIndex ?? 0,
      state: over.state ?? 'ready',
      profileName: 'Economy',
      createdAt: clock.now(),
    },
  ]);
  if (row === undefined) {
    throw new Error('step not inserted');
  }
  return row;
}

export function seedAttempt(
  db: Db,
  clock: Clock,
  runId: RunId,
  stepRunId: StepRunId,
  over: Partial<{ id: AttemptId; seq: number; state: AttemptRow['state'] }> = {},
): AttemptRow {
  return db.repos.attempts.insert({
    id: over.id ?? newId('attempt'),
    runId,
    stepRunId,
    seq: over.seq ?? db.repos.attempts.nextSeq(stepRunId),
    purpose: 'initial',
    providerId: 'fake',
    modelId: 'fake-model',
    profileSnapshot: profileSnapshot(),
    requestFingerprint: sha('f'),
    state: over.state ?? 'reserved',
    reservationMicrousd: 1000,
    estimate: { upperAllowanceMicrousd: 1000 },
    priceCatalogVersion: '2026-09-25',
    createdAt: clock.now(),
  });
}
