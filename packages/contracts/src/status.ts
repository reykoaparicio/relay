import { z } from 'zod';

// Every enum is an `as const` array with a `z.enum()` schema beside it (02 §B2). Values match the 03 SQL CHECKs.

/** Provider adapters. `gemini` is the third BYOK adapter (04 §D10); `fake` is the deterministic test provider. */
export const PROVIDER_IDS = ['anthropic', 'openai', 'gemini', 'fake'] as const;
/** Schema for {@link ProviderId}. */
export const providerIdSchema = z.enum(PROVIDER_IDS);
/** Provider id. */
export type ProviderId = z.infer<typeof providerIdSchema>;

/** Step roles (§5.3). */
export const ROLES = ['reviewer', 'planner', 'implementer', 'verifier'] as const;
/** Schema for {@link Role}. */
export const roleSchema = z.enum(ROLES);
/** Step role. */
export type Role = z.infer<typeof roleSchema>;

/** Reasoning effort levels (mapped per adapter, 04 §D4/§D5). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Schema for {@link Effort}. */
export const effortSchema = z.enum(EFFORT_LEVELS);
/** Effort level. */
export type Effort = z.infer<typeof effortSchema>;

/** §7.2 run state machine statuses. */
export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'paused',
  'interrupted',
  'cancelling',
  'cancelled',
  'completed',
  'incomplete',
  'failed',
] as const;
/** Schema for {@link RunStatus}. */
export const runStatusSchema = z.enum(RUN_STATUSES);
/** Run status. */
export type RunStatus = z.infer<typeof runStatusSchema>;

/** Terminal run statuses (§7.2). */
export const TERMINAL_RUN_STATUSES = ['completed', 'incomplete', 'cancelled', 'failed'] as const;
/** Schema for {@link TerminalRunStatus}. */
export const terminalRunStatusSchema = z.enum(TERMINAL_RUN_STATUSES);
/** Terminal run status. */
export type TerminalRunStatus = z.infer<typeof terminalRunStatusSchema>;

/** True when `s` is a terminal run status. */
export function isTerminalRunStatus(s: RunStatus): s is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(s);
}

/**
 * Why a run is paused (drives the UI's recovery choices; 06 F2 `allowedRunActions`).
 * `failed` run status is reserved for invariant violations; recoverable problems pause instead (FR-12).
 */
export const PAUSE_REASONS = [
  'budget_run',
  'budget_project',
  'user',
  'auth_required',
  'rate_limited',
  'setup_blocked',
  'approval_stale',
  'deadline',
  'limit_attempts',
  'unknown_outcome',
  'output_invalid',
  'provider_unavailable',
  'budget_overrun',
  'model_refused',
] as const;
/** Schema for {@link PauseReason}. */
export const pauseReasonSchema = z.enum(PAUSE_REASONS);
/** Pause reason. */
export type PauseReason = z.infer<typeof pauseReasonSchema>;

/** §7.3 step lifecycle (+ approval-specific + skip). `validating` is in-memory only (06 F3). */
export const STEP_STATES = [
  'pending',
  'ready',
  'reserved',
  'executing',
  'validating',
  'awaiting_approval',
  'succeeded',
  'failed',
  'unknown',
  'skipped',
] as const;
/** Schema for {@link StepState}. */
export const stepStateSchema = z.enum(STEP_STATES);
/** Step state. */
export type StepState = z.infer<typeof stepStateSchema>;

/**
 * §7.5 attempt dispatch state. `dispatching` = durable intent saved (the call may or may not have left the machine).
 * `abandoned` = the user chose "mark failed" / retried acknowledging the charge (liability kept, §9.5).
 */
export const ATTEMPT_STATES = [
  'created',
  'reserved',
  'dispatching',
  'succeeded',
  'failed_before_dispatch',
  'failed',
  'unknown',
  'reconciled_succeeded',
  'reconciled_failed',
  'abandoned',
] as const;
/** Schema for {@link AttemptState}. */
export const attemptStateSchema = z.enum(ATTEMPT_STATES);
/** Attempt state. */
export type AttemptState = z.infer<typeof attemptStateSchema>;

/** Why an attempt was made (§7.6). */
export const ATTEMPT_PURPOSES = [
  'initial',
  'transport_retry',
  'schema_repair',
  'user_retry',
  'reconcile',
] as const;
/** Schema for {@link AttemptPurpose}. */
export const attemptPurposeSchema = z.enum(ATTEMPT_PURPOSES);
/** Attempt purpose. */
export type AttemptPurpose = z.infer<typeof attemptPurposeSchema>;

/** §9 ledger scope. `setup` = providers.test calls. */
export const LEDGER_SCOPES = ['run', 'setup'] as const;
/** Schema for {@link LedgerScope}. */
export const ledgerScopeSchema = z.enum(LEDGER_SCOPES);
/** Ledger scope. */
export type LedgerScope = z.infer<typeof ledgerScopeSchema>;

/** §9.3 ledger buckets. */
export const LEDGER_BUCKETS = ['allowance', 'reserved', 'settled', 'unknown'] as const;
/** Schema for {@link LedgerBucket}. */
export const ledgerBucketSchema = z.enum(LEDGER_BUCKETS);
/** Ledger bucket. */
export type LedgerBucket = z.infer<typeof ledgerBucketSchema>;

/** §9.3 ledger entry types. */
export const LEDGER_ENTRY_TYPES = [
  'allowance_set',
  'allowance_change',
  'reserve',
  'release',
  'settle',
  'move_to_unknown',
  'resolve_unknown',
] as const;
/** Schema for {@link LedgerEntryType}. */
export const ledgerEntryTypeSchema = z.enum(LEDGER_ENTRY_TYPES);
/** Ledger entry type. */
export type LedgerEntryType = z.infer<typeof ledgerEntryTypeSchema>;

/** FR-09, §9.5 usage certainty. */
export const COST_CERTAINTY = ['reported', 'calculated', 'estimated', 'unknown'] as const;
/** Schema for {@link CostCertainty}. */
export const costCertaintySchema = z.enum(COST_CERTAINTY);
/** Cost certainty. */
export type CostCertainty = z.infer<typeof costCertaintySchema>;

/** §10 memory record types. */
export const MEMORY_TYPES = ['user_rule', 'project_decision', 'source_reference', 'run_summary'] as const;
/** Schema for {@link MemoryType}. */
export const memoryTypeSchema = z.enum(MEMORY_TYPES);
/** Memory type. */
export type MemoryType = z.infer<typeof memoryTypeSchema>;

/** §10.4 persisted memory statuses (`draft` is unsaved form state; `superseded` = archived + supersededById). */
export const MEMORY_STATUSES = ['suggested', 'approved', 'archived', 'rejected', 'deleted'] as const;
/** Schema for {@link MemoryStatus}. */
export const memoryStatusSchema = z.enum(MEMORY_STATUSES);
/** Memory status. */
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

/** §10.4 durable memory events (03 `memory_events.event`). */
export const MEMORY_EVENT_TYPES = [
  'suggested',
  'approved',
  'edited',
  'archived',
  'rejected',
  'deleted',
  'conflict_resolved',
  'unarchived',
  'history_purged', // revision history purged (the current text is kept)
] as const;
/** Schema for {@link MemoryEventType}. */
export const memoryEventTypeSchema = z.enum(MEMORY_EVENT_TYPES);
/** Memory event type. */
export type MemoryEventType = z.infer<typeof memoryEventTypeSchema>;

/** §11.3 approval decisions. */
export const APPROVAL_DECISIONS = ['approved', 'revision_requested', 'rejected'] as const;
/** Schema for {@link ApprovalDecision}. */
export const approvalDecisionSchema = z.enum(APPROVAL_DECISIONS);
/** Approval decision. */
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/** Artifact kinds. `input_file` = intake snapshot of a selected file (R4-6). */
export const ARTIFACT_KINDS = [
  'context_manifest',
  'raw_response',
  'findings',
  'plan',
  'patch',
  'review',
  'report',
  'memory_suggestions',
  'input_diff',
  'input_file',
] as const;
/** Schema for {@link ArtifactKind}. */
export const artifactKindSchema = z.enum(ARTIFACT_KINDS);
/** Artifact kind. */
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/** 05 E2 exclusion reason codes (file preview). */
export const EXCLUSION_REASONS = [
  'dependency_dir',
  'build_output',
  'vcs_internal',
  'secret',
  'os_file',
  'binary',
  'too_large',
  'gitignored',
  'user_pattern',
  'symlink_outside',
  'cap_exceeded',
] as const;
/** Schema for {@link ExclusionReason}. */
export const exclusionReasonSchema = z.enum(EXCLUSION_REASONS);
/** Exclusion reason. */
export type ExclusionReason = z.infer<typeof exclusionReasonSchema>;

/** §12.6 error codes + 02 §B3 extensions. */
export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'MODEL_UNSUPPORTED',
  'RATE_LIMITED',
  'BUDGET_BLOCKED',
  'CONTEXT_TOO_LARGE',
  'OUTPUT_INVALID',
  'APPROVAL_STALE',
  'PROJECT_CHANGED',
  'REQUEST_OUTCOME_UNKNOWN',
  'ARTIFACT_WRITE_FAILED',
  'RUNNER_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'LIMIT_REACHED',
  'PERMISSION_DENIED',
  'SECURE_STORAGE_UNAVAILABLE',
  'MODEL_REFUSED',
  'INTERNAL',
] as const;
/** Schema for {@link ErrorCode}. */
export const errorCodeSchema = z.enum(ERROR_CODES);
/** Stable error code. */
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** Next actions attached to errors (02 §B3). */
export const NEXT_ACTIONS = [
  'reconnect_provider',
  'choose_profile',
  'wait',
  'increase_allowance',
  'stop',
  'narrow_scope',
  'retry_step',
  'reapprove',
  'resnapshot_and_replan',
  'use_preserved_snapshot',
  'decide_unknown',
  'retry_export',
  'restart_runner',
  'fix_input',
  'none',
  'reload',
  'raise_limits',
  'edit_policy',
  'use_session_key',
  'edit_goal',
  'report_bug',
] as const;
/** Schema for {@link NextAction}. */
export const nextActionSchema = z.enum(NEXT_ACTIONS);
/** Next action. */
export type NextAction = z.infer<typeof nextActionSchema>;

/** Server-computed run actions (`RunDetail.availableActions`; 06 F2). Mapped to IPC ops by `RUN_ACTION_OPS`. */
export const RUN_ACTIONS = [
  'pause',
  'cancel',
  'stop',
  'resume',
  'approve',
  'request_revision',
  'reject',
  'increase_allowance',
  'edit_project_allowance',
  'choose_profile',
  'retry_step',
  'raise_limits',
  'acknowledge_overrun',
  'reconnect_provider',
  'resnapshot_and_replan',
  'use_preserved_snapshot',
  'decide_unknown',
  'review_recovery',
  'export_report',
  'export_patch',
] as const;
/** Schema for {@link RunAction}. */
export const runActionSchema = z.enum(RUN_ACTIONS);
/** Run action. */
export type RunAction = z.infer<typeof runActionSchema>;

/** Where a provider credential is kept (03 `provider_credential_refs.storage_mode`). */
export const CREDENTIAL_STORAGE_MODES = ['os_protected', 'session'] as const;
/** Schema for {@link CredentialStorageMode}. */
export const credentialStorageModeSchema = z.enum(CREDENTIAL_STORAGE_MODES);
/** Credential storage mode. */
export type CredentialStorageMode = z.infer<typeof credentialStorageModeSchema>;

/** Runner process state as seen by main (push event `runner.state`, diagnostics). */
export const RUNNER_STATES = ['starting', 'ready', 'restarting', 'unavailable'] as const;
/** Schema for {@link RunnerState}. */
export const runnerStateSchema = z.enum(RUNNER_STATES);
/** Runner state. */
export type RunnerState = z.infer<typeof runnerStateSchema>;
