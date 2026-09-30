import { useId } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Box, Plug, ShieldCheck } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { addMicrousd } from '@relay/contracts';
import type { OutputOf, ProjectDetail, RunAction, RunDetail, RunSummary, WorkflowLimits } from '@relay/contracts';
import {
  BudgetMeter,
  Button,
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
import { stepKeyLabel } from '../../lib/format';
import { toViewError } from '../../api/errors';
import { qk } from '../../api/keys';
import { useIdempotentMutation } from '../../hooks/useIdempotentMutation';
import { useRunActions } from '../run-inspector/useRunActions';
import { runLabel, RunCost } from '../runs/run-display';
import { href, paths } from '../shell/paths';
import type { DisconnectedProvider } from './overview-model';

function SafeNote() {
  return (
    <p className="inline-flex items-start gap-2 text-sm text-accent">
      <ShieldCheck aria-hidden="true" width={16} height={16} className="mt-0.5 flex-none" />
      No project files have been modified.
    </p>
  );
}

function monthName(now: number): string {
  return new Date(now).toLocaleString('en-US', { month: 'long' });
}

// ---------------------------------------------------------------------------------------------------------------
// Stat tiles

export interface OverviewStatsProps {
  readonly project: ProjectDetail;
  readonly activeCount: number;
  readonly activeHint: string;
  readonly tracked: OutputOf<'relay/v1/ledger.projectSummary'> | undefined;
  readonly latestRunId: string | undefined;
  readonly now: number;
}

/** Active runs · Usage tracked by Relay · Project memory (§5.2). */
export function OverviewStats({ project, activeCount, activeHint, tracked, latestRunId, now }: OverviewStatsProps) {
  const suggestions = project.stats.suggestions;
  return (
    <section className="grid grid-cols-3 gap-5" aria-label="Project summary">
      <StatTile label="Active runs" value={<span className="num">{activeCount}</span>} hint={activeHint} />
      <StatTile
        label="Usage tracked by Relay"
        value={tracked === undefined ? '…' : <Money value={tracked.trackedMicrousd} />}
        hint={
          <>
            {monthName(now)} ·{' '}
            {tracked === undefined || tracked.reservedMicrousd === 0 ? (
              'nothing reserved in flight'
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
        {...(latestRunId === undefined ? {} : { href: href(paths.run(project.id, latestRunId, { tab: 'ledger' })) })}
      />
      <StatTile
        label="Project memory"
        value={<span className="num">{project.stats.approvedMemory}</span>}
        hint={
          suggestions > 0
            ? `approved record${project.stats.approvedMemory === 1 ? '' : 's'} · ${String(suggestions)} suggestion${suggestions === 1 ? '' : 's'} to review`
            : `approved record${project.stats.approvedMemory === 1 ? '' : 's'} · manage memory`
        }
        href={href(paths.memory(project.id, suggestions > 0 ? { tab: 'suggested' } : {}))}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Banners

export function InterruptedBanner({ projectId, run }: { readonly projectId: string; readonly run: RunDetail }) {
  const lastDone = [...run.steps].reverse().find((s) => s.state === 'succeeded');
  const stuck = run.steps.find((s) => s.state === 'unknown' || s.state === 'executing' || s.state === 'failed');
  const liability = addMicrousd(...run.unresolvedAttempts.flatMap((a) => (a.cost === null ? [] : [a.cost.microusd])));
  const unknownStep = run.unresolvedAttempts[0]?.stepRunId ?? stuck?.id;
  const title =
    run.status === 'interrupted'
      ? `${runLabel(run.id)} was interrupted`
      : `${runLabel(run.id)} is paused: unknown request outcome`;
  return (
    <InlineAlert
      tone="warning"
      title={title}
      actions={
        <Link className="btn primary" to={paths.run(projectId, run.id, unknownStep === undefined ? {} : { step: unknownStep })}>
          <ArrowRight aria-hidden="true" />
          Review recovery options
        </Link>
      }
    >
      <p>
        {run.status === 'interrupted' ? 'Relay closed while ' : 'Relay lost track of the request while '}
        <b>{stuck === undefined ? 'a step' : stepKeyLabel(stuck.stepKey)}</b> was running. The last completed step is{' '}
        <b>{lastDone === undefined ? 'none yet' : stepKeyLabel(lastDone.stepKey)}</b>. Completed outputs are intact and
        will not be re-run automatically.
      </p>
      {run.unresolvedAttempts.length > 0 ? (
        <p className="inline-flex flex-wrap items-center gap-2">
          <StatusBadge kind="certainty" value="unknown" />
          {run.unresolvedAttempts.length} unresolved request{run.unresolvedAttempts.length === 1 ? '' : 's'} may already
          have incurred a charge. Up to <Money value={liability} certainty="estimated" /> is held as unresolved
          liability until you decide.
        </p>
      ) : null}
    </InlineAlert>
  );
}

export function ProviderBanner({ provider }: { readonly provider: DisconnectedProvider }) {
  return (
    <InlineAlert
      tone="danger"
      title={`Authentication failed for ${provider.displayName}`}
      actions={
        <>
          <Link className="btn danger" to={paths.settings('providers')}>
            <Plug aria-hidden="true" />
            Reconnect {provider.displayName}
          </Link>
          <Link className="btn ghost" to={paths.settings('providers')}>
            Open provider settings
          </Link>
        </>
      }
    >
      <p>
        The stored key {provider.redactedLabel === null ? null : <span className="mono">{provider.redactedLabel}</span>} was
        rejected during the last connection test (<span className="mono">AUTH_REQUIRED</span>). Workflows that use{' '}
        {provider.displayName} cannot start until it is reconnected. No requests were sent with this key.
      </p>
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
        <Link className="btn primary" to={stepPath}>
          Inspect plan
        </Link>
        <Link className="btn" to={paths.run(projectId, run.id)}>
          View {runLabel(run.id).toLowerCase()}
        </Link>
      </div>
    </Card>
  );
}

/** A running run with no approval pending. */
export function ActiveRunCard({ projectId, run }: { readonly projectId: string; readonly run: RunDetail }) {
  const titleId = useId();
  const actions = useRunActions();
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
        <ErrorView error={toViewError(actions.error)} onAction={actions.clearError} />
      )}
      <div className="row">
        <Link className="btn primary" to={paths.run(projectId, run.id, current === undefined ? {} : { step: current.id })}>
          Open current step
        </Link>
        {run.availableActions.includes('pause') ? (
          <Button
            pending={actions.pending === 'pause'}
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

/** Interrupted or unknown-outcome run: RecoveryPanel (§4.4). Decisions that need the inspector go there. */
export function RecoveryAttention({ projectId, run }: { readonly projectId: string; readonly run: RunDetail }) {
  const navigate = useNavigate();
  const actions = useRunActions();
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
      {actions.error === null ? null : <ErrorView error={toViewError(actions.error)} onAction={actions.clearError} />}
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
      void queryClient.invalidateQueries({ queryKey: qk.settings() });
      void navigate(paths.overview(created.id));
    },
  });
  return (
    <Card labelledBy={titleId}>
      <CardHeader title="Start your first run" titleId={titleId} />
      <p className="muted">
        {project.name} has no runs yet. Try the built-in sample first, or run the template against files from this
        project.
      </p>
      <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
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
            <ErrorView error={toViewError(sample.error)} onAction={() => { sample.mutate({}); }} />
          )}
        </div>
        <div className="stack rounded-md border border-border bg-surface-raised p-4">
          <strong>
            Review &amp; propose a fix {templateVersion === null ? null : <span className="tag">v{templateVersion}</span>}
          </strong>
          <p className="subtle">
            Review a change, plan a fix, draft a patch, review the patch. You approve the plan before any patch is
            drafted.
          </p>
          <div>
            <Link className="btn primary" to={paths.newRun(project.id)}>
              Start: Review &amp; propose a fix
            </Link>
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
            <Link className="btn ghost sm" to={paths.workflow(project.id, workflowId)}>
              Edit limits
            </Link>
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
            { key: 'run', header: 'Run', cell: (r) => <span className="mono whitespace-nowrap">{runLabel(r.id)}</span> },
            { key: 'goal', header: 'Goal', cell: (r) => r.goal },
            { key: 'status', header: 'Status', cell: (r) => <StatusBadge kind="run" value={r.status} pauseReason={r.pauseReason} /> },
            {
              key: 'cost',
              header: 'Tracked cost',
              numeric: true,
              cell: (r) => <RunCost cost={r.cost} ledgerPath={paths.run(project.id, r.id, { tab: 'ledger' })} />,
            },
            { key: 'started', header: 'Started', cell: (r) => <span className="subtle"><RelativeTime epochMs={r.createdAt} now={now} /></span> },
          ]}
        />
      )}
    </Card>
  );
}
