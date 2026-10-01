// Row types and repository interfaces (03 §C6). The engine depends only on these interfaces (00b §3).
// Repos contain no business rules: admission, transitions, approval reuse, and backoff timing live in 06.
import type {
  AppError,
  ApprovalDecision,
  ApprovalId,
  ApprovalStaleReason,
  ArtifactId,
  ArtifactKind,
  AttemptId,
  AttemptPurpose,
  AttemptState,
  Balances,
  CatalogModel,
  CostCertainty,
  CredentialRef,
  CredentialRefId,
  CredentialStorageMode,
  EpochMs,
  ErrorCode,
  LedgerBucket,
  LedgerEntryId,
  LedgerEntryType,
  LedgerScope,
  MemoryEventType,
  MemoryId,
  MemoryRecordScope,
  MemoryRevisionId,
  MemorySourceRef,
  MemoryStatus,
  MemoryType,
  Microusd,
  ModelCapabilities,
  ModelParams,
  ModelProfile,
  PauseReason,
  ProfileId,
  ProfileSnapshot,
  Project,
  ProjectId,
  ProviderId,
  ProviderPolicy,
  RelPath,
  Result,
  Role,
  RunEvent,
  RunEventType,
  RunId,
  RunInput,
  RunLimits,
  RunStatus,
  Sha256,
  StepKey,
  StepRunId,
  StepState,
  UsageView,
  WorkflowId,
  WorkflowSpec,
  WorkflowVersionId,
} from '@relay/contracts';

// ---------------------------------------------------------------- shared

/** Whitelisted keyset sorts (02 §B0). */
export type ListSort = 'created_desc' | 'created_asc';

/** Keyset page request. `cursor` is the opaque value from a previous {@link Page}. */
export interface PageRequest {
  readonly sort?: ListSort;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/** Keyset page. `nextCursor` is null on the last page. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

// ---------------------------------------------------------------- projects & settings

/** Project as stored, renderer-safe: the absolute realpath is NOT part of this type (03 §C5). */
export type ProjectRow = Readonly<Project>;

/** Runner-internal project row including the canonical absolute root (never sent to the renderer). */
export type ProjectWithRoot = ProjectRow & { readonly rootRealpath: string };

/** New project. `updatedAt` starts equal to `createdAt`. */
export interface ProjectInsert {
  readonly id: ProjectId;
  readonly name: string;
  readonly rootRealpath: string;
  readonly rootDisplayPath: string;
  readonly exclusions: readonly string[];
  readonly providerPolicy: ProviderPolicy;
  readonly monthlyAllowanceMicrousd: Microusd | null;
  readonly isDemo: boolean;
  readonly createdAt: EpochMs;
}

/** Editable project fields. */
export interface ProjectPatch {
  readonly name?: string;
  readonly exclusions?: readonly string[];
  readonly providerPolicy?: ProviderPolicy;
  readonly monthlyAllowanceMicrousd?: Microusd | null;
}

/** Dashboard counters for `projects.get` (02 `projectDetailSchema.stats`). */
export interface ProjectStats {
  readonly runs: number;
  readonly activeRunId: RunId | null;
  readonly approvedMemory: number;
  readonly suggestions: number;
  /** Settled µUSD of the project's run entries created at or after `monthStart`. */
  readonly trackedMonthMicrousd: Microusd;
}

export interface ProjectRepo {
  insert(p: ProjectInsert): ProjectRow;
  /** @throws RelayError NOT_FOUND */
  get(id: ProjectId): ProjectRow;
  find(id: ProjectId): ProjectRow | undefined;
  /** Runner-internal; includes the realpath. @throws RelayError NOT_FOUND */
  getWithRoot(id: ProjectId): ProjectWithRoot;
  list(opts?: { readonly includeArchived?: boolean }): readonly ProjectRow[];
  /** The non-archived project registered at `rootRealpath` (one statement on `projects_root_active_uq`), if any. */
  findActiveByRoot(rootRealpath: string): ProjectRow | undefined;
  /**
   * Optimistic concurrency on `updated_at`: CONFLICT when `expectedUpdatedAt` does not match, or when the project is
   * archived (archived projects are read-only); NOT_FOUND when it does not exist.
   */
  update(id: ProjectId, patch: ProjectPatch, expectedUpdatedAt: EpochMs): Result<ProjectRow>;
  /** Sets `archived_at`; `updated_at` strictly increases (so a stale `update` CAS conflicts). False if absent/archived. */
  archive(id: ProjectId): boolean;
  stats(id: ProjectId, monthStart: EpochMs): ProjectStats;
}

export interface SettingsRepo {
  /** Parsed JSON value, or undefined when the key is absent. */
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** §12.2 credential reference plus the last connection test (no raw credential, ever). */
export interface CredentialRefRow extends Readonly<CredentialRef> {
  readonly lastTest: { readonly at: EpochMs; readonly ok: boolean; readonly code: string | null } | null;
}

export interface CredentialRefUpsert {
  readonly id: CredentialRefId;
  readonly providerId: ProviderId;
  readonly storageMode: CredentialStorageMode;
  readonly vaultFile: string | null;
  readonly redactedLabel: string;
}

export interface CredentialRefRepo {
  /** One active ref per provider: an existing row for the provider is replaced (its id and createdAt are kept). */
  upsert(ref: CredentialRefUpsert): CredentialRefRow;
  get(providerId: ProviderId): CredentialRefRow | undefined;
  list(): readonly CredentialRefRow[];
  delete(providerId: ProviderId): boolean;
  recordTest(providerId: ProviderId, ok: boolean, code: ErrorCode | null, at: EpochMs): boolean;
}

// ---------------------------------------------------------------- catalog & profiles

export type CatalogRow = Readonly<CatalogModel>;

export interface CatalogRepo {
  /** Inserts entries keyed by (provider, model, catalogVersion); existing versions are never edited. Returns inserted count. */
  upsertMany(entries: readonly CatalogModel[]): number;
  /** The given version, or the latest version when `version` is absent. */
  get(providerId: ProviderId, modelId: string, version?: string): CatalogRow | undefined;
  /** The latest catalog version of every model (optionally for one provider), ordered by provider then model. */
  list(providerId?: ProviderId): readonly CatalogRow[];
  latestVersion(): string | null;
}

/** Profile row: the contracts profile plus the capability snapshot and catalog version it was validated against. */
export interface ProfileRow extends Readonly<ModelProfile> {
  readonly capabilitiesSnapshot: ModelCapabilities;
  readonly catalogVersion: string;
  readonly createdAt: EpochMs;
}

export interface ProfileUpsert {
  readonly id: ProfileId;
  readonly name: string;
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly params: ModelParams;
  readonly capabilitiesSnapshot: ModelCapabilities;
  readonly catalogVersion: string;
}

export interface ProfileRepo {
  list(): readonly ProfileRow[];
  get(id: ProfileId): ProfileRow | undefined;
  getByName(name: string): ProfileRow | undefined;
  /**
   * Creates (revision 1) or updates (revision + 1) a profile. `expectedRevision` → CONFLICT on mismatch,
   * NOT_FOUND when the profile does not exist. A duplicate name → CONFLICT.
   */
  upsert(p: ProfileUpsert, expectedRevision?: number): Result<ProfileRow>;
  delete(id: ProfileId): boolean;
}

// ---------------------------------------------------------------- workflows

export interface WorkflowRow {
  readonly id: WorkflowId;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: EpochMs;
}

export type WorkflowVersionStatus = 'draft' | 'validated';

export interface WorkflowVersionRow {
  readonly id: WorkflowVersionId;
  readonly workflowId: WorkflowId;
  readonly version: number;
  readonly status: WorkflowVersionStatus;
  readonly draftRevision: number;
  readonly schemaVersion: number;
  readonly spec: WorkflowSpec;
  /** Exact prompt text snapshot keyed by instruction version (`{ "reviewer.v1": "…" }`). */
  readonly prompts: Readonly<Record<string, string>>;
  readonly contentHash: Sha256;
  readonly basedOnVersion: number | null;
  readonly createdAt: EpochMs;
  readonly validatedAt: EpochMs | null;
}

export interface WorkflowVersionInsert {
  readonly id: WorkflowVersionId;
  readonly workflowId: WorkflowId;
  readonly version: number;
  readonly status: WorkflowVersionStatus;
  readonly schemaVersion: number;
  readonly spec: WorkflowSpec;
  readonly prompts: Readonly<Record<string, string>>;
  readonly contentHash: Sha256;
  readonly basedOnVersion: number | null;
  readonly createdAt: EpochMs;
  readonly validatedAt?: EpochMs | null;
}

export interface WorkflowDraftPatch {
  readonly spec?: WorkflowSpec;
  readonly prompts?: Readonly<Record<string, string>>;
  readonly contentHash: Sha256;
}

/** One `workflows.list` row: the workflow with its latest validated and draft version numbers. */
export interface WorkflowSummaryRow {
  readonly id: WorkflowId;
  readonly name: string;
  readonly latestValidatedVersion: number | null;
  readonly draftVersion: number | null;
}

export interface WorkflowRepo {
  /** Returns the workflow with `slug`, inserting it when absent. */
  ensureWorkflow(slug: string, name: string): WorkflowRow;
  getWorkflow(id: WorkflowId): WorkflowRow | undefined;
  listWorkflows(): readonly WorkflowRow[];
  /** {@link listWorkflows} (same order) with each latest validated / draft version number, in one statement. */
  listSummaries(): readonly WorkflowSummaryRow[];
  getVersion(workflowId: WorkflowId, version: number | 'draft'): WorkflowVersionRow | undefined;
  getVersionById(id: WorkflowVersionId): WorkflowVersionRow | undefined;
  latestValidated(workflowId: WorkflowId): WorkflowVersionRow | undefined;
  /** Every version of the workflow (validated + draft), ascending by version. */
  listVersions(workflowId: WorkflowId): readonly WorkflowVersionRow[];
  insertVersion(v: WorkflowVersionInsert): WorkflowVersionRow;
  /** CAS on `draft_revision`; CONFLICT on mismatch, NOT_FOUND when there is no draft. Bumps `draft_revision`. */
  updateDraft(workflowId: WorkflowId, patch: WorkflowDraftPatch, expectedDraftRevision: number): Result<WorkflowVersionRow>;
  /** draft → validated (CAS on status). Validated versions are immutable (trigger). */
  markValidated(id: WorkflowVersionId, at: EpochMs): boolean;
}

// ---------------------------------------------------------------- runs

/** Why a run's effective profile for a step changed (§4.3). */
export const CONFIG_REVISION_REASONS = ['budget_cheaper_profile', 'model_refused', 'user_switch'] as const;
export type ConfigRevisionReason = (typeof CONFIG_REVISION_REASONS)[number];

export interface ConfigRevisionRow {
  readonly runId: RunId;
  readonly revision: number;
  readonly stepKey: StepKey;
  readonly previousProfile: ProfileSnapshot;
  readonly profileSnapshot: ProfileSnapshot;
  readonly reason: ConfigRevisionReason;
  readonly createdAt: EpochMs;
}

export interface ConfigRevisionRepo {
  /** Appends revision `max + 1` for the run (call inside a tx). */
  append(runId: RunId, stepKey: StepKey, prev: ProfileSnapshot, next: ProfileSnapshot, reason: ConfigRevisionReason): ConfigRevisionRow;
  /** Latest revised profile for the step, or null (the caller then falls back to `runs.snapshot_json`). */
  effectiveProfile(runId: RunId, stepKey: StepKey): ProfileSnapshot | null;
  list(runId: RunId): readonly ConfigRevisionRow[];
}

export interface RunRow {
  readonly id: RunId;
  readonly projectId: ProjectId;
  readonly workflowVersionId: WorkflowVersionId;
  readonly goal: string;
  readonly status: RunStatus;
  readonly pauseReason: PauseReason | null;
  readonly statusDetail: AppError | null;
  readonly input: RunInput;
  /** FR-03 snapshot (profiles + capabilities + catalog version per step). Shape owned and parsed by the engine. */
  readonly snapshot: unknown;
  readonly limits: RunLimits;
  readonly contextHash: Sha256 | null;
  readonly revisionCycle: number;
  readonly attemptCount: number;
  readonly executionMsUsed: number;
  readonly runningSince: EpochMs | null;
  readonly pauseRequested: boolean;
  /**
   * 06 F2 clarification 14: a pause a reconciled outcome requires (an overrun, a scope change) while the run could not
   * take it. Durable until the user resolves that pause; every resume path applies it instead of continuing.
   */
  readonly deferredPause: DeferredPause | null;
  readonly idempotencyKey: string;
  readonly createdAt: EpochMs;
  readonly startedAt: EpochMs | null;
  readonly endedAt: EpochMs | null;
  readonly updatedAt: EpochMs;
}

/** Pause reasons a reconciled outcome can defer (06 F2 clarification 14). */
export const DEFERRED_PAUSE_REASONS = ['budget_overrun', 'approval_stale'] as const;
export type DeferredPauseReason = (typeof DEFERRED_PAUSE_REASONS)[number];

/** `runs.deferred_pause` + `deferred_pause_detail_json`. */
export interface DeferredPause {
  readonly reason: DeferredPauseReason;
  readonly detail: AppError;
}

export interface RunInsert {
  readonly id: RunId;
  readonly projectId: ProjectId;
  readonly workflowVersionId: WorkflowVersionId;
  readonly goal: string;
  readonly status?: RunStatus;
  readonly input: RunInput;
  readonly snapshot: unknown;
  readonly limits: RunLimits;
  readonly idempotencyKey: string;
  readonly contextHash?: Sha256 | null;
  readonly createdAt: EpochMs;
}

/**
 * Extra columns written by {@link RunRepo.updateStatus}. `pauseReason` is required when `to = 'paused'` and is
 * written as NULL for every other `to` (the `pause_reason` CHECK). When `to` is only known as `RunStatus`, a
 * nullable reason is accepted and checked at runtime.
 */
export type RunStatusFields<To extends RunStatus> = {
  readonly statusDetail?: AppError | null | undefined;
  /** Defaults to now for a terminal `to`; always NULL otherwise. */
  readonly endedAt?: EpochMs | null | undefined;
  /** Written only when provided (first transition to running). */
  readonly startedAt?: EpochMs | undefined;
} & ([To] extends ['paused']
  ? { readonly pauseReason: PauseReason }
  : RunStatus extends To
    ? { readonly pauseReason?: PauseReason | null | undefined }
    : { readonly pauseReason?: null | undefined });

export interface RunListQuery extends PageRequest {
  readonly projectId: ProjectId;
  readonly statuses?: readonly RunStatus[] | undefined;
}

export interface RunInputFile {
  readonly relPath: RelPath;
  readonly sha256: Sha256;
  readonly artifactId: ArtifactId;
  readonly sizeBytes: number;
  readonly capturedAt: EpochMs;
}

/** A run's ledger aggregates, from ONE statement (`RUN_COSTS_SQL`). */
export interface RunCosts {
  readonly balances: Balances;
  readonly settledByCertainty: Readonly<Record<CostCertainty, Microusd>>;
  /** Some attempt settled more than it reserved (§9.5), from the same ledger statement as the balances. */
  readonly attemptsOverran: boolean;
}

/** The workflow a run was started from. */
export interface RunWorkflowRef {
  readonly id: WorkflowId;
  readonly name: string;
  readonly version: number;
}

/** Everything the run inspector needs, fetched with a fixed number of statements (no N+1). */
export interface InspectorProjection extends RunCosts {
  readonly run: RunRow;
  readonly workflow: RunWorkflowRef;
  readonly steps: readonly StepRow[];
  readonly attempts: readonly AttemptRow[];
  readonly pendingApproval: ApprovalRow | null;
  readonly reportArtifactId: ArtifactId | null;
}

/**
 * One `runs.list` row (the RunSummary inputs): the run, its workflow, the latest-row step progress, and the ledger
 * aggregates. Built for a whole page at once ({@link RunRepo.listSummaries}), never per run.
 */
export interface RunSummaryProjection extends RunCosts {
  readonly run: RunRow;
  readonly workflow: RunWorkflowRef;
  /** Over the latest row per step key: `done` = succeeded or skipped. */
  readonly stepProgress: { readonly done: number; readonly total: number };
}

export interface RunRepo {
  insert(run: RunInsert): RunRow;
  /** @throws RelayError NOT_FOUND */
  get(id: RunId): RunRow;
  find(id: RunId): RunRow | undefined;
  /** Keyset pagination on (created_at, id). A cursor from another sort → VALIDATION_FAILED. */
  list(q: RunListQuery): Result<Page<RunRow>>;
  /** Compare-and-set: `UPDATE … WHERE id = ? AND status IN (from)`. Returns whether the row changed. */
  updateStatus<To extends RunStatus>(id: RunId, from: readonly RunStatus[], to: To, fields: RunStatusFields<To>): boolean;
  nextQueued(): RunRow | undefined;
  listActive(): readonly RunRow[];
  /** Terminal runs (completed / incomplete / cancelled / failed) with no `report` artifact row (06 F17 crash-safety), oldest first. */
  listTerminalWithoutReport(): readonly RunRow[];
  incrementAttemptCount(id: RunId): void;
  setRevisionCycle(id: RunId, cycle: number): void;
  /** Sets (or clears with null) the durable deferred pause (06 F2 clarification 14). */
  setDeferredPause(id: RunId, pause: DeferredPause | null): void;
  setPauseRequested(id: RunId, requested: boolean): void;
  setContextHash(id: RunId, hash: Sha256): void;
  /** Overwrites the run limits (user `raise_limits`, 06). */
  setLimits(id: RunId, limits: RunLimits): void;
  /** Starts a running segment (`running_since = now`); no-op if one is open. */
  enterRunning(id: RunId, now: EpochMs): void;
  /** Adds `now − running_since` to `execution_ms_used` and clears `running_since`; no-op if none is open. */
  leaveRunning(id: RunId, now: EpochMs): void;
  insertInputFiles(runId: RunId, files: readonly RunInputFile[]): void;
  /**
   * Replaces the run's input-file set atomically (delete + insert in one tx; joins an open tx): `resnapshot_and_replan`
   * after the project changed (06 F10). Each `artifactId` must reference an existing `input_file` artifact (FK).
   */
  replaceInputFiles(runId: RunId, files: readonly RunInputFile[]): void;
  inputFiles(runId: RunId): readonly RunInputFile[];
  /** ≤ 6 statements. @throws RelayError NOT_FOUND */
  getInspectorProjection(runId: RunId): InspectorProjection;
  /** {@link list} with each row's summary aggregates: 4 statements per page whatever its size (no per-run projection). */
  listSummaries(q: RunListQuery): Result<Page<RunSummaryProjection>>;
  /** The summaries of `ids` in the given order (unknown ids are left out): 3 statements whatever the count. */
  summariesOf(ids: readonly RunId[]): readonly RunSummaryProjection[];
  /** Every run id of the project, oldest first (`created_at, id`), in one statement. */
  idsForProject(projectId: ProjectId): readonly RunId[];
  /** Every `paused` run of the project with `pauseReason`, newest first (= `list`'s default), in one statement (no page limit). */
  listPausedFor(projectId: ProjectId, pauseReason: PauseReason): readonly RunRow[];
}

// ---------------------------------------------------------------- steps

export interface StepRow {
  readonly id: StepRunId;
  readonly runId: RunId;
  readonly stepKey: StepKey;
  readonly ordinal: number;
  readonly revisionIndex: number;
  readonly retryIndex: number;
  readonly state: StepState;
  readonly profileName: string | null;
  readonly inputArtifactIds: readonly ArtifactId[];
  readonly outputArtifactId: ArtifactId | null;
  readonly outcome: string | null;
  readonly schemaRepairsUsed: number;
  readonly transportRetriesUsed: number;
  readonly rateLimitWaitsUsed: number;
  readonly notBeforeAt: EpochMs | null;
  readonly error: AppError | null;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
}

export interface StepInsert {
  readonly id: StepRunId;
  readonly runId: RunId;
  readonly stepKey: StepKey;
  readonly ordinal: number;
  readonly revisionIndex?: number;
  readonly state: StepState;
  readonly profileName?: string | null;
  readonly inputArtifactIds?: readonly ArtifactId[];
  readonly createdAt: EpochMs;
}

export interface StepRetryFields {
  readonly id: StepRunId;
  readonly state: StepState;
  readonly profileName?: string | null;
  readonly inputArtifactIds?: readonly ArtifactId[];
  readonly createdAt: EpochMs;
}

/** Columns a step transition may write. Absent keys keep their value; `null` clears a nullable column. */
export interface StepTransitionFields {
  readonly profileName?: string | null | undefined;
  readonly inputArtifactIds?: readonly ArtifactId[] | undefined;
  readonly outputArtifactId?: ArtifactId | null | undefined;
  readonly outcome?: string | null | undefined;
  readonly schemaRepairsUsed?: number | undefined;
  readonly transportRetriesUsed?: number | undefined;
  readonly rateLimitWaitsUsed?: number | undefined;
  readonly notBeforeAt?: EpochMs | null | undefined;
  readonly error?: AppError | null | undefined;
}

export interface StepRepo {
  insertMany(steps: readonly StepInsert[]): readonly StepRow[];
  /** New row with the same run, key, revision, and ordinal; `retry_index + 1`; fresh counters. */
  insertRetry(prev: StepRow, fields: StepRetryFields): StepRow;
  /** @throws RelayError NOT_FOUND */
  get(id: StepRunId): StepRow;
  find(id: StepRunId): StepRow | undefined;
  listForRun(runId: RunId): readonly StepRow[];
  /** One row per step key: the max (revision_index, retry_index). Ordered by ordinal. */
  latestPerStepKey(runId: RunId): readonly StepRow[];
  latestFor(runId: RunId, stepKey: StepKey): StepRow | undefined;
  setNotBefore(id: StepRunId, at: EpochMs | null): void;
  /** CAS on state. Returns whether the row changed. */
  transition(id: StepRunId, from: readonly StepState[], to: StepState, fields: StepTransitionFields): boolean;
}

// ---------------------------------------------------------------- attempts

export interface AttemptRow {
  readonly id: AttemptId;
  readonly runId: RunId;
  readonly stepRunId: StepRunId;
  readonly seq: number;
  readonly purpose: AttemptPurpose;
  readonly retryOfAttemptId: AttemptId | null;
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly profileSnapshot: ProfileSnapshot;
  readonly requestFingerprint: string;
  readonly state: AttemptState;
  readonly reservationMicrousd: Microusd;
  /** UsageEstimate (04); shape owned by providers/engine. */
  readonly estimate: unknown;
  readonly providerRequestId: string | null;
  readonly providerResponseId: string | null;
  readonly usage: UsageView | null;
  /** Redacted original usage payload (§8.4). */
  readonly rawUsage: unknown;
  readonly priceCatalogVersion: string;
  readonly stopReason: string | null;
  readonly error: AppError | null;
  readonly createdAt: EpochMs;
  readonly dispatchedAt: EpochMs | null;
  readonly firstByteAt: EpochMs | null;
  readonly finishedAt: EpochMs | null;
}

export interface AttemptInsert {
  readonly id: AttemptId;
  readonly runId: RunId;
  readonly stepRunId: StepRunId;
  readonly seq: number;
  readonly purpose: AttemptPurpose;
  readonly retryOfAttemptId?: AttemptId | null | undefined;
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly profileSnapshot: ProfileSnapshot;
  readonly requestFingerprint: string;
  readonly state: AttemptState;
  readonly reservationMicrousd: number;
  readonly estimate?: unknown;
  readonly priceCatalogVersion: string;
  readonly createdAt: EpochMs;
}

/** Columns an attempt transition may write. Absent keys keep their value. Provider ids are write-once. */
export interface AttemptTransitionFields {
  readonly dispatchedAt?: EpochMs | null | undefined;
  readonly firstByteAt?: EpochMs | null | undefined;
  readonly finishedAt?: EpochMs | null | undefined;
  readonly usage?: UsageView | null | undefined;
  readonly rawUsage?: unknown;
  readonly stopReason?: string | null | undefined;
  readonly error?: AppError | null | undefined;
  readonly providerRequestId?: string | null | undefined;
  readonly providerResponseId?: string | null | undefined;
}

export interface AttemptRepo {
  insert(a: AttemptInsert): AttemptRow;
  /** @throws RelayError NOT_FOUND */
  get(id: AttemptId): AttemptRow;
  find(id: AttemptId): AttemptRow | undefined;
  transition(id: AttemptId, from: readonly AttemptState[], to: AttemptState, fields: AttemptTransitionFields): boolean;
  listForStep(stepRunId: StepRunId): readonly AttemptRow[];
  listForRun(runId: RunId): readonly AttemptRow[];
  /** Number of the run's attempts in `state` (one COUNT, no row is loaded or parsed). */
  countInState(runId: RunId, state: AttemptState): number;
  /** Attempts in created/reserved/dispatching/unknown, optionally for one run. */
  listUnresolved(runId?: RunId): readonly AttemptRow[];
  /** Write-once per column (COALESCE): never overwrites an id, can still fill the other one. */
  setProviderIds(id: AttemptId, ids: { readonly requestId?: string | null | undefined; readonly responseId?: string | null | undefined }): void;
  nextSeq(stepRunId: StepRunId): number;
}

// ---------------------------------------------------------------- ledger

export interface LedgerEntryRow {
  readonly id: LedgerEntryId;
  readonly scope: LedgerScope;
  readonly runId: RunId | null;
  readonly projectId: ProjectId | null;
  readonly attemptId: AttemptId | null;
  readonly type: LedgerEntryType;
  readonly bucket: LedgerBucket;
  readonly deltaMicrousd: Microusd;
  readonly certainty: CostCertainty | null;
  readonly priceCatalogVersion: string | null;
  readonly groupId: string;
  readonly note: string | null;
  readonly createdAt: EpochMs;
}

export interface LedgerEntryInsert {
  readonly scope: LedgerScope;
  readonly type: LedgerEntryType;
  readonly bucket: LedgerBucket;
  /** Signed safe-integer µUSD. */
  readonly deltaMicrousd: number;
  readonly runId?: RunId | null | undefined;
  readonly projectId?: ProjectId | null | undefined;
  readonly attemptId?: AttemptId | null | undefined;
  readonly certainty?: CostCertainty | null | undefined;
  readonly priceCatalogVersion?: string | null | undefined;
  readonly note?: string | null | undefined;
  /** Defaults to the injected clock. */
  readonly createdAt?: EpochMs | undefined;
}

/** Month balances: settled in the window, reserved and unknown outstanding regardless of date (§9.3). */
export interface WindowBalances {
  readonly C: Microusd;
  readonly R: Microusd;
  readonly U: Microusd;
}

export interface AttemptBalances {
  readonly reserved: Microusd;
  readonly unknown: Microusd;
  readonly settled: Microusd;
}

/** A ledger entry with the step key of its attempt (null for an entry without attempt). */
export interface LedgerEntryWithStep {
  readonly entry: LedgerEntryRow;
  readonly stepKey: StepKey | null;
}

export interface LedgerRepo {
  /** Appends entries sharing one fresh `group_id` (atomic moves). */
  append(entries: readonly LedgerEntryInsert[]): readonly LedgerEntryRow[];
  runBalances(runId: RunId): Balances;
  /** Balances + settled by certainty + the §9.5 overrun flag of a run, in ONE statement. */
  runCosts(runId: RunId): RunCosts;
  /** Every entry of the run, oldest first (`created_at, id`), with its attempt's step key, in one statement. */
  listForRun(runId: RunId): readonly LedgerEntryWithStep[];
  /**
   * Every run-scope entry of the project created in `[startMs, endMs)`, oldest first (`created_at, id`), with its
   * attempt's step key, in one statement (`ledger.exportTo` for a project month).
   */
  listForProjectWindow(projectId: ProjectId, startMs: EpochMs, endMs: EpochMs): readonly LedgerEntryWithStep[];
  projectMonthBalances(projectId: ProjectId, monthStartMs: EpochMs, monthEndMs: EpochMs): WindowBalances;
  setupBalances(monthStartMs: EpochMs, monthEndMs: EpochMs): WindowBalances;
  attemptBalances(attemptId: AttemptId): AttemptBalances;
  list(runId: RunId, page: PageRequest): Result<Page<LedgerEntryRow>>;
  /** `runCosts(runId).settledByCertainty`. */
  settledByCertainty(runId: RunId): Readonly<Record<CostCertainty, Microusd>>;
  /** Some attempt of the run settled more than it reserved (§9.5 overrun): `runCosts(runId).attemptsOverran`. */
  attemptsOverran(runId: RunId): boolean;
}

// ---------------------------------------------------------------- artifacts

export interface ArtifactRow {
  readonly id: ArtifactId;
  readonly runId: RunId | null;
  readonly projectId: ProjectId;
  readonly stepRunId: StepRunId | null;
  readonly attemptId: AttemptId | null;
  readonly kind: ArtifactKind;
  /** 'artifacts/<run|project>/<artifactId>' relative to userData. */
  readonly relPath: string;
  readonly sha256: Sha256;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly schemaId: string | null;
  readonly purgedAt: EpochMs | null;
  readonly createdAt: EpochMs;
}

export interface ArtifactInsert {
  readonly id: ArtifactId;
  readonly runId?: RunId | null | undefined;
  readonly projectId: ProjectId;
  readonly stepRunId?: StepRunId | null | undefined;
  readonly attemptId?: AttemptId | null | undefined;
  readonly kind: ArtifactKind;
  readonly relPath: string;
  readonly sha256: Sha256;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly schemaId?: string | null | undefined;
  readonly createdAt: EpochMs;
}

export interface ArtifactFilter {
  readonly kinds?: readonly ArtifactKind[];
  readonly projectId?: ProjectId;
  readonly createdBefore?: EpochMs;
  /** Only rows whose file has not been purged. */
  readonly unpurgedOnly?: boolean;
}

export interface ArtifactRepo {
  /**
   * Idempotent (§7.5): on an (attempt, kind, sha256) or per-run input_file conflict returns the existing row; a replay
   * with the same id and the same sha256/kind/rel_path returns that row.
   * @throws RelayError CONFLICT when the id exists with different sha256/kind/rel_path, or rel_path holds other content.
   */
  insertIfAbsent(meta: ArtifactInsert): ArtifactRow;
  findInputFile(runId: RunId, sha256: Sha256): ArtifactRow | undefined;
  get(id: ArtifactId): ArtifactRow | undefined;
  listForRun(runId: RunId, kinds?: readonly ArtifactKind[]): readonly ArtifactRow[];
  /** Rows of runs of a project and/or matching kinds (retention, purge, backup). */
  listWhere(filter: ArtifactFilter): readonly ArtifactRow[];
  /** Sets `purged_at` once (the immutability trigger allows it). */
  markPurged(id: ArtifactId, at: EpochMs): boolean;
}

// ---------------------------------------------------------------- approvals

export interface ApprovalRow {
  readonly id: ApprovalId;
  readonly runId: RunId;
  readonly stepRunId: StepRunId;
  readonly planArtifactId: ArtifactId;
  readonly planHash: Sha256;
  readonly contextHash: Sha256;
  readonly fileScope: readonly RelPath[];
  readonly requestedPermissions: unknown;
  readonly decision: ApprovalDecision | null;
  readonly decisionNote: string | null;
  readonly decidedAt: EpochMs | null;
  readonly invalidatedAt: EpochMs | null;
  readonly invalidatedReason: ApprovalStaleReason | null;
  readonly createdAt: EpochMs;
}

export interface ApprovalInsert {
  readonly id: ApprovalId;
  readonly runId: RunId;
  readonly stepRunId: StepRunId;
  readonly planArtifactId: ArtifactId;
  readonly planHash: Sha256;
  readonly contextHash: Sha256;
  readonly fileScope: readonly RelPath[];
  readonly requestedPermissions: unknown;
  readonly createdAt: EpochMs;
}

export interface ApprovalRepo {
  insert(a: ApprovalInsert): ApprovalRow;
  get(id: ApprovalId): ApprovalRow | undefined;
  /** Every approval of the run, oldest first (06 F17 report). */
  listForRun(runId: RunId): readonly ApprovalRow[];
  /** Latest undecided, not-invalidated approval of the run. */
  pendingForRun(runId: RunId): ApprovalRow | undefined;
  /** Latest approved, not-invalidated approval of the run. */
  latestApprovedForRun(runId: RunId): ApprovalRow | undefined;
  /** CAS `WHERE decision IS NULL AND invalidated_at IS NULL`. */
  decide(id: ApprovalId, decision: ApprovalDecision, note: string | null, at: EpochMs): boolean;
  invalidate(id: ApprovalId, reason: ApprovalStaleReason, at: EpochMs): boolean;
}

// ---------------------------------------------------------------- memory

export interface MemoryRecordRow {
  readonly id: MemoryId;
  readonly projectId: ProjectId;
  readonly type: MemoryType;
  readonly status: MemoryStatus;
  readonly currentRevision: number;
  readonly scope: MemoryRecordScope;
  readonly pinned: boolean;
  readonly expiresAt: EpochMs | null;
  readonly reviewAt: EpochMs | null;
  readonly supersededById: MemoryId | null;
  readonly sourceRunId: RunId | null;
  readonly proposal: unknown;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
  readonly deletedAt: EpochMs | null;
}

export interface MemoryRevisionRow {
  readonly id: MemoryRevisionId;
  readonly recordId: MemoryId;
  readonly revision: number;
  readonly title: string;
  readonly content: string;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly author: string;
  readonly createdAt: EpochMs;
}

export interface MemoryEventRow {
  readonly id: string;
  readonly recordId: MemoryId;
  readonly event: MemoryEventType;
  readonly revision: number;
  readonly actor: string;
  readonly detail: unknown;
  readonly createdAt: EpochMs;
}

/** A record with its current revision. */
export interface MemoryItem {
  readonly record: MemoryRecordRow;
  readonly current: MemoryRevisionRow;
}

export interface MemoryRecordInsert {
  readonly id: MemoryId;
  readonly projectId: ProjectId;
  readonly type: MemoryType;
  readonly status: MemoryStatus;
  readonly scope: MemoryRecordScope;
  readonly pinned?: boolean;
  readonly expiresAt?: EpochMs | null;
  readonly reviewAt?: EpochMs | null;
  readonly sourceRunId?: RunId | null;
  readonly proposal?: unknown;
  readonly createdAt: EpochMs;
}

export interface MemoryRevisionInsert {
  readonly id: MemoryRevisionId;
  readonly title: string;
  readonly content: string;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly author: string;
  readonly createdAt: EpochMs;
}

export interface MemoryEventInsert {
  readonly recordId: MemoryId;
  readonly event: MemoryEventType;
  readonly revision: number;
  readonly actor: string;
  readonly detail?: unknown;
  readonly createdAt: EpochMs;
}

/** `projectId` is required at the type level (§10.5 project isolation). */
export interface MemoryListQuery {
  readonly projectId: ProjectId;
  readonly statuses?: readonly MemoryStatus[] | undefined;
  readonly types?: readonly MemoryType[] | undefined;
  /** Case-insensitive substring over the current title and content. */
  readonly query?: string | undefined;
  /** Only records proposed by this run (`source_run_id`). */
  readonly sourceRunId?: RunId | undefined;
}

/** Attribute patch for {@link MemoryRepo.setAttributes}. */
export interface MemoryAttributesPatch {
  readonly scope?: MemoryRecordScope | undefined;
  readonly pinned?: boolean | undefined;
  readonly expiresAt?: EpochMs | null | undefined;
  readonly reviewAt?: EpochMs | null | undefined;
}

/**
 * One record of a run's memory snapshot: the revision text AND the record attributes (type, pinned, role scope) as
 * they were at intake. Context assembly and the manifest read every attribute from here, never from the live record.
 */
export interface RunMemorySnapshotRow {
  readonly runId: RunId;
  readonly recordId: MemoryId;
  readonly revision: number;
  readonly title: string;
  readonly content: string;
  readonly type: MemoryType;
  readonly pinned: boolean;
  readonly scope: MemoryRecordScope;
  readonly included: boolean;
}

export interface MemoryRepo {
  insertRecord(rec: MemoryRecordInsert, rev: MemoryRevisionInsert): MemoryItem;
  get(id: MemoryId): MemoryItem | undefined;
  getWithRevisions(
    id: MemoryId,
  ): { readonly item: MemoryItem; readonly revisions: readonly MemoryRevisionRow[]; readonly events: readonly MemoryEventRow[] } | undefined;
  list(q: MemoryListQuery): readonly MemoryItem[];
  /** approved ∧ not expired ∧ not deleted ∧ (scope all ∨ role ∈ roles), for one project. */
  retrievable(projectId: ProjectId, role: Role, now: EpochMs): readonly MemoryItem[];
  /** CAS on `current_revision` (call inside a tx). CONFLICT on mismatch. */
  addRevision(recordId: MemoryId, rev: MemoryRevisionInsert, expectedRevision: number): Result<MemoryRevisionRow>;
  /** CAS on status. `deleted` also sets `deleted_at`. */
  setStatus(id: MemoryId, from: readonly MemoryStatus[], to: MemoryStatus, at: EpochMs): boolean;
  setSupersededBy(id: MemoryId, supersededById: MemoryId | null, at: EpochMs): void;
  /** Updates the non-revisioned attributes (07 G5 `memory.update` / approve / keepBothWithScopes); absent keys are kept. */
  setAttributes(id: MemoryId, patch: MemoryAttributesPatch, at: EpochMs): void;
  /** Number of run snapshots that hold a copy of the record (`memory.delete` → `retainedInRunSnapshots`). */
  countRunSnapshots(recordId: MemoryId): number;
  recordEvent(e: MemoryEventInsert): MemoryEventRow;
  snapshotForRun(runId: RunId, rows: readonly Omit<RunMemorySnapshotRow, 'runId'>[]): void;
  runSnapshot(runId: RunId): readonly RunMemorySnapshotRow[];
  /** Deletes the snapshot rows of the project's runs; returns the count and the affected record ids. */
  purgeRunSnapshots(projectId: ProjectId): { readonly deleted: number; readonly recordIds: readonly MemoryId[] };
}

// ---------------------------------------------------------------- events, idempotency, lease

/** Payload `kind`s {@link EventRepo.snapshotBinding} looks for (engine constants; repos hold no engine rules). */
export interface SnapshotBindingKinds {
  /** `context.assembled { kind }` recorded by an input re-snapshot. */
  readonly resnapshot: string;
  /** `error.recorded { kind, approvalId }` recorded when an approval was invalidated by a project change. */
  readonly approvalInvalidated: string;
}

/** The run-event facts of a run's input-snapshot binding (06 F6 / B4), read in one statement. */
export interface SnapshotBinding {
  /** Seq of the latest re-snapshot event (0 when none). */
  readonly resnapshotSeq: number;
  /** Seq of the latest `run.snapshot_preserved` (0 when none). */
  readonly preservedSeq: number;
  /** The latest approval-invalidation event: its seq and payload `approvalId` (null when not a string), or null. */
  readonly invalidation: { readonly seq: number; readonly approvalId: string | null } | null;
}

export interface EventRepo {
  /** seq = COALESCE(MAX(seq), 0) + 1 in the same statement. Payload must already be redacted. */
  append(runId: RunId, type: RunEventType, payload: object): RunEvent;
  list(runId: RunId, afterSeq: number, limit: number): readonly RunEvent[];
  lastSeq(runId: RunId): number;
  /** One statement of scalar subqueries on `run_events_type_idx` (no scan of the run's whole log). */
  snapshotBinding(runId: RunId, kinds: SnapshotBindingKinds): SnapshotBinding;
  /** Events of the run whose payload names `stepRunId` or one of `attemptIds` (`runs.getStep`), by seq. */
  listForStep(runId: RunId, stepRunId: StepRunId, attemptIds: readonly AttemptId[]): readonly RunEvent[];
}

/** Small idempotent-replay result: ids + status, never a DTO (R4-30; ≤ 2048 bytes). */
export interface IdempotentResult {
  readonly ids: Readonly<Record<string, string>>;
  readonly status?: string;
}

export interface IdempotencyRecord {
  readonly requestHash: string;
  readonly result: IdempotentResult;
  readonly createdAt: EpochMs;
}

export interface IdempotencyRepo {
  /** The stored record, or undefined when the key is new or its row is older than `IDEMPOTENCY_TTL_MS` (02 §B0). */
  get(op: string, key: string): IdempotencyRecord | undefined;
  /**
   * Stores the result, or replays the stored one for the same key + hash. Same key + different hash → CONFLICT.
   * @throws RelayError VALIDATION_FAILED when the serialized result exceeds 2048 bytes.
   */
  put(op: string, key: string, requestHash: string, result: IdempotentResult): Result<IdempotentResult>;
  /** Deletes rows created before `olderThan`; returns how many. */
  sweep(olderThan: EpochMs): number;
}

export type LeaseAcquireResult = 'acquired' | 'held_by_other';

export interface LeaseRepo {
  /** §6.4 rules (03 §C6 "Lease semantics"); runs in one BEGIN IMMEDIATE tx. */
  acquire(ownerId: string, pid: number, now: EpochMs, staleAfterMs: number): LeaseAcquireResult;
  heartbeat(ownerId: string, now: EpochMs): boolean;
  release(ownerId: string): boolean;
  /** True when `ownerId` holds the lease row now (a stale takeover replaced it otherwise). */
  isHeldBy(ownerId: string): boolean;
}

// ---------------------------------------------------------------- aggregate

export interface Repos {
  readonly projects: ProjectRepo;
  readonly settings: SettingsRepo;
  readonly credentials: CredentialRefRepo;
  readonly catalog: CatalogRepo;
  readonly profiles: ProfileRepo;
  readonly workflows: WorkflowRepo;
  readonly configRevisions: ConfigRevisionRepo;
  readonly runs: RunRepo;
  readonly steps: StepRepo;
  readonly attempts: AttemptRepo;
  readonly ledger: LedgerRepo;
  readonly artifacts: ArtifactRepo;
  readonly approvals: ApprovalRepo;
  readonly memory: MemoryRepo;
  readonly events: EventRepo;
  readonly idempotency: IdempotencyRepo;
  readonly lease: LeaseRepo;
}

/** Makes an async (Promise-returning) tx callback a type error (§7.4, gate 00b §2.5). */
export type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

export interface Db {
  /** Read access outside a transaction (autocommit). */
  readonly repos: Repos;
  /** BEGIN IMMEDIATE … COMMIT; guarded ROLLBACK on throw. Nested calls throw. */
  tx<T>(mode: 'immediate', fn: (repos: Repos) => NotPromise<T>): T;
  /**
   * Like {@link Db.tx} for a callback that returns a `Result`: an `{ ok: false }` result ROLLS BACK every write the
   * callback made (and is returned as is); only `{ ok: true }` commits. Use it whenever an error path can follow a write.
   */
  txResult<T>(mode: 'immediate', fn: (repos: Repos) => NotPromise<Result<T>>): Result<T>;
  backupTo(dest: string): Promise<void>;
  /** Highest applied migration version. */
  schemaVersion(): number;
  close(): void;
}
