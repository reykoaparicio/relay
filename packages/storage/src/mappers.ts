// C5 row mappers: snake_case row → camelCase, validated domain object. Scalars and JSON columns are parsed through the
// @relay/contracts Zod schemas; any failure throws DataCorruptionError { table, id, column } (no content in messages).
import type { ArtifactMeta, EpochMs, IdPrefixKey, IdOf, Microusd } from '@relay/contracts';
import {
  appErrorSchema,
  approvalDecisionSchema,
  artifactKindSchema,
  attemptPurposeSchema,
  attemptStateSchema,
  costCertaintySchema,
  credentialStorageModeSchema,
  epochMsSchema,
  exclusionsSchema,
  idSchema,
  ledgerBucketSchema,
  ledgerEntryTypeSchema,
  ledgerScopeSchema,
  memoryEventTypeSchema,
  memoryRecordScopeSchema,
  memorySourceRefSchema,
  memoryStatusSchema,
  memoryTypeSchema,
  microusdSchema,
  modelCapabilitiesSchema,
  modelParamsSchema,
  modelPricesSchema,
  pauseReasonSchema,
  profileSnapshotSchema,
  providerIdSchema,
  providerOptionsSchema,
  relPathSchema,
  runEventTypeSchema,
  runInputSchema,
  runLimitsSchema,
  runStatusSchema,
  sha256Schema,
  stepKeySchema,
  stepStateSchema,
  usageViewSchema,
  workflowSpecSchema,
  APPROVAL_STALE_REASONS,
} from '@relay/contracts';
import type { RunEvent } from '@relay/contracts';
import { DataCorruptionError } from './errors.js';
import type {
  ApprovalRow,
  ArtifactRow,
  AttemptRow,
  CatalogRow,
  ConfigRevisionRow,
  CredentialRefRow,
  DeferredPause,
  LedgerEntryRow,
  MemoryEventRow,
  MemoryItem,
  MemoryRecordRow,
  MemoryRevisionRow,
  ProfileRow,
  ProjectRow,
  ProjectWithRoot,
  RunInputFile,
  RunMemorySnapshotRow,
  RunRow,
  StepRow,
  WorkflowRow,
  WorkflowVersionRow,
} from './types.js';
import { CONFIG_REVISION_REASONS, DEFERRED_PAUSE_REASONS } from './types.js';

/** Structural view of a Zod schema (storage does not depend on `zod` directly; schemas come from contracts). */
export interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

const artifactIds = idSchema('artifact').array();
const relPaths = relPathSchema.array();
const providerIds = providerIdSchema.array();
const memorySourceRefs = memorySourceRefSchema.array();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validating reader over one raw row. */
export class RowReader {
  private readonly row: Record<string, unknown>;
  private readonly table: string;
  private readonly rowId: string | null;

  constructor(table: string, row: unknown, idColumn = 'id') {
    this.table = table;
    if (!isRecord(row)) {
      throw new DataCorruptionError(table, null, '*');
    }
    this.row = row;
    const id = row[idColumn];
    this.rowId = typeof id === 'string' ? id : null;
  }

  private fail(column: string): never {
    throw new DataCorruptionError(this.table, this.rowId, column);
  }

  private raw(column: string): unknown {
    if (!(column in this.row)) {
      this.fail(column);
    }
    return this.row[column];
  }

  text(column: string): string {
    const v = this.raw(column);
    return typeof v === 'string' ? v : this.fail(column);
  }

  textN(column: string): string | null {
    const v = this.raw(column);
    return v === null ? null : this.text(column);
  }

  int(column: string): number {
    const v = this.raw(column);
    return typeof v === 'number' && Number.isSafeInteger(v) ? v : this.fail(column);
  }

  intN(column: string): number | null {
    return this.raw(column) === null ? null : this.int(column);
  }

  bool(column: string): boolean {
    const v = this.int(column);
    return v === 1 ? true : v === 0 ? false : this.fail(column);
  }

  boolN(column: string): boolean | null {
    return this.raw(column) === null ? null : this.bool(column);
  }

  /** Parses a non-JSON column value with `schema`. */
  as<T>(column: string, schema: Schema<T>): T {
    const r = schema.safeParse(this.raw(column));
    return r.success ? r.data : this.fail(column);
  }

  asN<T>(column: string, schema: Schema<T>): T | null {
    return this.raw(column) === null ? null : this.as(column, schema);
  }

  id<P extends IdPrefixKey>(column: string, p: P): IdOf<P> {
    return this.as(column, idSchema(p));
  }

  idN<P extends IdPrefixKey>(column: string, p: P): IdOf<P> | null {
    return this.asN(column, idSchema(p));
  }

  ms(column: string): EpochMs {
    return this.as(column, epochMsSchema);
  }

  msN(column: string): EpochMs | null {
    return this.asN(column, epochMsSchema);
  }

  money(column: string): Microusd {
    return this.as(column, microusdSchema);
  }

  /** Parses a JSON column (any valid JSON value). */
  jsonAny(column: string): unknown {
    const text = this.text(column);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return this.fail(column);
    }
  }

  jsonAnyN(column: string): unknown {
    return this.raw(column) === null ? null : this.jsonAny(column);
  }

  /** Parses a JSON column and validates it with `schema`. */
  json<T>(column: string, schema: Schema<T>): T {
    const r = schema.safeParse(this.jsonAny(column));
    return r.success ? r.data : this.fail(column);
  }

  jsonN<T>(column: string, schema: Schema<T>): T | null {
    return this.raw(column) === null ? null : this.json(column, schema);
  }

  /** Validates with a plain type guard (for shapes contracts has no schema for). */
  jsonGuard<T>(column: string, guard: (v: unknown) => v is T): T {
    const v = this.jsonAny(column);
    return guard(v) ? v : this.fail(column);
  }

  /** Value of a string column that must be one of `values`. */
  oneOf<T extends string>(column: string, values: readonly T[]): T {
    const v = this.text(column);
    return (values as readonly string[]).includes(v) ? (v as T) : this.fail(column);
  }

  oneOfN<T extends string>(column: string, values: readonly T[]): T | null {
    return this.raw(column) === null ? null : this.oneOf(column, values);
  }
}

/** Record of string → string (prompt snapshots). */
function isStringRecord(v: unknown): v is Record<string, string> {
  return isRecord(v) && Object.values(v).every((x) => typeof x === 'string');
}

/** A plain JSON object. */
function isJsonObject(v: unknown): v is Record<string, unknown> {
  return isRecord(v);
}

const freeze = <T extends object>(o: T): Readonly<T> => Object.freeze(o);

// ---------------------------------------------------------------- mappers

function projectBase(r: RowReader): ProjectRow {
  return {
    id: r.id('id', 'project'),
    name: r.text('name'),
    rootDisplayPath: r.text('root_display_path'),
    exclusions: r.json('exclusions_json', exclusionsSchema),
    providerPolicy: {
      allowedProviderIds: r.json('allowed_provider_ids_json', providerIds),
      providerOptions: r.json('provider_options_json', providerOptionsSchema),
    },
    monthlyAllowanceMicrousd: r.intN('monthly_allowance_microusd') === null ? null : r.money('monthly_allowance_microusd'),
    isDemo: r.bool('is_demo'),
    createdAt: r.ms('created_at'),
    updatedAt: r.ms('updated_at'),
    archivedAt: r.msN('archived_at'),
  };
}

/** Renderer-safe project: `root_realpath` is never read into this object. */
export function mapProject(row: unknown): ProjectRow {
  return freeze(projectBase(new RowReader('projects', row)));
}

/** Runner-internal project with its realpath. */
export function mapProjectWithRoot(row: unknown): ProjectWithRoot {
  const r = new RowReader('projects', row);
  return freeze({ ...projectBase(r), rootRealpath: r.text('root_realpath') });
}

export function mapCredentialRef(row: unknown): CredentialRefRow {
  const r = new RowReader('provider_credential_refs', row);
  const at = r.msN('last_test_at');
  const ok = r.boolN('last_test_ok');
  return freeze({
    id: r.id('id', 'credentialRef'),
    providerId: r.as('provider_id', providerIdSchema),
    storageMode: r.as('storage_mode', credentialStorageModeSchema),
    vaultFile: r.textN('vault_file'),
    redactedLabel: r.text('redacted_label'),
    createdAt: r.ms('created_at'),
    updatedAt: r.ms('updated_at'),
    lastTest: at === null ? null : { at, ok: ok ?? false, code: r.textN('last_test_code') },
  });
}

export function mapCatalog(row: unknown): CatalogRow {
  const r = new RowReader('model_catalog', row, 'model_id');
  return freeze({
    providerId: r.as('provider_id', providerIdSchema),
    modelId: r.text('model_id'),
    catalogVersion: r.text('catalog_version'),
    displayName: r.text('display_name'),
    capabilities: r.json('capabilities_json', modelCapabilitiesSchema),
    prices: r.json('prices_json', modelPricesSchema),
    effectiveDate: r.text('effective_date'),
    source: r.text('source'),
    sourceRetrievedAt: r.text('source_retrieved_at'),
  });
}

export function mapProfile(row: unknown): ProfileRow {
  const r = new RowReader('model_profiles', row);
  return freeze({
    id: r.id('id', 'profile'),
    name: r.text('name'),
    providerId: r.as('provider_id', providerIdSchema),
    modelId: r.text('model_id'),
    params: r.json('params_json', modelParamsSchema),
    capabilitiesSnapshot: r.json('capabilities_snapshot_json', modelCapabilitiesSchema),
    catalogVersion: r.text('catalog_version'),
    revision: r.int('revision'),
    createdAt: r.ms('created_at'),
    updatedAt: r.ms('updated_at'),
  });
}

export function mapWorkflow(row: unknown): WorkflowRow {
  const r = new RowReader('workflows', row);
  return freeze({ id: r.id('id', 'workflow'), slug: r.text('slug'), name: r.text('name'), createdAt: r.ms('created_at') });
}

export function mapWorkflowVersion(row: unknown): WorkflowVersionRow {
  const r = new RowReader('workflow_versions', row);
  return freeze({
    id: r.id('id', 'workflowVersion'),
    workflowId: r.id('workflow_id', 'workflow'),
    version: r.int('version'),
    status: r.oneOf('status', ['draft', 'validated'] as const),
    draftRevision: r.int('draft_revision'),
    schemaVersion: r.int('schema_version'),
    spec: r.json('spec_json', workflowSpecSchema),
    prompts: r.jsonGuard('prompts_json', isStringRecord),
    contentHash: r.as('content_hash', sha256Schema),
    basedOnVersion: r.intN('based_on_version'),
    createdAt: r.ms('created_at'),
    validatedAt: r.msN('validated_at'),
  });
}

export function mapConfigRevision(row: unknown): ConfigRevisionRow {
  const r = new RowReader('run_config_revisions', row, 'run_id');
  return freeze({
    runId: r.id('run_id', 'run'),
    revision: r.int('revision'),
    stepKey: r.as('step_key', stepKeySchema),
    previousProfile: r.json('previous_profile_json', profileSnapshotSchema),
    profileSnapshot: r.json('profile_snapshot_json', profileSnapshotSchema),
    reason: r.oneOf('reason', CONFIG_REVISION_REASONS),
    createdAt: r.ms('created_at'),
  });
}

function deferredPauseOf(r: RowReader): DeferredPause | null {
  const reason = r.oneOfN('deferred_pause', DEFERRED_PAUSE_REASONS);
  const detail = r.jsonN('deferred_pause_detail_json', appErrorSchema);
  return reason === null || detail === null ? null : { reason, detail };
}

export function mapRun(row: unknown): RunRow {
  const r = new RowReader('runs', row);
  return freeze({
    id: r.id('id', 'run'),
    projectId: r.id('project_id', 'project'),
    workflowVersionId: r.id('workflow_version_id', 'workflowVersion'),
    goal: r.text('goal'),
    status: r.as('status', runStatusSchema),
    pauseReason: r.asN('pause_reason', pauseReasonSchema),
    statusDetail: r.jsonN('status_detail_json', appErrorSchema),
    input: r.json('input_json', runInputSchema),
    snapshot: r.jsonAny('snapshot_json'),
    limits: r.json('limits_json', runLimitsSchema),
    contextHash: r.asN('context_hash', sha256Schema),
    revisionCycle: r.int('revision_cycle'),
    attemptCount: r.int('attempt_count'),
    executionMsUsed: r.int('execution_ms_used'),
    runningSince: r.msN('running_since'),
    pauseRequested: r.bool('pause_requested'),
    deferredPause: deferredPauseOf(r),
    idempotencyKey: r.text('idempotency_key'),
    createdAt: r.ms('created_at'),
    startedAt: r.msN('started_at'),
    endedAt: r.msN('ended_at'),
    updatedAt: r.ms('updated_at'),
  });
}

export function mapInputFile(row: unknown): RunInputFile {
  const r = new RowReader('run_input_files', row, 'run_id');
  return freeze({
    relPath: r.as('rel_path', relPathSchema),
    sha256: r.as('sha256', sha256Schema),
    artifactId: r.id('artifact_id', 'artifact'),
    sizeBytes: r.int('size_bytes'),
    capturedAt: r.ms('captured_at'),
  });
}

export function mapStep(row: unknown): StepRow {
  const r = new RowReader('step_runs', row);
  return freeze({
    id: r.id('id', 'stepRun'),
    runId: r.id('run_id', 'run'),
    stepKey: r.as('step_key', stepKeySchema),
    ordinal: r.int('ordinal'),
    revisionIndex: r.int('revision_index'),
    retryIndex: r.int('retry_index'),
    state: r.as('state', stepStateSchema),
    profileName: r.textN('profile_name'),
    inputArtifactIds: r.json('input_artifact_ids_json', artifactIds),
    outputArtifactId: r.idN('output_artifact_id', 'artifact'),
    outcome: r.textN('outcome'),
    schemaRepairsUsed: r.int('schema_repairs_used'),
    transportRetriesUsed: r.int('transport_retries_used'),
    rateLimitWaitsUsed: r.int('rate_limit_waits_used'),
    notBeforeAt: r.msN('not_before_at'),
    error: r.jsonN('error_json', appErrorSchema),
    createdAt: r.ms('created_at'),
    updatedAt: r.ms('updated_at'),
  });
}

export function mapAttempt(row: unknown): AttemptRow {
  const r = new RowReader('attempts', row);
  return freeze({
    id: r.id('id', 'attempt'),
    runId: r.id('run_id', 'run'),
    stepRunId: r.id('step_run_id', 'stepRun'),
    seq: r.int('seq'),
    purpose: r.as('purpose', attemptPurposeSchema),
    retryOfAttemptId: r.idN('retry_of_attempt_id', 'attempt'),
    providerId: r.as('provider_id', providerIdSchema),
    modelId: r.text('model_id'),
    profileSnapshot: r.json('profile_snapshot_json', profileSnapshotSchema),
    requestFingerprint: r.text('request_fingerprint'),
    state: r.as('state', attemptStateSchema),
    reservationMicrousd: r.money('reservation_microusd'),
    estimate: r.jsonAnyN('estimate_json'),
    providerRequestId: r.textN('provider_request_id'),
    providerResponseId: r.textN('provider_response_id'),
    usage: r.jsonN('usage_json', usageViewSchema),
    rawUsage: r.jsonAnyN('raw_usage_json'),
    priceCatalogVersion: r.text('price_catalog_version'),
    stopReason: r.textN('stop_reason'),
    error: r.jsonN('error_json', appErrorSchema),
    createdAt: r.ms('created_at'),
    dispatchedAt: r.msN('dispatched_at'),
    firstByteAt: r.msN('first_byte_at'),
    finishedAt: r.msN('finished_at'),
  });
}

export function mapLedgerEntry(row: unknown): LedgerEntryRow {
  const r = new RowReader('ledger_entries', row);
  return freeze({
    id: r.id('id', 'ledger'),
    scope: r.as('scope', ledgerScopeSchema),
    runId: r.idN('run_id', 'run'),
    projectId: r.idN('project_id', 'project'),
    attemptId: r.idN('attempt_id', 'attempt'),
    type: r.as('type', ledgerEntryTypeSchema),
    bucket: r.as('bucket', ledgerBucketSchema),
    deltaMicrousd: r.money('delta_microusd'),
    certainty: r.asN('certainty', costCertaintySchema),
    priceCatalogVersion: r.textN('price_catalog_version'),
    groupId: r.text('group_id'),
    note: r.textN('note'),
    createdAt: r.ms('created_at'),
  });
}

export function mapArtifact(row: unknown): ArtifactRow {
  const r = new RowReader('artifacts', row);
  return freeze({
    id: r.id('id', 'artifact'),
    runId: r.idN('run_id', 'run'),
    projectId: r.id('project_id', 'project'),
    stepRunId: r.idN('step_run_id', 'stepRun'),
    attemptId: r.idN('attempt_id', 'attempt'),
    kind: r.as('kind', artifactKindSchema),
    relPath: r.text('rel_path'),
    sha256: r.as('sha256', sha256Schema),
    sizeBytes: r.int('size_bytes'),
    mediaType: r.text('media_type'),
    schemaId: r.textN('schema_id'),
    purgedAt: r.msN('purged_at'),
    createdAt: r.ms('created_at'),
  });
}

/** Artifact row → renderer DTO (02 `ArtifactMeta`): no rel path, `purged` flag only. */
export function toArtifactMeta(a: ArtifactRow): ArtifactMeta {
  return {
    id: a.id,
    kind: a.kind,
    schemaId: a.schemaId,
    runId: a.runId,
    stepRunId: a.stepRunId,
    attemptId: a.attemptId,
    sha256: a.sha256,
    sizeBytes: a.sizeBytes,
    mediaType: a.mediaType,
    createdAt: a.createdAt,
    purged: a.purgedAt !== null,
  };
}

export function mapApproval(row: unknown): ApprovalRow {
  const r = new RowReader('approvals', row);
  return freeze({
    id: r.id('id', 'approval'),
    runId: r.id('run_id', 'run'),
    stepRunId: r.id('step_run_id', 'stepRun'),
    planArtifactId: r.id('plan_artifact_id', 'artifact'),
    planHash: r.as('plan_hash', sha256Schema),
    contextHash: r.as('context_hash', sha256Schema),
    fileScope: r.json('file_scope_json', relPaths),
    requestedPermissions: r.jsonAny('requested_permissions_json'),
    decision: r.asN('decision', approvalDecisionSchema),
    decisionNote: r.textN('decision_note'),
    decidedAt: r.msN('decided_at'),
    invalidatedAt: r.msN('invalidated_at'),
    invalidatedReason: r.oneOfN('invalidated_reason', APPROVAL_STALE_REASONS),
    createdAt: r.ms('created_at'),
  });
}

function mapMemoryRecord(row: unknown): MemoryRecordRow {
  const r = new RowReader('memory_records', row);
  return freeze({
    id: r.id('id', 'memory'),
    projectId: r.id('project_id', 'project'),
    type: r.as('type', memoryTypeSchema),
    status: r.as('status', memoryStatusSchema),
    currentRevision: r.int('current_revision'),
    scope: r.json('scope_json', memoryRecordScopeSchema),
    pinned: r.bool('pinned'),
    expiresAt: r.msN('expires_at'),
    reviewAt: r.msN('review_at'),
    supersededById: r.idN('superseded_by_id', 'memory'),
    sourceRunId: r.idN('source_run_id', 'run'),
    proposal: r.jsonAnyN('proposal_json'),
    createdAt: r.ms('created_at'),
    updatedAt: r.ms('updated_at'),
    deletedAt: r.msN('deleted_at'),
  });
}

/** Maps a memory revision; `prefix` selects aliased join columns (`rev_id`, `rev_title`, …). */
export function mapMemoryRevision(row: unknown, prefix = ''): MemoryRevisionRow {
  const c = (name: string): string => `${prefix}${name}`;
  const r = new RowReader('memory_revisions', row, c('id'));
  return freeze({
    id: r.id(c('id'), 'memoryRevision'),
    recordId: r.id(c('record_id'), 'memory'),
    revision: r.int(c('revision')),
    title: r.text(c('title')),
    content: r.text(c('content')),
    sourceRefs: r.json(c('source_refs_json'), memorySourceRefs),
    author: r.text(c('author')),
    createdAt: r.ms(c('created_at')),
  });
}

/** Maps a `memory_records` row joined with its current revision (aliased `rev_*`). */
export function mapMemoryItem(row: unknown): MemoryItem {
  return freeze({ record: mapMemoryRecord(row), current: mapMemoryRevision(row, 'rev_') });
}

export function mapMemoryEvent(row: unknown): MemoryEventRow {
  const r = new RowReader('memory_events', row);
  return freeze({
    id: r.text('id'),
    recordId: r.id('record_id', 'memory'),
    event: r.as('event', memoryEventTypeSchema),
    revision: r.int('revision'),
    actor: r.text('actor'),
    detail: r.jsonAnyN('detail_json'),
    createdAt: r.ms('created_at'),
  });
}

export function mapRunMemorySnapshot(row: unknown): RunMemorySnapshotRow {
  const r = new RowReader('run_memory_snapshot', row, 'record_id');
  return freeze({
    runId: r.id('run_id', 'run'),
    recordId: r.id('record_id', 'memory'),
    revision: r.int('revision'),
    title: r.text('title'),
    content: r.text('content'),
    type: r.as('type', memoryTypeSchema),
    pinned: r.bool('pinned'),
    scope: r.json('scope_json', memoryRecordScopeSchema),
    included: r.bool('included'),
  });
}

export function mapRunEvent(row: unknown): RunEvent {
  const r = new RowReader('run_events', row);
  return freeze({
    id: r.id('id', 'event'),
    runId: r.id('run_id', 'run'),
    seq: r.int('seq'),
    type: r.as('type', runEventTypeSchema),
    at: r.ms('created_at'),
    payload: r.jsonGuard('payload_json', isJsonObject),
  });
}

/** Reads a single aggregate integer column (COUNT/SUM) from a row. */
export function readInt(table: string, row: unknown, column: string): number {
  return new RowReader(table, row, column).int(column);
}
