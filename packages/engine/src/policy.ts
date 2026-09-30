// 06 F6: dispatch policy (§3.3 "no provider call is dispatched without passing policy, credential, budget, and
// capability checks"). Pure. Budget admission is NOT here: it happens inside the reservation tx (F4 step 2).
// Wave 1: check #8 compares the approval against the current plan hash, run context hash, and provider; the live
// input-file re-hash is performed by the context assembler's stale check (PROJECT_CHANGED) before this runs.
import { err, errors, ok } from '@relay/contracts';
import type { AppError, EpochMs, ProviderId, Result, Sha256 } from '@relay/contracts';
import type { ModelRequest, UsageEstimate } from '@relay/providers';
import type { ApprovalRow, ProjectRow, RunRow, StepRow } from '@relay/storage';
import { deadlineReached } from './deadline.js';
import type { ModelStepSnapshot } from './ports.js';

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

const retryCounterCheck: Check = (i) => {
  const p = i.stepSnap.retryPolicy;
  const s = i.step;
  return s.transportRetriesUsed <= p.transport && s.schemaRepairsUsed <= p.schemaRepair && s.rateLimitWaitsUsed <= p.rateLimitWaits
    ? null
    : errors.limitReached('attempts');
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
  const providers = (a.requestedPermissions as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(providers) || !providers.includes(b.providerId)) return errors.approvalStale('provider_changed');
  return null;
}

// ADR-014: maxToolCalls is 0 in P0 and no tool call is ever made, so check #9 always passes; kept for the future.
const toolCallCheck: Check = () => null;

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
