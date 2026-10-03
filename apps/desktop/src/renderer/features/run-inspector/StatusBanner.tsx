// Run status banners (10 J8 StatusBanner table): status / pause reason → InlineAlert + the action buttons. The
// mapping is exhaustive over `pauseReasonSchema` and `runStatusSchema` (a new member is a compile error), and every
// button comes from `RunDetail.availableActions` (the server's 06 F2 table): nothing here re-derives run policy.
import { memo, useId, useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { microusd } from '@relay/contracts';
import type { CostCertainty, LastShutdown, PauseReason, RunAction, RunDetail, RunEvent, StepView } from '@relay/contracts';
import { UNKNOWN_OUTCOME_DECISIONS } from '@relay/contracts';
import {
  BudgetBreakdownTable,
  Button,
  ButtonLink,
  Hash,
  InlineAlert,
  KeyValueList,
  Money,
  RecoveryPanel,
} from '../../components/ui';
import type { RecoveryDecisionDetail } from '../../components/ui';
import {
  DESTRUCTIVE_RUN_ACTIONS,
  formatDuration,
  formatUsdAtPrecision,
  PROVIDER_LABELS,
  RUN_ACTION_LABELS,
  statusPresentation,
  stepKeyLabel,
  sumConsistentPrecision,
} from '../../lib/format';
import { useAppInfo } from '../../hooks/useAppInfo';
import { useLedger } from '../../hooks/useLedger';
import { RunSuggestionsLink } from '../memory/RunSuggestionsLink';
import { paths } from '../shell/paths';
import {
  bannerActions,
  blockedStep,
  breakdownOf,
  hashMapDetail,
  incompleteCauseOf,
  incompleteTitle,
  INTERRUPTION_LEAD,
  interruptedStep,
  interruptionCauseOf,
  issuesOf,
  lastOverrun,
  numberDetail,
  overrunStep,
  stepTitle,
  stringDetail,
  stringListDetail,
  usefulArtifactSteps,
} from './inspector-model';
import type { IncompleteCause, OverrunFact } from './inspector-model';
import { planRunAction } from './run-actions';
import { RequestFacts } from './RequestFacts';
import { RawResponseToggle, repairsText, TechnicalDetails, ValidationIssueList } from './StepIssues';

export interface StatusBannerProps {
  readonly run: RunDetail;
  readonly projectId: string;
  /** The run's events (for the overrun amounts of `ledger.overrun`). */
  readonly events: readonly RunEvent[];
  /** A user chose an action: the page opens its dialog / confirmation, or runs it. */
  readonly onAction: (action: RunAction) => void;
  /**
   * A RecoveryPanel choice: an action it already confirmed (its own ConfirmDialog for stop), or a per-attempt
   * `decide_unknown` with `{ attemptId, decision }` (the page confirms and calls `runs.decideUnknown` for it).
   */
  readonly onRecoveryAction: (action: RunAction, detail?: RecoveryDecisionDetail) => void;
  readonly pending: RunAction | null;
  readonly busy: boolean;
  /** Available actions that cannot be used right now, with the reason shown next to the disabled button. */
  readonly disabledReasons?: Partial<Readonly<Record<RunAction, string>>>;
}

function providerName(id: string | null): string {
  if (id === null) return 'The provider';
  return id in PROVIDER_LABELS ? PROVIDER_LABELS[id as keyof typeof PROVIDER_LABELS] : id;
}

/** Buttons for the given available actions. `reconnect_provider` navigates, so it is a link (09 ButtonLink). */
function ActionButtons({
  actions,
  onAction,
  pending,
  busy,
  disabledReasons = {},
}: {
  readonly actions: readonly RunAction[];
  readonly onAction: (a: RunAction) => void;
  readonly pending: RunAction | null;
  readonly busy: boolean;
  readonly disabledReasons?: Partial<Readonly<Record<RunAction, string>>> | undefined;
}) {
  const reasonId = useId();
  if (actions.length === 0) return null;
  const reasons = actions.flatMap((a) => {
    const r = disabledReasons[a];
    return r === undefined ? [] : [{ action: a, reason: r }];
  });
  return (
    <>
      {actions.map((a, i) => {
        const plan = a === 'reconnect_provider' ? planRunAction({ action: 'reconnect_provider' }) : null;
        if (plan?.kind === 'navigate') {
          return (
            <ButtonLink key={a} as={Link} to={plan.to} variant={i === 0 ? 'primary' : 'secondary'}>
              {RUN_ACTION_LABELS[a]}
            </ButtonLink>
          );
        }
        const reason = disabledReasons[a];
        return (
          <Button
            key={a}
            variant={DESTRUCTIVE_RUN_ACTIONS.has(a) ? 'danger' : i === 0 ? 'primary' : 'secondary'}
            pending={pending === a}
            disabled={(busy && pending !== a) || reason !== undefined}
            aria-describedby={reason === undefined ? undefined : `${reasonId}-${a}`}
            onClick={() => {
              onAction(a);
            }}
          >
            {RUN_ACTION_LABELS[a]}
          </Button>
        );
      })}
      {reasons.map(({ action, reason }) => (
        <p key={action} id={`${reasonId}-${action}`} className="subtle small basis-full">
          {RUN_ACTION_LABELS[action]} is unavailable: {reason}
        </p>
      ))}
    </>
  );
}

function UsefulArtifacts({ run, projectId }: { readonly run: RunDetail; readonly projectId: string }) {
  const steps = usefulArtifactSteps(run);
  if (steps.length === 0) return <p>No step produced an artifact before the run stopped.</p>;
  return (
    <div className="stack">
      <p>Useful artifacts are kept:</p>
      <ul className="small">
        {steps.map((s) => (
          <li key={s.id}>
            <Link to={paths.run(projectId, run.id, { step: s.id, tab: 'output' })}>
              {stepTitle(s, run.stepMeta)} output
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The requests whose outcome is unknown, each with its possible charge and request facts (E1: the provider request
 * id, copyable, and the dispatch time), so the user can ask the provider before deciding.
 */
function UnresolvedRequests({ run }: { readonly run: RunDetail }) {
  if (run.unresolvedAttempts.length === 0) return null;
  return (
    <ul className="stack small" aria-label="Requests with an unknown outcome" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {run.unresolvedAttempts.map((a) => {
        const label = `${stepTitle(a, run.stepMeta)} · attempt ${String(a.seq)}`;
        return (
          <li key={a.id} className="stack" style={{ gap: 4 }}>
            <span>
              {label}: liability{' '}
              {a.cost === null ? 'amount not known' : <Money value={a.cost.microusd} certainty={a.cost.certainty} />}
            </span>
            <RequestFacts attempt={a} label={label} />
          </li>
        );
      })}
    </ul>
  );
}

function ReportLink({ run, projectId }: { readonly run: RunDetail; readonly projectId: string }) {
  if (run.reportArtifactId === null) return null;
  return <Link to={paths.report(projectId, run.id)}>Open the run report</Link>;
}

/** " (hash 6f4a…b18c → 9e21…04aa)" for one changed path; full values stay copyable through `Hash`. */
function FileHashChange({
  path,
  before,
  after,
  hasAfter,
}: {
  readonly path: string;
  readonly before: string | null | undefined;
  readonly after: string | null | undefined;
  readonly hasAfter: boolean;
}) {
  if (typeof before !== 'string' || !hasAfter) return null;
  return (
    <>
      {' '}
      (hash <Hash value={before} label={`previous hash of ${path}`} /> →{' '}
      {typeof after === 'string' ? (
        <Hash value={after} label={`current hash of ${path}`} />
      ) : (
        'file missing or unreadable'
      )}
      )
    </>
  );
}

interface BannerContent {
  readonly title: ReactNode;
  /** The cause and what it means (and costs): shown above the actions. */
  readonly body: ReactNode;
  /** Secondary detail under the actions: field lists, technical details (error codes). */
  readonly details?: ReactNode;
}

/** What every paused banner can draw on. */
interface PausedContext {
  readonly reason: PauseReason;
  readonly run: RunDetail;
  readonly events: readonly RunEvent[];
  readonly step: StepView | undefined;
  readonly detail: RunDetail['statusDetail'];
  /** Paused from `queued` (06 F2 clarification 9): no step ran, no attempt exists, nothing was reserved. */
  readonly notStarted: boolean;
  readonly stepKeyDetail: string | null;
  /** "Technical details" disclosure with the status detail's error code, or null. */
  readonly code: ReactNode;
}

function pausedBudget({ reason, detail, notStarted, code }: PausedContext): BannerContent {
  const b = breakdownOf(detail);
  const project = reason === 'budget_project';
  const before = notStarted ? 'Paused before the first request' : 'Paused before dispatch';
  return {
    title:
      b === null ? (
        project ? (
          `${before}: the next request would exceed the project's monthly allowance`
        ) : (
          `${before}: the next request would exceed this run's allowance`
        )
      ) : (
        <>
          {before}: the next request needs <Money value={b.N} />, only{' '}
          <Money value={microusd(Math.max(0, b.L - b.C - b.R - b.U))} /> remains
          {project ? ' this month' : ''}
        </>
      ),
    body: (
      <>
        <p>
          {notStarted
            ? 'The run has not started: nothing was sent to a provider and nothing was reserved.'
            : 'Nothing was sent to the provider. Completed steps and artifacts are kept.'}
        </p>
        {b === null ? null : <BudgetBreakdownTable breakdown={b} />}
        <p className="subtle">
          {project
            ? 'Raising the project allowance re-checks every run of this project paused for it; runs that now fit continue on their own.'
            : 'After you raise the allowance, the run continues on its own when the next request fits.'}
        </p>
      </>
    ),
    details: code,
  };
}

/** The term for the actual amount, by how sure it is (FR-09), matching the Budget card's rows. */
const ACTUAL_TERM: Readonly<Record<CostCertainty, string>> = {
  reported: 'Reported by provider',
  calculated: 'Calculated from usage',
  estimated: 'Estimated',
  unknown: 'Unknown charge',
};

/** Reserved + over = actual, all at one precision so the three amounts visibly add up. */
function overrunAmounts(o: OverrunFact): { readonly reserved: string; readonly actual: string; readonly over: string } {
  const over = o.actual - o.reserved;
  const digits = sumConsistentPrecision([o.reserved, over], o.actual);
  return {
    reserved: formatUsdAtPrecision(microusd(o.reserved), digits),
    actual: formatUsdAtPrecision(microusd(o.actual), digits),
    over: formatUsdAtPrecision(microusd(over), digits),
  };
}

/** Reserved / actual (labelled by certainty) / over, from the ledger's settle entry of the overrunning attempt. */
function OverrunFacts({ run, o }: { readonly run: RunDetail; readonly o: OverrunFact }) {
  const { entries } = useLedger(run.id);
  const certainty = useMemo(() => {
    if (o.attemptId === null) return null;
    for (const page of entries.data?.pages ?? []) {
      for (const e of page.items) {
        if (e.attemptId === o.attemptId && e.type === 'settle' && e.certainty !== null) return e.certainty;
      }
    }
    return null;
  }, [entries.data, o.attemptId]);
  const a = overrunAmounts(o);
  return (
    <KeyValueList
      items={[
        { id: 'r', term: 'Reserved', value: a.reserved, mono: true },
        {
          id: 'a',
          term: certainty === null ? 'Actual cost' : ACTUAL_TERM[certainty],
          value: certainty === 'estimated' ? `≈ ${a.actual} est.` : a.actual,
          mono: true,
        },
        { id: 'd', term: 'Over the reservation', value: a.over, mono: true },
      ]}
    />
  );
}

function pausedBudgetOverrun({ run, events, detail }: PausedContext): BannerContent {
  const o = lastOverrun(events);
  const b = breakdownOf(detail);
  const a = o === null ? null : overrunAmounts(o);
  const step = overrunStep(run, events);
  return {
    title:
      a === null ? (
        'The last call cost more than was reserved'
      ) : (
        <>
          The last call cost <span className="num">{a.actual}</span>, more than the <span className="num">{a.reserved}</span>{' '}
          reserved
        </>
      ),
    body: (
      <>
        <p>
          {step === undefined ? 'A request' : <>The <b>{stepTitle(step, run.stepMeta)}</b> request</>} used more than the reservation
          assumed. Relay recorded the true amount and paused before starting another step.
        </p>
        {o === null ? null : <OverrunFacts run={run} o={o} />}
        <p className="subtle">
          Run usage now: <Money value={microusd(run.cost.allowance - run.cost.remaining)} /> of{' '}
          <Money value={run.cost.allowance} /> allowance.
        </p>
      </>
    ),
    details: b === null ? undefined : <BudgetBreakdownTable breakdown={b} />,
  };
}

function pausedLimitAttempts({ run }: PausedContext): BannerContent {
  return {
    title: `Attempt limit reached (${String(run.limits.maxAttempts)} of ${String(run.limits.maxAttempts)})`,
    body: (
      <>
        <p>Every request counts, including retries and repairs. Nothing more was sent.</p>
        <LimitFacts run={run} />
      </>
    ),
  };
}

function pausedDeadline({ run }: PausedContext): BannerContent {
  const limit = formatDuration(run.limits.executionTimeoutSeconds * 1000);
  return {
    title: `Execution time limit reached (${formatDuration(run.executionMsUsed)} of ${limit})`,
    body: (
      <>
        <p>Time spent waiting for your approval is not counted. Nothing was sent after the limit.</p>
        <LimitFacts run={run} />
      </>
    ),
  };
}

function pausedOutputInvalid({ run, step, detail, code }: PausedContext): BannerContent {
  const err = step?.error ?? detail;
  const schemaId = stringDetail(err, 'schemaId');
  const used = numberDetail(err, 'repairsUsed');
  const max = numberDetail(err, 'repairsMax');
  const issues = issuesOf(err);
  return {
    title: `${step === undefined ? 'The step' : stepTitle(step, run.stepMeta)} returned output in the wrong format`,
    body: (
      <>
        <p>
          The model answered, but its output did not match the format the workflow expects
          {used === null ? '' : `, and ${repairsText(used, max).toLowerCase()}`}. Retry the step or choose another
          profile; finished steps are kept.
        </p>
        <p className="subtle">
          Each attempt, including repairs, was charged as tracked in the ledger. A retry sends a new request and uses
          more of the run allowance.
        </p>
      </>
    ),
    details: (
      <>
        {issues.length === 0 ? null : (
          <ValidationIssueList
            issues={issues}
            collapsed
            summary={`What did not match${schemaId === null ? '' : ` ${schemaId}`} (${String(issues.length)} field${issues.length === 1 ? '' : 's'})`}
          />
        )}
        <RawResponseToggle artifactId={stringDetail(err, 'rawResponseArtifactId')} />
        {code}
      </>
    ),
  };
}

function pausedProviderUnavailable({ step, detail }: PausedContext): BannerContent {
  const err = step?.error ?? detail;
  return {
    title: 'The provider did not respond after a retry',
    body: (
      <>
        <p>
          {providerName(stringDetail(err, 'providerId'))} could not be reached. Failed requests before any
          output are not charged; the reservation was released. Completed steps are kept.
        </p>
      </>
    ),
    details: <TechnicalDetails error={err} />,
  };
}

function pausedModelRefused({ step, detail }: PausedContext): BannerContent {
  const err = step?.error ?? detail;
  return {
    title: 'The model declined this step',
    body: (
      <>
        <p>
          {providerName(stringDetail(err, 'providerId'))} declined the request. Relay does not retry a
          declined request on its own. Try another permitted profile, or stop the run.
        </p>
        <p className="subtle">The goal is part of the approved plan, so a different goal starts a new run.</p>
      </>
    ),
    details: <TechnicalDetails error={err} />,
  };
}

function pausedSetupBlocked({ detail, notStarted, stepKeyDetail, code }: PausedContext): BannerContent {
  return {
    title: notStarted
      ? 'A setup check failed before the run started'
      : 'A setup check failed before the step could start',
    body: (
      <>
        <p>{detail?.userMessage ?? 'Relay could not start the next step with the current setup.'}</p>
        {notStarted ? <p>Nothing was sent to a provider and nothing was reserved.</p> : null}
        {stepKeyDetail === null ? null : <p className="subtle">Step: {stepKeyLabel(stepKeyDetail)}</p>}
        {stringDetail(detail, 'modelId') === null ? null : (
          <p className="subtle">
            Model <span className="mono">{stringDetail(detail, 'modelId')}</span>
            {stringDetail(detail, 'reason') === null ? null : `: ${String(stringDetail(detail, 'reason'))}`}
          </p>
        )}
        <p className="subtle">
          Resume re-runs the checks. Choosing another profile records a configuration revision.
        </p>
      </>
    ),
    details: code,
  };
}

function pausedUnknownOutcome({ run }: PausedContext): BannerContent {
  if (run.unresolvedAttempts.length === 0) {
    // Every unknown request is decided (06 F2): the run can resume from its last completed step.
    return {
      title: 'Every request with an unknown outcome has been decided',
      body: (
        <p>
          Resume continues the run from its last completed step. Stop ends it; finished steps and costs are
          kept.
        </p>
      ),
    };
  }
  return {
    title: 'The request may have been sent; its charge is unknown',
    body: (
      <>
        <p>
          Relay cannot confirm whether the provider processed the request. The possible charge is kept as
          unknown liability until you decide. Nothing is retried on its own.
        </p>
        <UnresolvedRequests run={run} />
      </>
    ),
  };
}

function pausedAuthRequired({ detail, notStarted, stepKeyDetail }: PausedContext): BannerContent {
  if (notStarted) {
    // Queued → paused(auth_required): no credential ref for a provider the run needs (06 F13 runChecks).
    return {
      title: `No API key is connected for ${providerName(stringDetail(detail, 'providerId'))}`,
      body: (
        <>
          <p>
            The run has not started: nothing was sent to a provider and nothing was reserved. Connect the
            provider in Settings, then resume.
          </p>
          {stepKeyDetail === null ? null : <p className="subtle">Needed by: {stepKeyLabel(stepKeyDetail)}</p>}
          <p className="subtle">Relay does not show or log the key.</p>
        </>
      ),
    };
  }
  return {
    title: `${providerName(stringDetail(detail, 'providerId'))} rejected the stored credential`,
    body: (
      <>
        <p>
          Reconnect the provider, then resume. The request was refused before any work started, so no charge
          is expected. Completed steps are kept.
        </p>
        <p className="subtle">
          Authentication failures pause immediately and are never retried automatically. Relay does not show
          or log the key.
        </p>
      </>
    ),
  };
}

function pausedUser({}: PausedContext): BannerContent {
  return {
    title: 'Paused by you',
    body: (
      <p>
        The in-flight request (if any) completed and its output was kept. No new step starts until you resume.
      </p>
    ),
  };
}

function pausedRateLimited({ code }: PausedContext): BannerContent {
  return {
    title: 'Provider rate limit: waits exhausted',
    body: (
      <>
        <p>
          The provider kept limiting requests after the allowed waits, so Relay paused instead of waiting
          longer. Rejected requests did no work and are not charged.
        </p>
      </>
    ),
    details: code,
  };
}

function pausedApprovalStale({ detail, code }: PausedContext): BannerContent {
  const listed = stringListDetail(detail, 'changedPaths');
  const before = hashMapDetail(detail, 'before');
  const after = hashMapDetail(detail, 'after');
  const changed = listed.length > 0 ? listed : [...new Set([...before.keys(), ...after.keys()])];
  return {
    title: 'Project files changed after the plan was proposed',
    body: (
      <>
        {changed.length === 0 ? (
          <p>The plan or its context snapshot changed, so the approval no longer matches.</p>
        ) : (
          <ul className="small">
            {changed.map((p) => (
              <li key={p}>
                <span className="mono">{p}</span> changed since the context snapshot
                <FileHashChange
                  path={p}
                  before={before.get(p)}
                  after={after.get(p)}
                  hasAfter={after.has(p)}
                />
              </li>
            ))}
          </ul>
        )}
        <p>
          Re-snapshot and re-plan captures the current files and asks for a new approval. Using the preserved
          snapshot keeps the old file contents; the patch may not apply cleanly.
        </p>
      </>
    ),
    details: code,
  };
}

/** Banner content per pause reason. Typed over every PauseReason: a new contracts member is a compile error here. */
const PAUSED_CONTENT: { readonly [R in PauseReason]: (ctx: PausedContext) => BannerContent } = {
  budget_run: pausedBudget,
  budget_project: pausedBudget,
  budget_overrun: pausedBudgetOverrun,
  limit_attempts: pausedLimitAttempts,
  deadline: pausedDeadline,
  output_invalid: pausedOutputInvalid,
  provider_unavailable: pausedProviderUnavailable,
  model_refused: pausedModelRefused,
  setup_blocked: pausedSetupBlocked,
  unknown_outcome: pausedUnknownOutcome,
  auth_required: pausedAuthRequired,
  user: pausedUser,
  rate_limited: pausedRateLimited,
  approval_stale: pausedApprovalStale,
};

function pausedContent(
  reason: PauseReason,
  run: RunDetail,
  events: readonly RunEvent[],
  step: StepView | undefined,
): BannerContent {
  const detail = run.statusDetail;
  const code = <TechnicalDetails error={detail} />;
  return PAUSED_CONTENT[reason]({
    reason,
    run,
    events,
    step,
    detail,
    notStarted: run.startedAt === null,
    stepKeyDetail: stringDetail(detail, 'stepKey'),
    code,
  });
}

const INCOMPLETE_BODY: Readonly<Record<IncompleteCause | 'unknown', string>> = {
  revision_limit:
    'The reviewer still requested changes when the revision limit was reached. No further revisions were started.',
  verifier_incomplete:
    'The workflow reviewer did not accept the patch and no further revision was requested.',
  unknown: 'The workflow ended before its reviewer accepted a patch.',
};

function LimitFacts({ run }: { readonly run: RunDetail }) {
  return (
    <KeyValueList
      items={[
        { id: 'attempts', term: 'Attempt limit', value: String(run.limits.maxAttempts) },
        {
          id: 'time',
          term: 'Execution time',
          value: `${formatDuration(run.executionMsUsed)} of ${formatDuration(run.limits.executionTimeoutSeconds * 1000)}`,
        },
        { id: 'wait', term: 'Approval wait', value: 'Not counted' },
      ]}
    />
  );
}

function statusContent(
  run: RunDetail,
  projectId: string,
  events: readonly RunEvent[],
  step: StepView | undefined,
  lastShutdown: LastShutdown | null | undefined,
): BannerContent | null {
  switch (run.status) {
    case 'queued':
    case 'running':
    case 'awaiting_approval':
      return null;
    case 'paused':
      return run.pauseReason === null
        ? { title: 'Paused', body: <p>The run is paused. No new step starts until you resume.</p> }
        : pausedContent(run.pauseReason, run, events, step);
    case 'interrupted': {
      // E2: the cause follows how the previous session ended (a clean quit, or the runner stopped responding).
      const cause = interruptionCauseOf(lastShutdown);
      const stuck = interruptedStep(run);
      return {
        title: 'Relay stopped while this run was in progress',
        body: (
          <>
            <p>
              {INTERRUPTION_LEAD[cause]}
              <b>{stuck === undefined ? 'a step' : stepTitle(stuck, run.stepMeta)}</b> was running.{' '}
              {cause === 'runner_stopped' ? 'Relay restarted it and did not' : 'Relay did not'} resume or retry anything
              on its own. Your approvals and completed artifacts are kept.
            </p>
            <UnresolvedRequests run={run} />
          </>
        ),
      };
    }
    case 'cancelling':
      return {
        title: 'Cancellation requested; waiting for the in-flight request to stop (best effort)',
        body: (
          <p>
            No new steps will start. The provider may still finish and charge for the in-flight request; its
            reservation stays until the outcome is known.
          </p>
        ),
      };
    case 'cancelled':
      return {
        title: 'Run cancelled',
        body: (
          <>
            {run.unresolvedAttempts.length > 0 ? (
              <div className="stack">
                <p>
                  These requests have no confirmed charge; the possible amount stays as unknown liability:
                </p>
                <UnresolvedRequests run={run} />
              </div>
            ) : (
              <p>No request is waiting for a charge to be confirmed.</p>
            )}
            <UsefulArtifacts run={run} projectId={projectId} />
            <ReportLink run={run} projectId={projectId} />
          </>
        ),
      };
    case 'failed':
      return {
        title: 'Run failed because of an internal error',
        body: (
          <>
            <p>The run cannot continue; start a new run to try again.</p>
            <UsefulArtifacts run={run} projectId={projectId} />
            <p>
              <Link to={paths.settings('diagnostics')}>Open diagnostics</Link>
            </p>
          </>
        ),
        details: <TechnicalDetails error={run.statusDetail} />,
      };
    case 'completed': {
      const verify = [...run.steps].reverse().find((s) => s.outcome === 'accept');
      return {
        title: verify === undefined ? 'Completed' : 'Accepted by the workflow reviewer',
        body: (
          <>
            <p>
              Completed means the configured workflow accepted its output. It does not guarantee the code is
              correct. Review the patch before applying it. Original project files were not modified.
            </p>
            {/* The report is one click away in the page header ("View report"). */}
            <RunSuggestionsLink projectId={projectId} runId={run.id} />
          </>
        ),
      };
    }
    case 'incomplete':
      return {
        title: incompleteTitle(run),
        body: (
          <>
            <p>{INCOMPLETE_BODY[incompleteCauseOf(run) ?? 'unknown']}</p>
            <UsefulArtifacts run={run} projectId={projectId} />
            <ReportLink run={run} projectId={projectId} />
          </>
        ),
      };
  }
}

/** The run-level banner above the step panel. Returns null for statuses that need none (running, queued, approval). */
function StatusBannerView({
  run,
  projectId,
  events,
  onAction,
  onRecoveryAction,
  pending,
  busy,
  disabledReasons,
}: StatusBannerProps) {
  const step = blockedStep(run);
  const lastShutdown = useAppInfo().data?.lastShutdown;
  const content = statusContent(run, projectId, events, step, lastShutdown);
  if (content === null) return null;
  const p = statusPresentation('run', run.status, run.pauseReason);
  const recovery =
    run.status === 'interrupted' || (run.status === 'paused' && run.pauseReason === 'unknown_outcome');
  const actions = bannerActions(run);
  return (
    <div className="stack" data-testid="status-banner">
      <InlineAlert
        tone={p.tone}
        title={content.title}
        footer={content.details}
        actions={
          recovery ? undefined : actions.length > 0 ? (
            <ActionButtons
              actions={actions}
              onAction={onAction}
              pending={pending}
              busy={busy}
              disabledReasons={disabledReasons}
            />
          ) : undefined
        }
      >
        {/* The page header already shows the run's status badge: the banner states the cause and the actions once. */}
        {content.body}
      </InlineAlert>
      {recovery ? (
        <RecoveryPanel
          run={run}
          onDecide={onRecoveryAction}
          pendingAction={pending}
          attemptDecisions={UNKNOWN_OUTCOME_DECISIONS}
        />
      ) : null}
    </div>
  );
}

/** Memoized (PERF-02): re-renders only when its props change, not on every parent tick. */
export const StatusBanner = memo(StatusBannerView);
