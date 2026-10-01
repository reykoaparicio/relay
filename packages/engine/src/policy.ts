// 06 F6: dispatch policy (§3.3 "no provider call is dispatched without passing policy, credential, budget, and
// capability checks"). Pure. Budget admission is NOT here: it happens inside the reservation tx (F4 step 2).
// Check #8 binds an approval-bound step to the approved plan hash, the run context hash, the live input-file hashes
// (skipped after `use_preserved_snapshot`), and the approved providers (R3-11).
import { err, errors, ok, upperBound } from '@relay/contracts';
import type {
  AppError,
  AttemptPurpose,
  CatalogModel,
  EpochMs,
  Microusd,
  ModelCapabilities,
  ModelProfile,
  ProviderId,
  RelPath,
  Result,
  Sha256,
  StepKey,
  ValidationIssue,
} from '@relay/contracts';
import type { ModelRequest, UsageEstimate } from '@relay/providers';
import type { ApprovalRow, ProjectRow, RunRow, StepRow } from '@relay/storage';
import type { Admission } from './budget.js';
import { deadlineReached } from './deadline.js';
import type { ModelStepSnapshot } from './ports.js';
import { checkProfile, profileWarningMessage } from './profiles.js';

/** Inputs of check #8 (computed by the caller, `loadApprovalBinding`). */
export interface ApprovalBinding {
  readonly approval: ApprovalRow | undefined;
  readonly currentPlanHash: Sha256 | null;
  readonly runContextHash: Sha256 | null;
  readonly providerId: ProviderId;
  /**
   * B4: true when the approval was invalidated as `project_changed` and the user then chose `use_preserved_snapshot`
   * (recorded as `run.snapshot_preserved` after the invalidation): that approval stays valid for the preserved inputs.
   */
  readonly preservedAfterProjectChange?: boolean | undefined;
  /** Input files whose live hash differs from `run_input_files`; null when skipped (`use_preserved_snapshot`). */
  readonly changedInputs?: readonly RelPath[] | null | undefined;
  /** Intake (`before`) and live (`after`) hashes of the changed inputs (PROJECT_CHANGED details for the inspector). */
  readonly inputHashes?: { readonly before: Readonly<Record<string, string>>; readonly after: Readonly<Record<string, string | null>> } | undefined;
}

/** Everything the pure policy check reads. */
export interface DispatchCheckInput {
  readonly run: RunRow;
  readonly step: StepRow;
  readonly stepSnap: ModelStepSnapshot;
  readonly request: Pick<ModelRequest, 'maxOutputTokens' | 'effort'>;
  readonly estimate: Pick<UsageEstimate, 'inputTokens'>;
  readonly credentialOk: boolean;
  readonly binding: ApprovalBinding | null;
  readonly project: ProjectRow;
  readonly now: EpochMs;
  /** Purpose of the attempt about to be dispatched (check #7 compares the matching counter). */
  readonly purpose?: AttemptPurpose | undefined;
}

type Check = (i: DispatchCheckInput) => AppError | null;

const statusCheck: Check = (i) =>
  i.run.status === 'running' && i.step.state === 'ready' ? null : errors.conflict({ reason: 'not_dispatchable' });

const providerCheck: Check = (i) =>
  i.project.providerPolicy.allowedProviderIds.includes(i.stepSnap.profile.providerId)
    ? null
    : errors.permissionDenied('provider_not_allowed', { details: { providerId: i.stepSnap.profile.providerId } });

const credentialCheck: Check = (i) => (i.credentialOk ? null : errors.authRequired(i.stepSnap.profile.providerId));

function capabilityCheck(i: DispatchCheckInput): AppError | null {
  const caps = i.stepSnap.profile.capabilities;
  const { providerId, modelId } = i.stepSnap.profile;
  if (!caps.structuredOutput) return errors.modelUnsupported({ providerId, modelId, reason: 'structured_output' });
  if (caps.maxOutputTokens !== undefined && caps.maxOutputTokens < i.request.maxOutputTokens) {
    return errors.modelUnsupported({ providerId, modelId, reason: 'max_output_tokens' });
  }
  if (i.request.effort !== undefined && !caps.effortLevels.includes(i.request.effort)) {
    return errors.modelUnsupported({ providerId, modelId, reason: 'effort' });
  }
  const needed = i.estimate.inputTokens + i.request.maxOutputTokens;
  if (caps.maxInputTokens !== undefined && caps.maxInputTokens < needed) {
    return errors.contextTooLarge({ estimatedInputTokens: i.estimate.inputTokens, budgetTokens: caps.maxInputTokens - i.request.maxOutputTokens });
  }
  return null;
}

const attemptsCheck: Check = (i) => (i.run.attemptCount < i.run.limits.maxAttempts ? null : errors.limitReached('attempts'));

const deadlineCheck: Check = (i) => (deadlineReached(i.run, i.now) ? errors.limitReached('deadline') : null);

/** #7: the retry counter consumed by this purpose (F7) is within the snapshot `retryPolicy` (counters persist). */
const retryCounterCheck: Check = (i) => {
  const p = i.stepSnap.retryPolicy;
  const s = i.step;
  const within =
    s.rateLimitWaitsUsed <= p.rateLimitWaits &&
    (i.purpose !== 'transport_retry' || s.transportRetriesUsed <= p.transport) &&
    (i.purpose !== 'schema_repair' || s.schemaRepairsUsed <= p.schemaRepair);
  return within ? null : errors.limitReached('attempts', { details: { reason: 'retry_policy', purpose: i.purpose ?? null } });
};

function approvalCheck(i: DispatchCheckInput): AppError | null {
  const b = i.binding;
  if (b === null) return null;
  const a = b.approval;
  if (a?.decision !== 'approved') return errors.approvalStale('plan_changed');
  if (a.invalidatedAt !== null && !(a.invalidatedReason === 'project_changed' && b.preservedAfterProjectChange === true)) {
    return a.invalidatedReason === 'project_changed' ? errors.projectChanged([]) : errors.approvalStale(a.invalidatedReason ?? 'plan_changed');
  }
  if (b.currentPlanHash !== a.planHash || b.runContextHash !== a.contextHash) return errors.approvalStale('plan_changed');
  if (b.changedInputs != null && b.changedInputs.length > 0) { // §11.2
    return errors.projectChanged(b.changedInputs, b.inputHashes === undefined ? undefined : { details: { ...b.inputHashes } });
  }
  const providers = (a.requestedPermissions as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(providers) || !providers.includes(b.providerId)) return errors.approvalStale('provider_changed');
  return null;
}

/** P0 makes no tool calls (ADR-014); the check is kept for the future. */
const TOOL_CALLS_USED = 0;
const toolCallCheck: Check = (i) => (TOOL_CALLS_USED <= i.run.limits.maxToolCalls ? null : errors.limitReached('tool_calls'));

const CHECKS: readonly Check[] = [
  statusCheck,
  providerCheck,
  credentialCheck,
  capabilityCheck,
  attemptsCheck,
  deadlineCheck,
  retryCounterCheck,
  approvalCheck,
  toolCallCheck,
];

/** Every failing check, in F6 order (preflight display). */
export function checkDispatchAll(i: DispatchCheckInput): AppError[] {
  return CHECKS.flatMap((c) => {
    const e = c(i);
    return e === null ? [] : [e];
  });
}

/** F6: all checks in a fixed order; returns the first failure. */
export function checkDispatch(i: DispatchCheckInput): Result<void> {
  const first = checkDispatchAll(i)[0];
  return first === undefined ? ok(undefined) : err(first);
}

// ---------------------------------------------------------------- readiness (F13 runChecks + F14 preflight)

/** The pause a readiness issue maps to when a queued run cannot start (F2 `queued → paused`, clarification 9). */
type ReadinessReason = 'setup_blocked' | 'auth_required' | 'budget_run' | 'budget_project';

/**
 * One reason a run cannot start: shared by `runs.preflight` (listed as `issues`) and the loop's `runChecks` (the first
 * one becomes `SETUP_BLOCKED` with its `reason`, before any reservation). `stepKey` is null for an allowance issue.
 */
export interface ReadinessIssue {
  readonly stepKey: StepKey | null;
  readonly reason: ReadinessReason;
  /** Stable issue code: a capability warning code (`missing_credential`, `provider_not_allowed`, `model_unknown`, …), `unknown_profile`, `budget_run`, or `budget_project`. */
  readonly code: string;
  readonly error: AppError;
}

/** What the readiness check reads about one model step's (effective) profile. Credential presence comes from the credential-ref repo, never the key. */
interface StepReadinessInput {
  readonly stepKey: StepKey;
  readonly profile: Pick<ModelProfile, 'providerId' | 'modelId' | 'params'>;
  /** Snapshot or live capabilities; absent → the catalog entry's. */
  readonly capabilities?: ModelCapabilities | undefined;
  readonly catalogEntry: CatalogModel | undefined;
  readonly hasCredential: boolean;
}

/** Per-step readiness in F6 order: provider permitted (#2), credential ref present (#3), model in the catalog and supported (#4). Pure. */
export function checkStepReadiness(allowedProviderIds: readonly ProviderId[], s: StepReadinessInput): ReadinessIssue[] {
  const { providerId, modelId } = s.profile;
  const issues: ReadinessIssue[] = [];
  if (!allowedProviderIds.includes(providerId)) {
    issues.push({ stepKey: s.stepKey, reason: 'setup_blocked', code: 'provider_not_allowed',
      error: errors.permissionDenied('provider_not_allowed', { details: { stepKey: s.stepKey, providerId }, userMessage: profileWarningMessage('provider_not_allowed') }) });
  }
  if (!s.hasCredential) {
    issues.push({ stepKey: s.stepKey, reason: 'auth_required', code: 'missing_credential',
      error: errors.authRequired(providerId, { details: { stepKey: s.stepKey }, userMessage: profileWarningMessage('missing_credential') }) });
  }
  const checked = checkProfile(s.profile, s.catalogEntry, s.capabilities);
  if (!checked.ok) {
    const code = typeof checked.error.details?.['reason'] === 'string' ? checked.error.details['reason'] : 'model_unsupported';
    issues.push({ stepKey: s.stepKey, reason: 'setup_blocked', code,
      error: errors.modelUnsupported({ providerId, modelId, reason: code }, { details: { stepKey: s.stepKey }, userMessage: checked.error.userMessage }) });
  }
  return issues;
}

/**
 * The smallest reservation a model step can ever need: its output allowance at the snapshot prices with no input
 * (`upperBound(0, maxOutputTokens, prices)`). Every dispatch N (local or provider-counted, one or two hops) is at
 * least this, so a run whose remaining allowance cannot cover it is blocked for certain — a queued run pauses before
 * any reservation instead of at dispatch, and never on a guess.
 */
export function minimumReservation(stepSnap: Pick<ModelStepSnapshot, 'maxOutputTokens' | 'profile'>): Microusd {
  return upperBound(0, stepSnap.maxOutputTokens, stepSnap.profile.prices);
}

/** The allowance issue of a read-only §9.3 admission (null when admitted). */
export function budgetReadiness(decision: Admission): ReadinessIssue | null {
  if (decision.ok) return null;
  const scope = decision.breakdown.scope === 'project' ? 'budget_project' : 'budget_run';
  return { stepKey: null, reason: scope, code: scope, error: errors.budgetBlocked(decision.breakdown) };
}

/** Preflight form path of an issue: the step's profile select, or the allowance it concerns. */
function readinessIssuePath(i: ReadinessIssue): string {
  if (i.stepKey !== null) return `profileOverrides.${i.stepKey}`;
  return i.reason === 'budget_project' ? 'project.monthlyAllowanceMicrousd' : 'limitOverrides.budgetMicrousd';
}

const BUDGET_MESSAGES: Readonly<Record<string, string>> = {
  budget_run: 'The run allowance cannot cover the first reservation.',
  budget_project: "The project's remaining monthly allowance cannot cover the first reservation.",
};

/** `runs.preflight` issue (02 ValidationIssue) of a readiness issue. */
export function toPreflightIssue(i: ReadinessIssue): ValidationIssue {
  return { path: readinessIssuePath(i), code: i.code, message: BUDGET_MESSAGES[i.code] ?? i.error.userMessage };
}
