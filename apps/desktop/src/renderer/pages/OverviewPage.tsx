import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Play } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { ButtonLink, ErrorView, PageHeader, Skeleton } from '../components/ui';
import { toViewError } from '../api/errors';
import {
  ActiveRunCard,
  ApprovalAttentionCard,
  InterruptedBanner,
  OverviewStats,
  PausedAttentionCard,
  ProviderBanner,
  RecentRunsCard,
  RecoveryAttention,
  RunControlsCard,
  StartCard,
} from '../features/overview/OverviewCards';
import { deriveOverview, disconnectedProviders, OVERVIEW_ACTIVE_STATUSES } from '../features/overview/overview-model';
import type { OverviewModel } from '../features/overview/overview-model';
import { ProjectRootMissing } from '../features/projects/ProjectRootMissing';
import { useProjectRootMissing } from '../features/projects/useProjectRootCheck';
import { prefetchRunInspector } from '../features/shell/prefetch';
import { paths } from '../features/shell/paths';
import { useNavPerf } from '../hooks/useNavPerf';
import { NOW_IDLE_INTERVAL_MS, useNow } from '../hooks/useNow';
import { useProject } from '../hooks/useProject';
import { useProjectCost } from '../hooks/useProjectCost';
import { useProviders } from '../hooks/useProviders';
import { useRun } from '../hooks/useRun';
import { RUNS_MAX_PAGE, useRuns, useRunsHead } from '../hooks/useRuns';
import { useWorkflow, useWorkflows } from '../hooks/useWorkflow';

const RECENT_RUNS = 3;

function activeHint(model: OverviewModel): string {
  if (model.awaiting !== undefined) return 'Waiting for your approval';
  if (model.running !== undefined) {
    const { done, total } = model.running.stepProgress;
    return `Running · step ${String(Math.min(done + 1, total))} of ${String(total)}`;
  }
  if (model.interrupted !== undefined) return '1 interrupted run needs a decision';
  const paused = model.paused.length;
  if (paused > 0) return `${String(paused)} paused run${paused === 1 ? ' needs' : 's need'} you`;
  if (model.empty) return 'No runs yet';
  return 'Nothing in progress';
}

/** Project overview (10 J4, §5.2). Mock states: awaiting-approval, active-run, empty, interrupted, provider-disconnected. */
export function OverviewPage() {
  const { projectId = '' } = useParams();
  // PERF-04: the usual next page is a run; warm its chunk while this page is open.
  useEffect(() => {
    prefetchRunInspector();
  }, []);
  const project = useProject(projectId);
  const recent = useRuns(projectId, { limit: RECENT_RUNS });
  // Status-filtered queries: counts and attention never come from a truncated mixed list.
  const awaitingQ = useRunsHead(projectId, ['awaiting_approval'], 1, 'awaiting');
  const runningQ = useRunsHead(projectId, ['running', 'queued'], 1, 'running');
  const interruptedQ = useRunsHead(projectId, ['interrupted'], 1, 'interrupted');
  const pausedQ = useRunsHead(projectId, ['paused'], RUNS_MAX_PAGE, 'paused');
  const activeQ = useRunsHead(projectId, OVERVIEW_ACTIVE_STATUSES, RUNS_MAX_PAGE, 'active');
  const heads = [awaitingQ, runningQ, interruptedQ, pausedQ, activeQ] as const;
  const cost = useProjectCost(projectId);
  const providers = useProviders();
  const workflows = useWorkflows();
  const workflow = workflows.data?.[0];
  const workflowVersion = useWorkflow(workflow?.id, workflow?.latestValidatedVersion);
  const rootMissing = useProjectRootMissing(projectId);

  const model =
    project.data === undefined ||
    awaitingQ.data === undefined ||
    runningQ.data === undefined ||
    interruptedQ.data === undefined ||
    pausedQ.data === undefined ||
    activeQ.data === undefined
      ? undefined
      : deriveOverview(project.data, {
          awaiting: awaitingQ.data.items,
          running: runningQ.data.items,
          interrupted: interruptedQ.data.items,
          paused: pausedQ.data.items,
          active: { items: activeQ.data.items, more: activeQ.data.nextCursor !== null },
        });
  const focusDetail = useRun(model?.focus?.id);
  const interruptedDetail = useRun(model?.interrupted?.id);
  const authDetail = useRun(model?.authPaused?.id);
  const recentRuns = recent.data?.pages[0]?.items;
  // A live clock: relative times tick, and the month label follows the current month (refreshed on refetch).
  const now = useNow(NOW_IDLE_INTERVAL_MS, recent.dataUpdatedAt);

  useNavPerf('overview', project.data !== undefined && recentRuns !== undefined);

  const header = (
    <PageHeader
      title="Project overview"
      breadcrumbs={
        project.data === undefined
          ? []
          : [
              { label: project.data.name },
              // The mock's "Local project": the folder path (often a long temp path) is in the tooltip.
              { label: project.data.isDemo ? 'Sample project' : 'Local project', title: project.data.rootDisplayPath },
            ]
      }
      actions={
        <ButtonLink as={Link} variant="primary" icon={Play} to={paths.newRun(projectId)}>
          Start a workflow
        </ButtonLink>
      }
    />
  );

  const loadError = project.error ?? heads.find((q) => q.error !== null)?.error ?? recent.error;
  if (loadError !== null) {
    return (
      <>
        {header}
        <ErrorView
          error={toViewError(loadError)}
          onAction={() => {
            void project.refetch();
            for (const q of heads) void q.refetch();
            void recent.refetch();
          }}
          onRetry={() => {
            void project.refetch();
            for (const q of heads) void q.refetch();
            void recent.refetch();
          }}
        />
      </>
    );
  }
  if (project.data === undefined || model === undefined) {
    return (
      <>
        {header}
        <div aria-busy="true" className="stack">
          <Skeleton lines={3} height={72} />
        </div>
      </>
    );
  }

  const p = project.data;
  const disconnected = disconnectedProviders(providers.data ?? [], authDetail.data);
  const focus = focusDetail.data;
  // Whether an attention card belongs here (its run detail may still be loading): decides the layout up front, so
  // the cards don't jump when the detail arrives.
  const expectsAttention =
    model.empty ||
    model.awaiting !== undefined ||
    model.running !== undefined ||
    model.interrupted !== undefined ||
    model.pausedFocus !== undefined;
  let attention: ReactNode = null;
  if (model.empty) {
    attention = <StartCard project={p} templateVersion={workflow?.latestValidatedVersion ?? null} />;
  } else if (model.awaiting !== undefined && focus?.id === model.awaiting.id) {
    attention = <ApprovalAttentionCard projectId={p.id} run={focus} />;
  } else if (model.running !== undefined && focus?.id === model.running.id) {
    attention = <ActiveRunCard projectId={p.id} run={focus} />;
  } else if (model.interrupted !== undefined && interruptedDetail.data !== undefined) {
    attention = <RecoveryAttention projectId={p.id} run={interruptedDetail.data} />;
  } else if (model.pausedFocus !== undefined && focus?.id === model.pausedFocus.id) {
    attention = <PausedAttentionCard projectId={p.id} run={focus} otherPaused={model.paused.length - 1} />;
  }

  return (
    <>
      {header}
      {rootMissing ? <ProjectRootMissing project={p} /> : null}
      {interruptedDetail.data === undefined ? null : <InterruptedBanner projectId={p.id} run={interruptedDetail.data} />}
      {disconnected.map((d) => (
        <ProviderBanner key={d.providerId} projectId={p.id} provider={d} />
      ))}
      <OverviewStats
        project={p}
        activeCount={model.activeCount}
        activeCapped={model.activeCapped}
        activeHint={activeHint(model)}
        tracked={cost.data}
        latestRunId={recentRuns?.[0]?.id}
        now={now}
      />
      {/* With an attention card: [attention | run controls], then recent runs full width. Without one (a project
          whose runs need nothing from the user), recent runs move up beside run controls so no grid cell is empty. */}
      {/* Peer cards share the row height (stretch); the attention card fills its column. */}
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(300px,1fr)] gap-5 max-[1180px]:grid-cols-1">
        {expectsAttention ? (
          <div className="stack [&>:first-child]:flex-1">
            {attention ??
              (focusDetail.isLoading || interruptedDetail.isLoading ? (
                <div aria-busy="true">
                  <Skeleton lines={3} height={40} />
                </div>
              ) : null)}
          </div>
        ) : (
          <RecentRunsCard project={p} runs={recentRuns} now={now} />
        )}
        <RunControlsCard
          project={p}
          focusRun={focus}
          workflowLimits={workflowVersion.data?.spec.limits}
          workflowId={workflow?.id}
        />
      </div>
      {expectsAttention ? <RecentRunsCard project={p} runs={recentRuns} now={now} /> : null}
    </>
  );
}
