// Run status banners (10 J8 StatusBanner table): status / pause reason → InlineAlert + the action buttons. The
// mapping is exhaustive over `pauseReasonSchema` and `runStatusSchema` (a new member is a compile error), and every
// button comes from `RunDetail.availableActions` (the server's 06 F2 table): nothing here re-derives run policy.
import { useId } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { microusd } from '@relay/contracts';
import type { PauseReason, RunAction, RunDetail, RunEvent, StepView } from '@relay/contracts';
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
  StatusBadge,
} from '../../components/ui';
import type { RecoveryDecisionDetail } from '../../components/ui';
import { DESTRUCTIVE_RUN_ACTIONS, formatDuration, PROVIDER_LABELS, RUN_ACTION_LABELS, statusPresentation } from '../../lib/format';
import { paths } from '../shell/paths';
import {
  bannerActions,
  blockedStep,
  breakdownOf,
  incompleteCauseOf,
  incompleteTitle,
  issuesOf,
  lastOverrun,
  numberDetail,
  stepTitle,
  stringDetail,
  stringListDetail,
  usefulArtifactSteps,
} from './inspector-model';
import type { IncompleteCause } from './inspector-model';
import { planRunAction } from './run-actions';
import { RawResponseToggle, repairsText, ValidationIssueList } from './StepIssues';

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
            <Link to={paths.run(projectId, run.id, { step: s.id, tab: 'output' })}>{stepTitle(s)} output</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReportLink({ run, projectId }: { readonly run: RunDetail; readonly projectId: string }) {
  if (run.reportArtifactId === null) return null;
  return <Link to={paths.report(projectId, run.id)}>Open the run report</Link>;
}

interface BannerContent {
  readonly title: ReactNode;
  readonly body: ReactNode;
}

function pausedContent(reason: PauseReason, run: RunDetail, events: readonly RunEvent[], step: StepView | undefined): BannerContent {
  const detail = run.statusDetail;
  const code = detail === null ? null : (
    <p className="subtle">
      Error code <code>{detail.code}</code>
    </p>
  );
  switch (reason) {
    case 'budget_run':
    case 'budget_project': {
      const b = breakdownOf(detail);
      const project = reason === 'budget_project';
      return {
        title:
          b === null
            ? project
              ? "Paused before dispatch: the next request would exceed the project's monthly allowance"
              : "Paused before dispatch: the next request would exceed this run's allowance"
            : (
                <>
                  Paused before dispatch: the next request needs <Money value={b.N} />, only{' '}
                  <Money value={microusd(Math.max(0, b.L - b.C - b.R - b.U))} /> remains
                  {project ? ' this month' : ''}
                </>
              ),
        body: (
          <>
            <p>Nothing was sent to the provider. Completed steps and artifacts are kept.</p>
            {b === null ? null : <BudgetBreakdownTable breakdown={b} />}
            <p className="subtle">
              {project
                ? 'Raising the project allowance re-checks every run of this project paused for it; runs that now fit continue on their own.'
                : 'After you raise the allowance, the run continues on its own when the next request fits.'}
            </p>
            {code}
          </>
        ),
      };
    }
    case 'budget_overrun': {
      const o = lastOverrun(events);
      const b = breakdownOf(detail);
      return {
        title:
          o === null ? (
            'The last call cost more than was reserved'
          ) : (
            <>
              The last call cost <Money value={microusd(o.actual)} />, more than the <Money value={microusd(o.reserved)} /> reserved
            </>
          ),
        body: (
          <>
            <p>
              The provider reported more usage than the reservation assumed. Relay recorded the true amount and paused
              before starting another step.
            </p>
            {o === null ? null : (
              <KeyValueList
                items={[
                  { id: 'r', term: 'Reserved', value: <Money value={microusd(o.reserved)} /> },
                  { id: 'a', term: 'Reported by provider', value: <Money value={microusd(o.actual)} /> },
                  { id: 'd', term: 'Over the reservation', value: <Money value={microusd((o.actual - o.reserved))} /> },
                ]}
              />
            )}
            {b === null ? null : <BudgetBreakdownTable breakdown={b} />}
            <p className="subtle">
              Run usage now: <Money value={microusd((run.cost.allowance - run.cost.remaining))} /> of{' '}
              <Money value={run.cost.allowance} /> allowance.
            </p>
          </>
        ),
      };
    }
    case 'limit_attempts':
      return {
        title: `Attempt limit reached (${String(run.limits.maxAttempts)} of ${String(run.limits.maxAttempts)})`,
        body: (
          <>
            <p>Every request counts, including retries and repairs. Nothing more was sent.</p>
            <LimitFacts run={run} />
          </>
        ),
      };
    case 'deadline': {
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
    case 'output_invalid': {
      const err = step?.error ?? detail;
      const schemaId = stringDetail(err, 'schemaId');
      const used = numberDetail(err, 'repairsUsed');
      const max = numberDetail(err, 'repairsMax');
      return {
        title: schemaId === null ? 'The output did not match the expected format' : `The output did not match ${schemaId}`,
        body: (
          <>
            <ValidationIssueList issues={issuesOf(err)} />
            {used === null ? null : <p>{repairsText(used, max)}. The step failed and the run is paused.</p>}
            <RawResponseToggle artifactId={stringDetail(err, 'rawResponseArtifactId')} />
            {code}
          </>
        ),
      };
    }
    case 'provider_unavailable': {
      const err = step?.error ?? detail;
      return {
        title: 'The provider did not respond after a retry',
        body: (
          <>
            <p>
              {providerName(stringDetail(err, 'providerId'))} could not be reached. Failed requests before any output are
              not charged; the reservation was released. Completed steps are kept.
            </p>
            {err === null ? null : (
              <p className="subtle">
                Error code <code>{err.code}</code>
              </p>
            )}
          </>
        ),
      };
    }
    case 'model_refused': {
      const err = step?.error ?? detail;
      return {
        title: 'The model declined this step',
        body: (
          <>
            <p>
              {providerName(stringDetail(err, 'providerId'))} declined the request. Relay does not retry a declined request on
              its own. Try another permitted profile, or stop the run.
            </p>
            <p className="subtle">The goal is part of the approved plan, so a different goal starts a new run.</p>
            {err === null ? null : (
              <p className="subtle">
                Error code <code>{err.code}</code>
              </p>
            )}
          </>
        ),
      };
    }
    case 'setup_blocked':
      return {
        title: 'A setup check failed before the step could start',
        body: (
          <>
            <p>{detail?.userMessage ?? 'Relay could not start the next step with the current setup.'}</p>
            {stringDetail(detail, 'modelId') === null ? null : (
              <p className="subtle">
                Model <span className="mono">{stringDetail(detail, 'modelId')}</span>
                {stringDetail(detail, 'reason') === null ? null : `: ${String(stringDetail(detail, 'reason'))}`}
              </p>
            )}
            <p className="subtle">Resume re-runs the checks. Choosing another profile records a configuration revision.</p>
            {code}
          </>
        ),
      };
    case 'unknown_outcome':
      return {
        title: 'The request may have been sent; its charge is unknown',
        body: (
          <p>
            Relay cannot confirm whether the provider processed the request. The possible charge is kept as unknown
            liability until you decide. Nothing is retried on its own.
          </p>
        ),
      };
    case 'auth_required':
      return {
        title: `${providerName(stringDetail(detail, 'providerId'))} rejected the stored credential`,
        body: (
          <>
            <p>
              Reconnect the provider, then resume. The request was refused before any work started, so no charge is
              expected. Completed steps are kept.
            </p>
            <p className="subtle">
              Authentication failures pause immediately and are never retried automatically. Relay does not show or log the
              key.
            </p>
          </>
        ),
      };
    case 'user':
      return {
        title: 'Paused by you',
        body: <p>The in-flight request (if any) completed and its output was kept. No new step starts until you resume.</p>,
      };
    case 'rate_limited':
      return {
        title: 'Provider rate limit: waits exhausted',
        body: (
          <>
            <p>
              The provider kept limiting requests after the allowed waits, so Relay paused instead of waiting longer.
              Rejected requests did no work and are not charged.
            </p>
            {code}
          </>
        ),
      };
    case 'approval_stale': {
      const changed = stringListDetail(detail, 'changedPaths');
      const before = stringDetail(detail, 'before');
      const after = stringDetail(detail, 'after');
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
                    {before !== null && after !== null ? (
                      <>
                        {' '}
                        (hash <Hash value={before} label="previous file hash" /> → <Hash value={after} label="current file hash" />)
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <p>
              Re-snapshot and re-plan captures the current files and asks for a new approval. Using the preserved snapshot
              keeps the old file contents; the patch may not apply cleanly.
            </p>
            {code}
          </>
        ),
      };
    }
  }
}

const INCOMPLETE_BODY: Readonly<Record<IncompleteCause | 'unknown', string>> = {
  revision_limit: 'The reviewer still requested changes when the revision limit was reached. No further revisions were started.',
  verifier_incomplete: 'The workflow reviewer did not accept the patch and no further revision was requested.',
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

function statusContent(run: RunDetail, projectId: string, events: readonly RunEvent[], step: StepView | undefined): BannerContent | null {
  switch (run.status) {
    case 'queued':
    case 'running':
    case 'awaiting_approval':
      return null;
    case 'paused':
      return run.pauseReason === null
        ? { title: 'Paused', body: <p>The run is paused. No new step starts until you resume.</p> }
        : pausedContent(run.pauseReason, run, events, step);
    case 'interrupted':
      return {
        title: 'Relay stopped while this run was in progress',
        body: (
          <p>
            The background runner stopped responding. Relay restarted it and did not resume or retry anything on its own.
            Your approvals and completed artifacts are kept.
          </p>
        ),
      };
    case 'cancelling':
      return {
        title: 'Cancellation requested; waiting for the in-flight request to stop (best effort)',
        body: (
          <p>
            No new steps will start. The provider may still finish and charge for the in-flight request; its reservation
            stays until the outcome is known.
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
                <p>These requests have no confirmed charge; the possible amount stays as unknown liability:</p>
                <ul className="small">
                  {run.unresolvedAttempts.map((a) => (
                    <li key={a.id}>
                      {stepTitle(a)} · attempt {a.seq}: liability{' '}
                      {a.cost === null ? 'amount not known' : <Money value={a.cost.microusd} certainty={a.cost.certainty} />}
                    </li>
                  ))}
                </ul>
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
            {run.statusDetail === null ? null : (
              <p className="subtle">
                Error code <code>{run.statusDetail.code}</code>
                {run.statusDetail.correlationId === undefined ? null : (
                  <>
                    {' '}
                    · reference <code>{run.statusDetail.correlationId}</code> (include it if you report the problem; it
                    contains no project data)
                  </>
                )}
              </p>
            )}
            <UsefulArtifacts run={run} projectId={projectId} />
            <p>
              <Link to={paths.settings('diagnostics')}>Open diagnostics</Link>
            </p>
          </>
        ),
      };
    case 'completed': {
      const verify = [...run.steps].reverse().find((s) => s.outcome === 'accept');
      return {
        title: verify === undefined ? 'Completed' : 'Accepted by the workflow reviewer',
        body: (
          <>
            <p>
              Completed means the configured workflow accepted its output. It does not guarantee the code is correct.
              Review the patch before applying it. Original project files were not modified.
            </p>
            <ReportLink run={run} projectId={projectId} />
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
export function StatusBanner({ run, projectId, events, onAction, onRecoveryAction, pending, busy, disabledReasons }: StatusBannerProps) {
  const step = blockedStep(run);
  const content = statusContent(run, projectId, events, step);
  if (content === null) return null;
  const p = statusPresentation('run', run.status, run.pauseReason);
  const recovery = run.status === 'interrupted' || (run.status === 'paused' && run.pauseReason === 'unknown_outcome');
  const actions = bannerActions(run);
  return (
    <div className="stack" data-testid="status-banner">
      <InlineAlert
        tone={p.tone}
        title={content.title}
        actions={
          recovery ? undefined : actions.length > 0 ? (
            <ActionButtons actions={actions} onAction={onAction} pending={pending} busy={busy} disabledReasons={disabledReasons} />
          ) : undefined
        }
      >
        {recovery ? null : (
          <p>
            <StatusBadge kind="run" value={run.status} pauseReason={run.pauseReason} showDetail />
          </p>
        )}
        {content.body}
      </InlineAlert>
      {recovery ? (
        <RecoveryPanel run={run} onDecide={onRecoveryAction} pendingAction={pending} attemptDecisions={UNKNOWN_OUTCOME_DECISIONS} />
      ) : null}
    </div>
  );
}
