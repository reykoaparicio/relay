import { useId } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Box, Plug, ShieldCheck } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { addMicrousd } from '@relay/contracts';
import type { OutputOf, ProjectDetail, RunAction, RunDetail, RunSummary, WorkflowLimits } from '@relay/contracts';
import {
  BudgetMeter,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  DataTable,
  ErrorView,
  Hash,
  InlineAlert,
  KeyValueList,
  Money,
  RecoveryPanel,
  RelativeTime,
  Skeleton,
  StatusBadge,
  StatTile,
} from '../../components/ui';
import { formatMonth, statusPresentation, stepKeyLabel } from '../../lib/format';
import { call } from '../../api/client';
import { toViewError } from '../../api/errors';
import { qk } from '../../api/keys';
import { useIdempotentMutation } from '../../hooks/useIdempotentMutation';
import { RUNS_MAX_PAGE } from '../../hooks/useRuns';
import { useAppInfo } from '../../hooks/useAppInfo';
import { defaultStep, INTERRUPTION_LEAD, interruptedStep, interruptionCauseOf, stepTitle } from '../run-inspector/inspector-model';
import { useRunActions } from '../run-inspector/useRunActions';
import { runLabel, RunCost } from '../runs/run-display';
import { href, paths } from '../shell/paths';
import type { DisconnectedProvider } from './overview-model';

function SafeNote() {
  return (
    <p className="safe-note">
      <ShieldCheck aria-hidden="true" />
      No project files have been modified.
    </p>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Stat tiles

export interface OverviewStatsProps {
  readonly project: ProjectDetail;
  readonly activeCount: number;
  /** More active runs exist than one page counts: shown as "100+". */
  readonly activeCapped?: boolean;
  readonly activeHint: string;
  readonly tracked: OutputOf<'relay/v1/ledger.projectSummary'> | undefined;
  readonly latestRunId: string | undefined;
  readonly now: number;
}

/** Active runs · Usage tracked by Relay · Project memory (§5.2). */
export function OverviewStats({ project, activeCount, activeCapped = false, activeHint, tracked, latestRunId, now }: OverviewStatsProps) {
  const suggestions = project.stats.suggestions;
  const approved = project.stats.approvedMemory;
  return (
    <section className="grid grid-cols-3 gap-5" aria-label="Project summary">
      <StatTile
        label="Active runs"
        value={<span className="num">{activeCapped ? `${String(RUNS_MAX_PAGE)}+` : activeCount}</span>}
        hint={activeHint}
      />
      <StatTile
        label="Usage tracked by Relay"
        labelAside={formatMonth(now)}
        value={tracked === undefined ? '…' : <Money value={tracked.trackedMicrousd} />}
        hint={
          <>
            {tracked === undefined || tracked.reservedMicrousd === 0 ? (
              'Nothing reserved in flight'
            ) : (
              <>
                <Money value={tracked.reservedMicrousd} /> reserved in flight
              </>
            )}
            {tracked !== undefined && tracked.unknownMicrousd > 0 ? (
              <>
                {' '}· <Money value={tracked.unknownMicrousd} certainty="unknown" /> unresolved
              </>
            ) : null}
            <span className="mt-1 block">Only calls made through Relay. Your provider account bill may be higher.</span>
          </>
        }
        {...(latestRunId === undefined
          ? {}
          : { secondaryAction: <Link to={paths.run(project.id, latestRunId, { tab: 'ledger' })}>Open usage ledger</Link> })}
      />
      <StatTile
        label="Project memory"
        value={<span className="num">{approved}</span>}
        hint={`approved record${approved === 1 ? '' : 's'}`}
        secondaryAction={
          suggestions > 0 ? (
            <Link to={paths.memory(project.id, { tab: 'suggested' })}>
              {suggestions} suggestion{suggestions === 1 ? '' : 's'} to review
            </Link>
          ) : (
            <Link to={paths.memory(project.id)}>Manage memory</Link>
          )
        }
      />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Banners

export function InterruptedBanner({ projectId, run }: { readonly projectId: string; readonly run: RunDetail }) {
  const lastDone = [...run.steps].reverse().find((s) => s.state === 'succeeded');
  // E2: an interrupted run's cause follows how the previous session ended (clean quit vs the runner stopped).
  const lastShutdown = useAppInfo().data?.lastShutdown;
  const interruptedAt = interruptedStep(run);
  const liability = addMicrousd(...run.unresolvedAttempts.flatMap((a) => (a.cost === null ? [] : [a.cost.microusd])));
  const unknownStep = run.unresolvedAttempts[0]?.stepRunId ?? interruptedAt?.id;
  const title =
    run.status === 'interrupted'
      ? `${runLabel(run.id)} was interrupted`
      : `${runLabel(run.id)} is paused: unknown request outcome`;
  return (
    <InlineAlert
      tone="warning"
      title={title}
      actions={
        <ButtonLink
          as={Link}
          variant="primary"
          icon={ArrowRight}
          to={paths.run(projectId, run.id, unknownStep === undefined ? {} : { step: unknownStep })}
        >
          Review recovery options
        </ButtonLink>
      }
    >
      <p>
        {run.status === 'interrupted' ? INTERRUPTION_LEAD[interruptionCauseOf(lastShutdown)] : 'Relay lost track of the request while '}
        <b>{interruptedAt === undefined ? 'a step' : stepTitle(interruptedAt, run.stepMeta)}</b> was running. The last completed step is{' '}
        <b>{lastDone === undefined ? 'none yet' : stepTitle(lastDone, run.stepMeta)}</b>. Completed outputs are intact and
        will not be re-run automatically.
      </p>
      {run.unresolvedAttempts.length > 0 ? (
        <p className="inline-flex flex-wrap items-center gap-2">
          <StatusBadge kind="certainty" value="unknown" />
          {run.unresolvedAttempts.length} unresolved request{run.unresolvedAttempts.length === 1 ? '' : 's'} may already
          have incurred a charge. Up to <Money value={liability} certainty="unknown" /> is held as unresolved
          liability until you decide.
        </p>
      ) : null}
    </InlineAlert>
  );
}

export function ProviderBanner({ projectId, provider }: { readonly projectId: string; readonly provider: DisconnectedProvider }) {
  const key = provider.redactedLabel === null ? null : <span className="mono">{provider.redactedLabel}</span>;
  return (
    <InlineAlert
      tone="danger"
      title={
        provider.source === 'run'
          ? `${provider.displayName} sign-in needed: a run is paused`
          : `Authentication failed for ${provider.displayName}`
      }
      actions={
        <>
          <ButtonLink as={Link} variant="danger" icon={Plug} to={paths.settings('providers')}>
            Reconnect {provider.displayName}
          </ButtonLink>
          {provider.source === 'run' && provider.runId !== undefined ? (
            <ButtonLink as={Link} variant="ghost" to={paths.run(projectId, provider.runId)}>
              Open {runLabel(provider.runId).toLowerCase()}
            </ButtonLink>
          ) : (
            <ButtonLink as={Link} variant="ghost" to={paths.settings('providers')}>
              Open provider settings
            </ButtonLink>
          )}
        </>
      }
    >
      {provider.source === 'run' && provider.runId !== undefined ? (
        <p>
          {runLabel(provider.runId)} paused because {provider.displayName} rejected the stored key {key}. Reconnect the
          provider, then resume the run; it continues from its last completed step. No charge is expected for the
          refused request.
        </p>
      ) : (
        <p>
          The stored key {key} was rejected during the last connection test. Workflows that use {provider.displayName}{' '}
          cannot start until it is reconnected. No requests were sent with this key.
        </p>
      )}
    </InlineAlert>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Attention cards

function AttentionTitle({ run }: { readonly run: Pick<RunSummary, 'id' | 'workflow' | 'goal'> }) {
  return (
    <p className="text-lg font-medium">
      {run.workflow.name} <span className="subtle mono">{runLabel(run.id)}</span>
      <span className="muted block text-sm font-normal">{run.goal}</span>
    </p>
  );
}

/** Awaiting approval: the exact pending step (§5.2). */
export function ApprovalAttentionCard({ projectId, run }: { readonly projectId: string; readonly run: RunDetail }) {
  const titleId = useId();
  const approvalStep = run.steps.find((s) => s.state === 'awaiting_approval');
  const approval = run.pendingApproval;
  const stepPath = paths.run(projectId, run.id, approvalStep === undefined ? {} : { step: approvalStep.id });
  return (
    <Card labelledBy={titleId}>
      <CardHeader
        title="Needs your attention"
        titleId={titleId}
        actions={<StatusBadge kind="run" value={run.status} pauseReason={run.pauseReason} />}
      />
      <div className="stack">
        <AttentionTitle run={run} />
        {approval === null ? null : (
          <p className="muted">
            The planner proposes changes to {approval.fileScope.length} file{approval.fileScope.length === 1 ? '' : 's'}.
            Approval covers plan <Hash value={approval.planHash} /> only.
          </p>
        )}
        <SafeNote />
      </div>
      <div className="row">
        <ButtonLink as={Link} variant="primary" to={stepPath}>
          Inspect plan
        </ButtonLink>
        <ButtonLink as={Link} to={paths.run(projectId, run.id)}>
          View {runLabel(run.id).toLowerCase()}
        </ButtonLink>
      </div>
    </Card>
  );
}

/** A running run with no approval pending. */
export function ActiveRunCard({ projectId, run }: { readonly projectId: string; readonly run: RunDetail }) {
  const titleId = useId();
  const actions = useRunActions({ runId: run.id, projectId });
  const current = run.steps.find((s) => s.state === 'executing' || s.state === 'validating' || s.state === 'reserved' || s.state === 'ready');
  const index = current === undefined ? -1 : run.steps.indexOf(current);
  return (
    <Card labelledBy={titleId}>
      <CardHeader title="Active run" titleId={titleId} actions={<StatusBadge kind="run" value={run.status} />} />
      <div className="stack">
        <AttentionTitle run={run} />
        {current === undefined ? null : (
          <p className="muted">
            Step {index + 1} of {run.steps.length} · <b>{stepKeyLabel(current.stepKey)}</b>
            {current.providerId === null ? null : (
              <>
                {' '}· {current.profileName} profile
              </>
            )}
          </p>
        )}
        <Link to={paths.run(projectId, run.id, { tab: 'ledger' })} className="no-underline">
          <span className="sr-only">Run budget, open the ledger: </span>
          <BudgetMeter cost={run.cost} />
        </Link>
        <SafeNote />
      </div>
      {actions.error === null ? null : (
        <ErrorView live="assertive" error={toViewError(actions.error)} onAction={actions.clearError} />
      )}
      <div className="row">
        <ButtonLink as={Link} variant="primary" to={paths.run(projectId, run.id, current === undefined ? {} : { step: current.id })}>
          Open current step
        </ButtonLink>
        {run.availableActions.includes('pause') ? (
          <Button
            pending={actions.pending === 'pause'}
            disabled={actions.busy && actions.pending !== 'pause'}
            onClick={() => {
              void actions.dispatch({ action: 'pause', runId: run.id });
            }}
          >
            Pause after this step
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * A paused run waiting for the user (any pause reason other than unknown outcome, which gets the RecoveryPanel): the
 * pause label, what it means, and a link to the step it is blocked on.
 */
export function PausedAttentionCard({
  projectId,
  run,
  otherPaused,
}: {
  readonly projectId: string;
  readonly run: RunDetail;
  /** Other paused runs not shown in this card. */
  readonly otherPaused: number;
}) {
  const titleId = useId();
  const presentation = statusPresentation('run', run.status, run.pauseReason);
  const step = defaultStep(run);
  return (
    <Card labelledBy={titleId}>
      <CardHeader
        title="Needs your attention"
        titleId={titleId}
        actions={<StatusBadge kind="run" value={run.status} pauseReason={run.pauseReason} />}
      />
      <div className="stack">
        <AttentionTitle run={run} />
        <p>
          <b>{presentation.label}.</b>{' '}
          {presentation.detail === undefined ? null : `${presentation.detail}.`}
          {step === undefined ? null : (
            <>
              {' '}Blocked at <b>{stepKeyLabel(step.stepKey)}</b>.
            </>
          )}
        </p>
        <SafeNote />
      </div>
      <div className="row">
        <ButtonLink as={Link} variant="primary" to={paths.run(projectId, run.id, step === undefined ? {} : { step: step.id })}>
          {step === undefined ? 'Open run' : 'Open blocked step'}
        </ButtonLink>
        {otherPaused > 0 ? (
          <Link to={paths.runs(projectId, 'paused')}>
            {otherPaused} more paused run{otherPaused === 1 ? '' : 's'}
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

/** Interrupted or unknown-outcome run: RecoveryPanel (§4.4). Decisions that need the inspector go there. */
export function RecoveryAttention({ projectId, run }: { readonly projectId: string; readonly run: RunDetail }) {
  const navigate = useNavigate();
  const actions = useRunActions({ runId: run.id, projectId });
  const onDecide = (action: RunAction) => {
    const stepId = run.unresolvedAttempts[0]?.stepRunId;
    if (action === 'stop' || action === 'cancel' || action === 'review_recovery') {
      void actions.dispatch({ action, runId: run.id });
      return;
    }
    // decide_unknown (3 choices), retry_step, choose_profile need the step context of the inspector.
    void navigate(paths.run(projectId, run.id, stepId === undefined ? {} : { step: stepId }));
  };
  return (
    <div className="stack">
      <RecoveryPanel run={run} onDecide={onDecide} pendingAction={actions.pending} />
      {actions.error === null ? null : <ErrorView live="assertive" error={toViewError(actions.error)} onAction={actions.clearError} />}
      <SafeNote />
    </div>
  );
}

/** Empty project: try the sample, or start the template (§5.2). */
export function StartCard({ project, templateVersion }: { readonly project: ProjectDetail; readonly templateVersion: number | null }) {
  const titleId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sample = useIdempotentMutation('relay/v1/projects.createSample', {
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: qk.projects() });
      // The sample becomes the active project (the Settings fallback and the next launch open it).
      void call('relay/v1/app.updateSettings', { activeProjectId: created.id })
        .catch(() => undefined)
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: qk.settings() });
          void navigate(paths.overview(created.id));
        });
    },
  });
  // Already in the sample: offering it again would only reopen this project.
  const offerSample = !project.isDemo;
  return (
    <Card labelledBy={titleId}>
      <CardHeader title="Start your first run" titleId={titleId} />
      <p className="muted">
        {project.name} has no runs yet.{' '}
        {offerSample
          ? 'Try the built-in sample first, or run the template against files from this project.'
          : 'Run the template against the sample files: it reviews a prepared change and proposes a fix.'}
      </p>
      <div className={offerSample ? 'grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1' : 'grid gap-4'}>
        {offerSample ? (
          <div className="stack rounded-md border border-border bg-surface-raised p-4">
            <strong>Try the sample project</strong>
            <p className="subtle">A small fictional API with a prepared change. Nothing on your computer is modified.</p>
            <div>
              <Button
                icon={Box}
                pending={sample.isPending}
                onClick={() => {
                  sample.mutate({});
                }}
              >
                Try the sample project
              </Button>
            </div>
            {sample.error === undefined || sample.error === null ? null : (
              <ErrorView live="assertive" error={toViewError(sample.error)} onAction={() => { sample.mutate({}); }} />
            )}
          </div>
        ) : null}
        <div className="stack rounded-md border border-border bg-surface-raised p-4">
          <strong>
            Review &amp; propose a fix {templateVersion === null ? null : <span className="tag">v{templateVersion}</span>}
          </strong>
          <p className="subtle">
            Review a change, plan a fix, draft a patch, review the patch. You approve the plan before any patch is
            drafted.
          </p>
          <div>
            <ButtonLink as={Link} variant="primary" to={paths.newRun(project.id)}>
              Start: Review &amp; propose a fix
            </ButtonLink>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Run controls + recent runs

export interface RunControlsCardProps {
  readonly project: ProjectDetail;
  readonly focusRun: RunDetail | undefined;
  readonly workflowLimits: WorkflowLimits | undefined;
  readonly workflowId: string | undefined;
}

export function RunControlsCard({ project, focusRun, workflowLimits, workflowId }: RunControlsCardProps) {
  const titleId = useId();
  const budget = focusRun?.limits.budgetMicrousd ?? workflowLimits?.budgetMicrousd;
  const cycles = focusRun?.limits.maxRevisionCycles ?? workflowLimits?.maxRevisionCycles;
  return (
    <Card labelledBy={titleId}>
      <CardHeader
        title="Run controls"
        titleId={titleId}
        actions={
          workflowId === undefined ? undefined : (
            <ButtonLink as={Link} variant="ghost" size="sm" to={paths.workflow(project.id, workflowId)}>
              Edit limits
            </ButtonLink>
          )
        }
      />
      <KeyValueList
        items={[
          {
            id: 'budget',
            term: 'Run allowance',
            value:
              budget === undefined ? (
                '…'
              ) : focusRun === undefined ? (
                <Money value={budget} />
              ) : (
                <Link to={paths.run(project.id, focusRun.id, { tab: 'ledger' })}>
                  <Money value={budget} />
                  <span className="sr-only">, {runLabel(focusRun.id)} ledger</span>
                </Link>
              ),
          },
          {
            id: 'monthly',
            term: 'Monthly allowance',
            value:
              project.monthlyAllowanceMicrousd === null ? (
                'Not set'
              ) : (
                <>
                  <Money value={project.monthlyAllowanceMicrousd} /> tracked by Relay
                </>
              ),
          },
          { id: 'cycles', term: 'Revision cycles', value: cycles === undefined ? '…' : `${String(cycles)} maximum` },
          { id: 'actions', term: 'Actions', value: 'Draft patch only' },
          { id: 'execution', term: 'Execution', value: 'One step at a time' },
        ]}
      />
    </Card>
  );
}

export function RecentRunsCard({ project, runs, now }: { readonly project: ProjectDetail; readonly runs: readonly RunSummary[] | undefined; readonly now: number }) {
  const titleId = useId();
  return (
    <Card labelledBy={titleId}>
      <CardHeader
        title="Recent runs"
        titleId={titleId}
        actions={<Link to={paths.runs(project.id)}>All runs</Link>}
      />
      {runs === undefined ? (
        <div aria-busy="true">
          <Skeleton lines={3} height={20} />
        </div>
      ) : (
        <DataTable
          caption={`Three most recent runs in ${project.name}`}
          rows={runs}
          getRowKey={(r) => r.id}
          getRowHref={(r) => href(paths.run(project.id, r.id))}
          emptyState={<p className="muted">No runs yet. Runs you start appear here with their status and tracked cost.</p>}
          columns={[
            { key: 'run', header: 'Run', nowrap: true, cell: (r) => <span className="mono">{runLabel(r.id)}</span> },
            {
              key: 'goal',
              header: 'Goal',
              minWidth: '10rem',
              // When it started sits under the goal: the Overview column is narrow at 1280 px (no sideways scroll).
              cell: (r) => (
                <span className="stack" style={{ gap: 0 }}>
                  <span>{r.goal}</span>
                  <span className="subtle small">
                    Started <RelativeTime epochMs={r.createdAt} now={now} />
                  </span>
                </span>
              ),
            },
            { key: 'status', header: 'Status', nowrap: true, cell: (r) => <StatusBadge kind="run" value={r.status} pauseReason={r.pauseReason} /> },
            {
              key: 'cost',
              header: 'Tracked cost',
              numeric: true,
              cell: (r) => <RunCost cost={r.cost} ledgerPath={paths.run(project.id, r.id, { tab: 'ledger' })} />,
            },

          ]}
        />
      )}
    </Card>
  );
}
