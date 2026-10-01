// In-memory world of the fake bridge (10 J3). Every builder parses through the contracts schema, so the fake can
// never serve a shape the real runner would not. Dev/test only: main.tsx loads this module behind a DEV/test guard.
import type { appErrorSchema } from '@relay/contracts';
import {
  appInfoSchema,
  appSettingsSchema,
  artifactMetaSchema,
  attemptViewSchema,
  catalogModelSchema,
  contextManifestSchema,
  costSummarySchema,
  diagnosticsSchema,
  ID_PREFIX,
  ledgerEntryViewSchema,
  memoryRecordDetailSchema,
  previewResultSchema,
  profileWithWarningsSchema,
  projectSchema,
  providerStatusSchema,
  reportV1Schema,
  runDetailSchema,
  runEventSchema,
  stepDetailSchema,
  workflowSummarySchema,
  workflowVersionViewSchema,
} from '@relay/contracts';
import type {
  AppError,
  AppInfo,
  AppSettings,
  ArtifactContent,
  ArtifactMeta,
  AttemptView,
  CatalogModel,
  CostSummary,
  Diagnostics,
  IdPrefixKey,
  LedgerEntryView,
  MemoryRecordDetail,
  PauseReason,
  PreviewResult,
  ProfileWithWarnings,
  Project,
  ProviderStatus,
  RunDetail,
  RunEvent,
  RunStatus,
  StepDetail,
  StepState,
  ValidationIssue,
  WorkflowSummary,
  WorkflowVersionView,
} from '@relay/contracts';
import { allowedRunActions } from './allowed-actions';

/** Parse-input type of a contracts schema (zod 4 `z.input`), without importing zod into the renderer. */
type In<S extends { readonly _zod: { readonly input: unknown } }> = S['_zod']['input'];

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Deterministic, schema-valid id: `<prefix>_` + 26 Crockford chars ending in the decimal `n`. */
export function sid(p: IdPrefixKey, n: number): string {
  return `${ID_PREFIX[p]}_${String(n).padStart(26, '0')}`;
}

/** Deterministic lowercase sha256: `seed` hex chars (non-hex dropped) padded with zeros. */
export function sha(seed: string): string {
  const hex = seed.toLowerCase().replaceAll(/[^0-9a-f]/g, '');
  return `${hex}${'0'.repeat(64)}`.slice(0, 60) + 'b18c';
}

export interface StoredArtifact {
  meta: ArtifactMeta;
  content: ArtifactContent;
}

/** The mutable in-memory state behind every fake channel. */
export interface FakeWorld {
  info: AppInfo;
  settings: AppSettings;
  diagnostics: Diagnostics;
  projects: Project[];
  providers: ProviderStatus[];
  profiles: ProfileWithWarnings[];
  catalog: CatalogModel[];
  workflows: WorkflowSummary[];
  workflowVersions: WorkflowVersionView[];
  /** `workflows.validate` issues of the draft; a saved draft clears them; `workflows.publish` fails while non-empty. */
  workflowIssues: ValidationIssue[];
  /** Newest first. */
  runs: RunDetail[];
  steps: Map<string, StepDetail>;
  events: Map<string, RunEvent[]>;
  ledger: Map<string, LedgerEntryView[]>;
  memory: MemoryRecordDetail[];
  artifacts: Map<string, StoredArtifact>;
  preview: PreviewResult;
  /** `runs.preflight` answers with a blocked budget (new-run `budget-blocked`). */
  preflightBlocked: boolean;
  /** `runs.preflight` issues (new-run `validation-errors`); `runs.start` fails with them while non-empty. */
  preflightIssues: ValidationIssue[];
  /** Operation keys (e.g. `providers.test`) answered like the real runner's stubs: INTERNAL `not_implemented`. */
  notImplemented: Set<string>;
  /** `artifacts.export` fails with ARTIFACT_WRITE_FAILED (report `export-failed`). */
  exportFails: boolean;
  /** Operation keys whose native open/save dialog the user cancels (`importDiff` → null, exports → `exported: false`). */
  dialogCancels: Set<string>;
  /** Parse warnings `artifacts.importDiff` reports for the imported file. */
  importDiffWarnings: string[];
  /** Providers whose `providers.test` fails with AUTH_REQUIRED. */
  authFailing: Set<string>;
  /** idempotencyKey → first result (02 §B0: a replay returns the first result). */
  idempotency: Map<string, unknown>;
  /** Next id number for created entities. */
  nextId: number;
  /** Clock. */
  now: () => number;
}

export const PROJECT_ID = sid('project', 1);
export const WORKFLOW_ID = sid('workflow', 1);
export const WORKFLOW_VERSION = 3;
export const WORKFLOW_NAME = 'Review & propose a fix';

export const PROFILES = {
  economy: { id: sid('profile', 1), name: 'Economy', providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
  balanced: { id: sid('profile', 2), name: 'Balanced', providerId: 'openai', modelId: 'gpt-5-mini' },
  capable: { id: sid('profile', 3), name: 'Capable', providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
} as const;

type ProfileKey = keyof typeof PROFILES;

/** Engine step keys of the review-propose-fix workflow, in timeline order. */
export const STEP_KEYS = ['intake', 'review', 'plan', 'approve', 'implement', 'verify'] as const;
export type StepKeyName = (typeof STEP_KEYS)[number];

const STEP_PROFILE: Readonly<Record<StepKeyName, ProfileKey | null>> = {
  intake: null,
  review: 'economy',
  plan: 'balanced',
  approve: null,
  implement: 'capable',
  verify: 'balanced',
};

// ---------------------------------------------------------------------------------------------------------------
// Static catalog data

function buildCatalog(): CatalogModel[] {
  const base = { effectiveDate: '2026-09-25', sourceRetrievedAt: '2026-09-25', catalogVersion: '2026-09-25' };
  const caps = {
    structuredOutput: true,
    streaming: true,
    tools: true,
    supportsRequestLookup: false,
    supportsTokenCounting: true,
    effortLevels: ['low', 'medium', 'high'],
    thinkingAlwaysOn: false,
  };
  return [
    {
      ...base,
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5',
      displayName: 'Claude Haiku 4.5',
      capabilities: { ...caps, maxInputTokens: 200_000, maxOutputTokens: 64_000 },
      prices: { input: 1_000_000, output: 5_000_000, cacheRead: 100_000, cacheWrite: 1_250_000 },
      source: 'https://www.anthropic.com/pricing',
    },
    {
      ...base,
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      displayName: 'Claude Sonnet 4.5',
      capabilities: { ...caps, maxInputTokens: 200_000, maxOutputTokens: 64_000 },
      prices: { input: 3_000_000, output: 15_000_000, cacheRead: 300_000, cacheWrite: 3_750_000 },
      source: 'https://www.anthropic.com/pricing',
    },
    {
      ...base,
      providerId: 'openai',
      modelId: 'gpt-5-mini',
      displayName: 'GPT-5 mini',
      capabilities: { ...caps, supportsRequestLookup: true, maxInputTokens: 400_000, maxOutputTokens: 128_000 },
      prices: { input: 250_000, output: 2_000_000, cacheRead: 25_000, cacheWrite: 0 },
      source: 'https://openai.com/api/pricing',
    },
  ].map((c) => catalogModelSchema.parse(c));
}

function buildProfiles(now: number): ProfileWithWarnings[] {
  const tokens: Readonly<Record<ProfileKey, number>> = { economy: 8_000, balanced: 8_000, capable: 16_000 };
  return (Object.keys(PROFILES) as ProfileKey[]).map((k) =>
    profileWithWarningsSchema.parse({
      profile: { ...PROFILES[k], params: { maxOutputTokens: tokens[k] }, revision: 1, updatedAt: now - 30 * DAY },
      warnings: [],
    }),
  );
}

const WORKFLOW_SPEC = {
  schemaVersion: 1,
  id: 'review-propose-fix',
  version: WORKFLOW_VERSION,
  name: WORKFLOW_NAME,
  limits: {
    budgetMicrousd: 3_000_000,
    maxRevisionCycles: 2,
    maxAttempts: 10,
    maxConcurrentSteps: 1,
    executionTimeoutSeconds: 900,
  },
  steps: [
    { id: 'review', kind: 'model', role: 'reviewer', profile: 'economy', outputSchema: 'findings.v1', instructionVersion: 'reviewer.v1', maxOutputTokens: 8000 },
    { id: 'plan', kind: 'model', role: 'planner', profile: 'balanced', dependsOn: ['review'], outputSchema: 'plan.v1', instructionVersion: 'planner.v1', maxOutputTokens: 8000 },
    { id: 'approve', kind: 'approval', dependsOn: ['plan'], bindTo: ['planHash', 'contextHash'] },
    { id: 'implement', kind: 'model', role: 'implementer', profile: 'capable', dependsOn: ['approve'], outputSchema: 'patch.v1', instructionVersion: 'implementer.v1', maxOutputTokens: 16000 },
    { id: 'verify', kind: 'model', role: 'reviewer', profile: 'balanced', dependsOn: ['implement'], outputSchema: 'review.v1', instructionVersion: 'verifier.v1', maxOutputTokens: 8000 },
  ],
  revisionPolicy: {
    triggerStep: 'verify',
    triggerOutcome: 'revise',
    repeatSteps: ['implement', 'verify'],
    approvalInvalidation: 'require_new_approval_if_plan_or_scope_changes',
    onLimit: 'incomplete',
  },
};

export function buildWorkflowVersion(version: number | 'draft', draftRevision: number | null): WorkflowVersionView {
  const prompt = (instructionVersion: string, role: string) => ({
    instructionVersion,
    role,
    text: `You are the ${role}. Follow the output schema exactly and cite source files.`,
  });
  return workflowVersionViewSchema.parse({
    workflowId: WORKFLOW_ID,
    version,
    status: version === 'draft' ? 'draft' : 'validated',
    draftRevision,
    spec: WORKFLOW_SPEC,
    contentHash: sha(`c0de${String(version)}`),
    prompts: {
      'reviewer.v1': prompt('reviewer.v1', 'reviewer'),
      'planner.v1': prompt('planner.v1', 'planner'),
      'implementer.v1': prompt('implementer.v1', 'implementer'),
      'verifier.v1': prompt('verifier.v1', 'verifier'),
    },
    editable: {
      prompts: true,
      profiles: true,
      limits: true,
      maxOutputTokens: true,
      retryPolicy: true,
      memoryScope: true,
      structure: false,
    },
  });
}

function buildPreview(): PreviewResult {
  const files = [
    ['README.md', 2_140],
    ['package.json', 812],
    ['src/app.ts', 1_930],
    ['src/routes/users.ts', 3_460],
    ['src/routes/orders.ts', 2_870],
    ['src/validation/schemas.ts', 1_520],
    ['src/errors.ts', 990],
    ['src/db/client.ts', 1_210],
    ['tests/users.test.ts', 2_300],
  ] as const;
  return previewResultSchema.parse({
    included: files.map(([relPath, sizeBytes], i) => ({ relPath, sizeBytes, sha256: sha(`f${String(i)}`) })),
    excluded: [
      { relPath: '.env', reason: 'secret' },
      { relPath: 'node_modules', reason: 'dependency_dir' },
      { relPath: 'assets/logo.png', reason: 'binary' },
      { relPath: 'dist', reason: 'build_output' },
    ],
    totals: {
      files: files.length,
      bytes: files.reduce((sum, [, b]) => sum + b, 0),
      capBytes: 512 * 1024,
      capFiles: 200,
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Memory

/** Memory variants of a scenario (Memory page mock states, 10 J5). */
export interface MemoryOptions {
  /** `conflict`: suggestion 10 conflicts with approved record 2 (memory `conflict` state). */
  readonly conflict?: boolean;
  /** `stale`: approved record 4 cites a source file that changed since approval, and its review date is due. */
  readonly stale?: boolean;
}

export function buildMemory(now: number, count: 'setup-only' | 'full', o: MemoryOptions = {}): MemoryRecordDetail[] {
  const conflict = o.conflict ?? false;
  const approved = [
    ['Preserve the existing public response format', 'Responses keep the `{ data, error }` envelope. Do not rename fields.', 'user_rule', true],
    ['Validate request bodies with zod', 'All route handlers parse bodies with the shared zod schemas in src/validation.', 'project_decision', false],
    ['Return 422 for invalid input', 'Validation failures return HTTP 422 with a field error list.', 'project_decision', false],
    ['Keep handlers thin', 'Route handlers delegate to services; no SQL in handlers.', 'user_rule', false],
    ['Use the shared error helper', 'Errors are created with `appError()` from src/errors.ts.', 'project_decision', false],
    ['Tests live beside routes', 'Every route has a matching test in tests/.', 'project_decision', false],
    ['Pagination limit is 100', 'List endpoints cap `limit` at 100 and default to 25.', 'project_decision', false],
    ['No new dependencies without review', 'Proposed patches must not add packages.', 'user_rule', true],
  ] as const;
  const selected = count === 'setup-only' ? approved.slice(0, 1) : approved;
  const records: MemoryRecordDetail[] = selected.map(([title, content, type, pinned], i) =>
    memoryRecord(now, {
      n: i + 1,
      title,
      content,
      type,
      pinned,
      status: 'approved',
      conflictsWith: conflict && i === 1 ? [sid('memory', 10)] : [],
      ...(o.stale === true && i === 3
        ? { stale: true, sourceFile: 'src/routes/users.ts', reviewAt: now - DAY, previousContent: 'Route handlers delegate to services.' }
        : {}),
    }),
  );
  if (count === 'full') {
    records.push(
      memoryRecord(now, {
        n: 9,
        title: 'Log request IDs on every error',
        content: 'Error responses include the request ID header so support can trace them.',
        type: 'project_decision',
        pinned: false,
        status: 'suggested',
        conflictsWith: [],
      }),
      memoryRecord(now, {
        n: 10,
        title: 'Validate with hand-written checks',
        content: 'Prefer small hand-written validators over schema libraries in route handlers.',
        type: 'project_decision',
        pinned: false,
        status: 'suggested',
        conflictsWith: conflict ? [sid('memory', 2)] : [],
      }),
      memoryRecord(now, {
        n: 11,
        title: 'Validate with express-validator',
        content: 'Route handlers validate bodies with express-validator chains.',
        type: 'project_decision',
        pinned: false,
        status: 'archived',
        conflictsWith: [],
        supersededById: sid('memory', 2),
      }),
    );
  }
  return records;
}

interface MemorySpec {
  readonly n: number;
  readonly title: string;
  readonly content: string;
  readonly type: 'user_rule' | 'project_decision';
  readonly pinned: boolean;
  readonly status: 'approved' | 'suggested' | 'archived';
  readonly conflictsWith: readonly string[];
  readonly supersededById?: string;
  readonly stale?: boolean;
  /** A `source_refs` file (with the hash recorded at approval). */
  readonly sourceFile?: string;
  readonly reviewAt?: number;
  /** When set, the record has two revisions: this text (rev 1) and `content` (rev 2). */
  readonly previousContent?: string;
}

function memoryRecord(now: number, m: MemorySpec): MemoryRecordDetail {
  const createdAt = now - (20 - m.n) * DAY;
  const fromRun = m.status === 'suggested';
  const author = fromRun ? `run:${sid('run', 23)}` : 'user';
  const sourceRefs = m.sourceFile === undefined ? [] : [{ kind: 'file' as const, relPath: m.sourceFile, sha256: sha('a19f') }];
  const revisions =
    m.previousContent === undefined
      ? [{ revision: 1, title: m.title, content: m.content, author, createdAt, sourceRefs }]
      : [
          { revision: 1, title: m.title, content: m.previousContent, author, createdAt, sourceRefs },
          { revision: 2, title: m.title, content: m.content, author: 'user', createdAt: createdAt + DAY, sourceRefs },
        ];
  const updatedAt = revisions.at(-1)?.createdAt ?? createdAt;
  return memoryRecordDetailSchema.parse({
    id: sid('memory', m.n),
    projectId: PROJECT_ID,
    type: m.type,
    status: m.status,
    title: m.title,
    excerpt: m.content.slice(0, 140),
    scope: { roles: 'all' },
    pinned: m.pinned,
    currentRevision: revisions.length,
    source: fromRun ? { kind: 'run', runId: sid('run', 23) } : m.sourceFile === undefined ? { kind: 'user' } : { kind: 'file', relPath: m.sourceFile },
    createdAt,
    updatedAt,
    expiresAt: null,
    reviewAt: m.reviewAt ?? null,
    supersededById: m.supersededById ?? null,
    stale: m.stale ?? false,
    conflictsWith: [...m.conflictsWith],
    content: m.content,
    revisions,
    events: [
      { event: fromRun ? 'suggested' : 'approved', revision: 1, actor: author, createdAt },
      ...(revisions.length > 1 ? [{ event: 'edited' as const, revision: 2, actor: 'user', createdAt: updatedAt }] : []),
      ...(m.status === 'archived' ? [{ event: 'conflict_resolved' as const, revision: 1, actor: 'user', createdAt: createdAt + DAY }] : []),
    ],
    usedByRuns: fromRun ? 0 : 3,
    ...(fromRun
      ? {
          proposal: {
            rationale: 'The verifier asked for this in two separate runs.',
            suggestedScope: { roles: 'all' },
            conflictsWith: [...m.conflictsWith],
          },
        }
      : {}),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Runs

/** Cost figures of a run (µUSD). */
export interface RunCostSpec {
  readonly allowance?: number;
  readonly reported?: number;
  readonly calculated?: number;
  readonly estimated?: number;
  readonly reserved?: number;
  readonly unknown?: number;
}

export function costSummary(c: RunCostSpec): CostSummary {
  const allowance = c.allowance ?? 3_000_000;
  const used = (c.reported ?? 0) + (c.calculated ?? 0) + (c.estimated ?? 0) + (c.reserved ?? 0) + (c.unknown ?? 0);
  return costSummarySchema.parse({
    allowance,
    settledReported: c.reported ?? 0,
    settledCalculated: c.calculated ?? 0,
    settledEstimated: c.estimated ?? 0,
    reserved: c.reserved ?? 0,
    unknown: c.unknown ?? 0,
    remaining: allowance - used,
    overrun: allowance - used < 0,
  });
}

/** Declarative description of one run in a scenario. */
export interface RunSpec {
  readonly n: number;
  readonly goal: string;
  readonly status: RunStatus;
  readonly pauseReason?: PauseReason | null;
  /** How long ago the run was created. */
  readonly agoMs: number;
  /** Wall time from start to end (or to now for active runs). */
  readonly durationMs: number;
  readonly steps: Partial<Record<StepKeyName, StepState>>;
  readonly cost: RunCostSpec;
  readonly statusDetail?: In<typeof appErrorSchema> | null;
  /** Step whose attempt outcome is unknown (liability µUSD). */
  readonly unknownAttempt?: { readonly step: StepKeyName; readonly liability: number };
  /** Error attached to the failed / invalid step. */
  readonly stepError?: { readonly step: StepKeyName; readonly error: In<typeof appErrorSchema> };
  readonly streaming?: boolean;
  readonly revisionCycle?: number;
  readonly limits?: { readonly maxAttempts?: number; readonly executionTimeoutSeconds?: number };
}

/** Every entity a run owns, ready to be merged into the world. */
export interface BuiltRun {
  readonly run: RunDetail;
  readonly steps: StepDetail[];
  readonly events: RunEvent[];
  readonly ledger: LedgerEntryView[];
  readonly artifacts: Array<[string, StoredArtifact]>;
}

function findingsValue() {
  return {
    summary: 'Two validation gaps in the users route.',
    sourceRefs: [{ relPath: 'src/routes/users.ts', startLine: 12, endLine: 40 }],
    unresolvedQuestions: [],
    outcome: 'findings',
    findings: [
      {
        id: 'F1',
        title: 'Create-user payload is not validated',
        severity: 'high',
        category: 'validation',
        description: 'The POST /users handler reads req.body fields without a schema.',
        sourceRefs: [{ relPath: 'src/routes/users.ts', startLine: 18, endLine: 26 }],
      },
      {
        id: 'F2',
        title: 'Invalid input returns 500',
        severity: 'medium',
        category: 'error_handling',
        description: 'A thrown TypeError becomes a 500 instead of a 422 with field errors.',
        sourceRefs: [{ relPath: 'src/errors.ts', startLine: 4, endLine: 12 }],
      },
    ],
  };
}

function planValue() {
  return {
    summary: 'Add a zod schema for the create-user payload and map failures to 422.',
    sourceRefs: [{ relPath: 'src/routes/users.ts', startLine: 18, endLine: 26 }],
    unresolvedQuestions: [],
    outcome: 'plan',
    goalRestatement: 'Validate user input and return 422 for invalid payloads.',
    steps: [
      { n: 1, action: 'Add createUserSchema to src/validation/schemas.ts', rationale: 'Finding F1', findingIds: ['F1'] },
      { n: 2, action: 'Parse the body in POST /users and return 422 with field errors', rationale: 'Finding F2', findingIds: ['F2'] },
    ],
    fileScope: ['src/routes/users.ts', 'src/validation/schemas.ts'],
    testSuggestions: ['Invalid email returns 422 with a field error'],
    risks: ['Clients relying on the 500 status code'],
    decisions: [],
  };
}

function patchValue() {
  return {
    summary: 'Validate the create-user payload.',
    sourceRefs: [{ relPath: 'src/routes/users.ts', startLine: 18, endLine: 26 }],
    unresolvedQuestions: [],
    outcome: 'patch',
    files: [
      {
        relPath: 'src/routes/users.ts',
        changeType: 'modify',
        unifiedDiff:
          '--- a/src/routes/users.ts\n+++ b/src/routes/users.ts\n@@ -18,4 +18,7 @@\n-  const user = req.body;\n+  const parsed = createUserSchema.safeParse(req.body);\n+  if (!parsed.success) return res.status(422).json({ error: parsed.error.issues });\n+  const user = parsed.data;\n',
      },
    ],
    testSuggestions: [{ relPath: 'tests/users.test.ts', description: 'Invalid email returns 422.' }],
    notes: '',
  };
}

function reviewValue(outcome: 'accept' | 'incomplete') {
  return {
    summary: outcome === 'accept' ? 'The patch implements the approved plan.' : 'The patch is still missing tests.',
    sourceRefs: [{ relPath: 'src/routes/users.ts', startLine: 18, endLine: 26 }],
    unresolvedQuestions: [],
    outcome,
    verdictRationale: outcome === 'accept' ? 'Matches the plan; only planned files changed.' : 'Revision limit reached.',
    requestedChanges: [],
    checks: [{ name: 'scope', passed: true, detail: 'Only planned files changed.' }],
    memoryProposals: [],
  };
}

const STEP_OUTPUT: Partial<Record<StepKeyName, { schemaId: string; kind: ArtifactMeta['kind']; value: () => unknown }>> = {
  review: { schemaId: 'findings.v1', kind: 'findings', value: findingsValue },
  plan: { schemaId: 'plan.v1', kind: 'plan', value: planValue },
  implement: { schemaId: 'patch.v1', kind: 'patch', value: patchValue },
};

const TERMINAL: readonly RunStatus[] = ['completed', 'incomplete', 'cancelled', 'failed'];

/** Builds a run and everything it owns from a {@link RunSpec}. */
export function buildRun(now: number, spec: RunSpec): BuiltRun {
  const runId = sid('run', spec.n);
  const createdAt = now - spec.agoMs;
  const startedAt = spec.status === 'queued' ? null : createdAt + 2_000;
  const endedAt = TERMINAL.includes(spec.status) && startedAt !== null ? startedAt + spec.durationMs : null;
  const artifacts: Array<[string, StoredArtifact]> = [];
  const stepDetails: StepDetail[] = [];
  const attemptsAll: AttemptView[] = [];
  const unresolvedAttempts: AttemptView[] = [];
  let artifactN = spec.n * 100;
  let attemptN = spec.n * 100;
  let hasPatch = false;
  let hasFailedStep = false;
  const stepViews = STEP_KEYS.map((key, i) => {
    const state: StepState = spec.steps[key] ?? 'pending';
    const stepId = sid('stepRun', spec.n * 100 + i);
    const profileKey = STEP_PROFILE[key];
    const profile = profileKey === null ? null : PROFILES[profileKey];
    const out = STEP_OUTPUT[key];
    let outputArtifactId: string | null = null;
    let output: { schemaId: string; value: unknown } | null = null;
    if (key === 'verify' && state === 'succeeded') {
      outputArtifactId = sid('artifact', (artifactN += 1));
      output = { schemaId: 'review.v1', value: reviewValue(spec.status === 'incomplete' ? 'incomplete' : 'accept') };
      artifacts.push([outputArtifactId, artifact(outputArtifactId, runId, stepId, 'review', 'review.v1', createdAt, output.value)]);
    } else if (out !== undefined && state === 'succeeded') {
      outputArtifactId = sid('artifact', (artifactN += 1));
      output = { schemaId: out.schemaId, value: out.value() };
      artifacts.push([outputArtifactId, artifact(outputArtifactId, runId, stepId, out.kind, out.schemaId, createdAt, output.value)]);
      if (key === 'implement') hasPatch = true;
    }
    const stepError = spec.stepError?.step === key ? spec.stepError.error : null;
    if (state === 'failed') hasFailedStep = true;
    const view = {
      id: stepId,
      stepKey: key,
      revisionIndex: 0,
      retryIndex: 0,
      state,
      profileName: profile?.name ?? null,
      providerId: profile?.providerId ?? null,
      modelId: profile?.modelId ?? null,
      outcome:
        state !== 'succeeded'
          ? null
          : key === 'review'
            ? 'findings'
            : key === 'verify'
              ? spec.status === 'incomplete'
                ? 'incomplete'
                : 'accept'
              : null,
      outputArtifactId,
      error: stepError,
    };
    // Attempts: one per model step that ran.
    const attempts: AttemptView[] = [];
    const ran = ['succeeded', 'failed', 'unknown', 'executing', 'validating'].includes(state);
    if (profile !== null && ran) {
      const isUnknown = spec.unknownAttempt?.step === key;
      const settled = state === 'succeeded';
      const attempt = attemptViewSchema.parse({
        id: sid('attempt', (attemptN += 1)),
        stepRunId: stepId,
        stepKey: key,
        seq: 1,
        purpose: 'initial',
        state: isUnknown ? 'unknown' : settled ? 'succeeded' : state === 'failed' ? 'failed' : 'dispatching',
        providerId: profile.providerId,
        modelId: profile.modelId,
        usage: settled ? { uncachedInputTokens: 12_400, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1_850 } : null,
        cost: isUnknown
          ? { microusd: spec.unknownAttempt.liability, certainty: 'unknown' }
          : settled
            ? { microusd: 160_000, certainty: 'reported' }
            : null,
        providerLatencyMs: settled ? 8_400 : null,
        appElapsedMs: settled ? 9_100 : null,
        providerRequestId: settled ? `req_${String(attemptN)}` : null,
        // An in-flight attempt started 47 s ago (running-streaming: 46.1 s provider time + 0.4 s app time so far).
        startedAt: state === 'executing' ? now - 47_000 : createdAt + 5_000 * (i + 1),
        finishedAt: settled ? createdAt + 5_000 * (i + 1) + 9_100 : null,
      });
      attempts.push(attempt);
      attemptsAll.push(attempt);
      if (isUnknown) unresolvedAttempts.push(attempt);
    }
    stepDetails.push(
      stepDetailSchema.parse({
        step: view,
        output,
        manifest: profile !== null && ran ? manifest(runId, key, profile) : null,
        attempts,
        events: [],
      }),
    );
    return view;
  });

  const planArtifact = artifacts.find(([, a]) => a.meta.kind === 'plan');
  const approvalStep = stepViews.find((s) => s.stepKey === 'approve');
  const pendingApproval =
    spec.status === 'awaiting_approval' && planArtifact !== undefined && approvalStep !== undefined
      ? {
          id: sid('approval', spec.n),
          planHash: sha('6f4a'),
          contextHash: sha('9c1e'),
          fileScope: ['src/routes/users.ts', 'src/validation/schemas.ts'],
          providers: ['anthropic', 'openai'],
          planArtifactId: planArtifact[0],
          decision: null,
          createdAt: createdAt + 60_000,
        }
      : null;

  let reportArtifactId: string | null = null;
  const cost = costSummary(spec.cost);
  if (TERMINAL.includes(spec.status)) {
    reportArtifactId = sid('artifact', (artifactN += 1));
    const byKind = (k: ArtifactMeta['kind']) => artifacts.find(([, a]) => a.meta.kind === k)?.[0] ?? null;
    const report = reportV1Schema.parse({
      schemaId: 'report.v1',
      runId,
      projectId: PROJECT_ID,
      goal: spec.goal,
      status: spec.status,
      verdict: spec.status === 'completed' ? 'accept' : spec.status === 'incomplete' ? 'incomplete' : null,
      workflow: { id: WORKFLOW_ID, version: WORKFLOW_VERSION, contentHash: sha('c0de3') },
      steps: stepViews.map((s) => ({
        stepKey: s.stepKey,
        revisionIndex: 0,
        retryIndex: 0,
        state: s.state,
        profileName: s.profileName,
        providerId: s.providerId,
        modelId: s.modelId,
        cost: { settledMicrousd: s.state === 'succeeded' && s.profileName ? 160_000 : 0, certainty: 'reported', unknownMicrousd: 0 },
      })),
      totals: cost,
      unknownLiabilities: unresolvedAttempts.map((a) => ({
        attemptId: a.id,
        stepKey: a.stepKey,
        liabilityMicrousd: a.cost?.microusd ?? 0,
        state: 'unknown',
      })),
      artifacts: { findings: byKind('findings'), plan: byKind('plan'), patch: byKind('patch'), review: byKind('review') },
      limitations: ['Relay proposed a patch. It was not applied to your project.'],
      snapshotUsed: false,
      generatedAt: endedAt ?? now,
    });
    artifacts.push([reportArtifactId, artifact(reportArtifactId, runId, null, 'report', 'report.v1', endedAt ?? now, report)]);
  }

  const availableActions = allowedRunActions(spec.status, spec.pauseReason ?? null, {
    unknownAttempts: unresolvedAttempts.length,
    hasFailedStep,
    hasPatchArtifact: hasPatch,
  });

  const run = runDetailSchema.parse({
    id: runId,
    projectId: PROJECT_ID,
    goal: spec.goal,
    workflow: { id: WORKFLOW_ID, version: WORKFLOW_VERSION, name: WORKFLOW_NAME },
    status: spec.status,
    pauseReason: spec.status === 'paused' ? (spec.pauseReason ?? null) : null,
    stepProgress: { done: stepViews.filter((s) => s.state === 'succeeded').length, total: stepViews.length },
    cost,
    createdAt,
    startedAt,
    endedAt,
    limits: {
      budgetMicrousd: cost.allowance,
      maxRevisionCycles: 2,
      maxAttempts: spec.limits?.maxAttempts ?? 10,
      maxConcurrentSteps: 1,
      executionTimeoutSeconds: spec.limits?.executionTimeoutSeconds ?? 900,
      maxToolCalls: 0,
    },
    input: { kind: 'files', relPaths: ['src/routes/users.ts', 'src/validation/schemas.ts'] },
    contextHash: spec.status === 'queued' ? null : sha('9c1e'),
    steps: stepViews,
    pendingApproval,
    unresolvedAttempts,
    executionMsUsed: Math.min(spec.durationMs, 900_000),
    revisionCycle: spec.revisionCycle ?? 0,
    statusDetail: spec.statusDetail ?? null,
    reportArtifactId,
    availableActions,
  });

  const events = buildEvents(run, spec, attemptsAll);
  // `runs.getStep` events: those whose payload names the row (`stepRunId`), never every row of the same step key.
  const byRow = new Map<string, RunEvent[]>();
  for (const e of events) {
    const stepRunId = e.payload['stepRunId'];
    if (typeof stepRunId === 'string') byRow.set(stepRunId, [...(byRow.get(stepRunId) ?? []), e]);
  }
  const steps = stepDetails.map((d) => ({ ...d, events: byRow.get(d.step.id) ?? [] }));
  return { run, steps, events, ledger: buildLedger(run, attemptsAll), artifacts };
}

function artifact(
  id: string,
  runId: string,
  stepRunId: string | null,
  kind: ArtifactMeta['kind'],
  schemaId: string,
  createdAt: number,
  value: unknown,
): StoredArtifact {
  return {
    meta: artifactMetaSchema.parse({
      id,
      kind,
      schemaId,
      runId,
      stepRunId,
      attemptId: null,
      sha256: sha(id.slice(-8)),
      sizeBytes: JSON.stringify(value).length,
      mediaType: 'application/json',
      createdAt,
      purged: false,
    }),
    content: { kind: 'json', value },
  };
}

/** A redacted raw-response text artifact (schema-invalid / output-invalid "View raw response"). */
export function rawResponseArtifact(id: string, runId: string, stepRunId: string | null, createdAt: number, text: string): StoredArtifact {
  return {
    meta: artifactMetaSchema.parse({
      id,
      kind: 'raw_response',
      schemaId: null,
      runId,
      stepRunId,
      attemptId: null,
      sha256: sha(id.slice(-8)),
      sizeBytes: text.length,
      mediaType: 'text/plain',
      createdAt,
      purged: false,
    }),
    content: { kind: 'text', text, truncated: false },
  };
}

function manifest(runId: string, stepKey: string, profile: (typeof PROFILES)[ProfileKey]) {
  return contextManifestSchema.parse({
    schemaVersion: 1,
    runId,
    stepKey,
    revisionIndex: 0,
    attemptPurpose: 'initial',
    profile: { name: profile.name, providerId: profile.providerId, modelId: profile.modelId },
    priceCatalogVersion: '2026-09-25',
    instructions: { version: `${stepKey}.v1`, sha256: sha('1257') },
    files: [
      { relPath: 'src/routes/users.ts', sha256: sha('a1'), sizeBytes: 3_460, tokens: 910, included: true, reason: 'selected' },
      { relPath: 'src/validation/schemas.ts', sha256: sha('a2'), sizeBytes: 1_520, tokens: 400, included: true, reason: 'selected' },
    ],
    memory: [
      { recordId: sid('memory', 1), revision: 1, type: 'user_rule', included: true, pinned: true, stale: false, score: 1 },
    ],
    upstream: [],
    omitted: [],
    tokens: { estimatedInput: 12_400, budget: 200_000, basis: 'local_estimate' },
    contextHash: sha('9c1e'),
    providersReceivingContext: [profile.providerId],
  });
}

function buildEvents(run: RunDetail, spec: RunSpec, attempts: readonly AttemptView[]): RunEvent[] {
  const out: RunEvent[] = [];
  let seq = 0;
  const push = (type: RunEvent['type'], at: number, payload: Record<string, unknown>) => {
    seq += 1;
    out.push(
      runEventSchema.parse({ id: sid('event', spec.n * 1000 + seq), runId: run.id, seq, type, at, payload }),
    );
  };
  push('run.created', run.createdAt, {});
  push('run.status_changed', run.createdAt + 1_000, { from: 'queued', to: 'running', pauseReason: null });
  run.steps.forEach((s, i) => {
    if (s.state === 'pending') return;
    const at = run.createdAt + 5_000 * (i + 1);
    // Every step / attempt event names its row (`stepRunId`), as the engine emits it; `stepKey` is kept for display.
    const row = { stepKey: s.stepKey, stepRunId: s.id };
    push('step.state_changed', at, { ...row, to: s.state });
    const attempt = attempts.find((a) => a.stepRunId === s.id);
    if (attempt !== undefined) {
      push('attempt.created', at + 100, { ...row, attemptId: attempt.id });
      if (spec.streaming === true && s.state === 'executing') {
        push('attempt.stream_progress', attempt.startedAt + 46_500, { ...row, outputTokensSoFar: 1_380, elapsedMs: 46_100 });
      }
      if (attempt.state === 'succeeded') push('attempt.settled', at + 9_100, { ...row, attemptId: attempt.id });
      if (attempt.state === 'unknown') push('attempt.unknown', at + 9_100, { ...row, attemptId: attempt.id });
    }
    if (s.state === 'awaiting_approval') push('approval.requested', at + 200, row);
  });
  if (run.status !== 'running' && run.status !== 'queued') {
    push('run.status_changed', (run.endedAt ?? run.createdAt + spec.durationMs) + 0, {
      from: 'running',
      to: run.status,
      pauseReason: run.pauseReason,
    });
  }
  return out;
}

function buildLedger(run: RunDetail, attempts: readonly AttemptView[]): LedgerEntryView[] {
  const entries: LedgerEntryView[] = [];
  let n = 0;
  const add = (e: Omit<In<typeof ledgerEntryViewSchema>, 'id' | 'scope' | 'runId'>) => {
    n += 1;
    const numericRun = Number(run.id.slice(-4));
    entries.push(ledgerEntryViewSchema.parse({ id: sid('ledger', numericRun * 1000 + n), scope: 'run', runId: run.id, ...e }));
  };
  add({ createdAt: run.createdAt, stepKey: null, attemptId: null, type: 'allowance_set', bucket: 'allowance', deltaMicrousd: run.cost.allowance, certainty: null, priceCatalogVersion: null, note: null });
  for (const a of attempts) {
    add({ createdAt: a.startedAt, stepKey: a.stepKey, attemptId: a.id, type: 'reserve', bucket: 'reserved', deltaMicrousd: 360_000, certainty: 'estimated', priceCatalogVersion: '2026-09-25', note: null });
    if (a.state === 'succeeded') {
      add({ createdAt: a.finishedAt ?? a.startedAt, stepKey: a.stepKey, attemptId: a.id, type: 'release', bucket: 'reserved', deltaMicrousd: -360_000, certainty: null, priceCatalogVersion: '2026-09-25', note: null });
      add({ createdAt: a.finishedAt ?? a.startedAt, stepKey: a.stepKey, attemptId: a.id, type: 'settle', bucket: 'settled', deltaMicrousd: a.cost?.microusd ?? 0, certainty: 'reported', priceCatalogVersion: '2026-09-25', note: null });
    }
    if (a.state === 'unknown') {
      add({ createdAt: a.startedAt + 1, stepKey: a.stepKey, attemptId: a.id, type: 'move_to_unknown', bucket: 'unknown', deltaMicrousd: a.cost?.microusd ?? 0, certainty: 'unknown', priceCatalogVersion: '2026-09-25', note: 'Request outcome unknown' });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------------------------
// Whole world

export interface WorldOptions {
  readonly now: number;
  readonly runs: readonly RunSpec[];
  readonly memory: 'setup-only' | 'full';
  readonly memoryConflict?: boolean;
  /** Memory `stale-source` state (approved record 4 cites a changed file; its review date is due). */
  readonly memoryStale?: boolean;
  /** A saved workflow draft exists (workflow editor `editing`). */
  readonly workflowDraft?: boolean;
  /** `workflows.validate` issues of the draft (workflow editor `validation-errors`). */
  readonly workflowIssues?: readonly ValidationIssue[];
  /** Providers whose last connection test failed with AUTH_REQUIRED. */
  readonly authFailed?: readonly ('anthropic' | 'openai')[];
  readonly secureStorage?: boolean;
  readonly preflightBlocked?: boolean;
  readonly projectAllowance?: number | null;
  readonly providerMode?: 'fake' | 'live';
  /** A fresh install: no project, no connected provider, onboarding not completed. */
  readonly fresh?: boolean;
  readonly preflightIssues?: readonly ValidationIssue[];
  readonly notImplemented?: readonly string[];
  readonly scenario: string;
}

export function buildWorld(o: WorldOptions): FakeWorld {
  const now = o.now;
  const built = o.runs.map((r) => buildRun(now, r));
  const secure = o.secureStorage ?? true;
  const authFailed = new Set<string>(o.authFailed ?? []);
  const fresh = o.fresh ?? false;
  const provider = (providerId: 'anthropic' | 'openai' | 'gemini', displayName: string, connectedLabel: string | null) => {
    const label = fresh ? null : connectedLabel;
    return providerStatusSchema.parse({
      providerId,
      displayName,
      connected: label !== null,
      storage: label === null ? 'none' : secure ? 'os_protected' : 'session',
      redactedLabel: label,
      lastTest:
        label === null
          ? null
          : authFailed.has(providerId)
            ? { at: now - HOUR, ok: false, code: 'AUTH_REQUIRED' }
            : { at: now - DAY, ok: true },
    });
  };
  const world: FakeWorld = {
    info: appInfoSchema.parse({
      version: '0.1.0',
      buildId: 'dev-fake',
      electron: 'n/a',
      node: 'n/a',
      platform: 'darwin',
      userDataDisplayPath: '~/Library/Application Support/Relay',
      isPackaged: false,
      providerMode: o.providerMode ?? 'fake',
      fakeScenario: o.scenario,
    }),
    settings: appSettingsSchema.parse({
      theme: 'dark',
      activeProjectId: fresh ? null : PROJECT_ID,
      onboardingCompletedAt: fresh ? null : now - 30 * DAY,
      rawResponseRetentionDays: 30,
      setupAllowanceMicrousd: 50_000,
    }),
    diagnostics: diagnosticsSchema.parse({
      runner: { state: 'ready', pid: 4242, lastHeartbeatAt: now - 1_000, restarts: 0 },
      db: { schemaVersion: 1, migrationsPending: 0, sizeBytes: 1_048_576 },
      unresolvedAttempts: built.reduce((sum, b) => sum + b.run.unresolvedAttempts.length, 0),
      secureStorage: { available: secure, backend: secure ? 'keychain' : 'basic_text' },
      catalog: { version: '2026-09-25', models: 3 },
      prompts: { loaded: 4 },
    }),
    projects: fresh
      ? []
      : [
      projectSchema.parse({
        id: PROJECT_ID,
        name: 'Example API',
        rootDisplayPath: '~/code/example-api',
        exclusions: [],
        providerPolicy: { allowedProviderIds: ['anthropic', 'openai'], providerOptions: { openai: { storeResponses: true } } },
        monthlyAllowanceMicrousd: o.projectAllowance === undefined ? 20_000_000 : o.projectAllowance,
        isDemo: false,
        createdAt: now - 40 * DAY,
        updatedAt: now - 40 * DAY,
        archivedAt: null,
      }),
        ],
    providers: [
      provider('anthropic', 'Anthropic', 'sk-ant-…a1F9'),
      provider('openai', 'OpenAI', 'sk-…Q7d2'),
      provider('gemini', 'Google Gemini', null),
    ],
    profiles: buildProfiles(now),
    catalog: buildCatalog(),
    workflows: [
      workflowSummarySchema.parse({
        id: WORKFLOW_ID,
        name: WORKFLOW_NAME,
        latestValidatedVersion: WORKFLOW_VERSION,
        draftVersion: o.workflowDraft === true ? WORKFLOW_VERSION + 1 : null,
      }),
    ],
    workflowVersions: [
      buildWorkflowVersion(WORKFLOW_VERSION, null),
      ...(o.workflowDraft === true ? [buildWorkflowVersion('draft', 1)] : []),
    ],
    workflowIssues: [...(o.workflowIssues ?? [])],
    runs: built.map((b) => b.run).sort((a, b) => b.createdAt - a.createdAt),
    steps: new Map(built.flatMap((b) => b.steps.map((s) => [s.step.id as string, s] as const))),
    events: new Map(built.map((b) => [b.run.id as string, b.events])),
    ledger: new Map(built.map((b) => [b.run.id as string, b.ledger])),
    memory: fresh ? [] : buildMemory(now, o.memory, { conflict: o.memoryConflict ?? false, stale: o.memoryStale ?? false }),
    artifacts: new Map(built.flatMap((b) => b.artifacts)),
    preview: buildPreview(),
    preflightBlocked: o.preflightBlocked ?? false,
    preflightIssues: [...(o.preflightIssues ?? [])],
    notImplemented: new Set(o.notImplemented ?? []),
    exportFails: false,
    dialogCancels: new Set(),
    importDiffWarnings: [],
    authFailing: authFailed,
    idempotency: new Map(),
    nextId: 5_000,
    now: () => now,
  };
  return world;
}

/** Re-exported for handlers that construct errors. */
export type { AppError };
