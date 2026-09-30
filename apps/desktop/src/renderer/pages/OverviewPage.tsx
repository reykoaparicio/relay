import { useState } from 'react';
import type { ReactNode } from 'react';
import { Play } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { ErrorView, PageHeader, Skeleton } from '../components/ui';
import { toViewError } from '../api/errors';
import {
  ActiveRunCard,
  ApprovalAttentionCard,
  InterruptedBanner,
  OverviewStats,
  ProviderBanner,
  RecentRunsCard,
  RecoveryAttention,
  RunControlsCard,
  StartCard,
} from '../features/overview/OverviewCards';
import { deriveOverview, disconnectedProviders, OVERVIEW_WATCHED_STATUSES } from '../features/overview/overview-model';
import type { OverviewModel } from '../features/overview/overview-model';
import { paths } from '../features/shell/paths';
import { useNavPerf } from '../hooks/useNavPerf';
import { useProject } from '../hooks/useProject';
import { useProjectCost } from '../hooks/useProjectCost';
import { useProviders } from '../hooks/useProviders';
import { useRun } from '../hooks/useRun';
import { useRuns } from '../hooks/useRuns';
import { useWorkflow, useWorkflows } from '../hooks/useWorkflow';

const RECENT_RUNS = 3;

function activeHint(model: OverviewModel): string {
  if (model.awaiting !== undefined) return 'Waiting for your approval';
  if (model.running !== undefined) {
    const { done, total } = model.running.stepProgress;
    return `Running · step ${String(Math.min(done + 1, total))} of ${String(total)}`;
  }
  if (model.interrupted !== undefined) return '1 interrupted run needs a decision';
  if (model.empty) return 'No runs yet';
  return 'Nothing in progress';
}

/** Project overview (10 J4, §5.2). Mock states: awaiting-approval, active-run, empty, interrupted, provider-disconnected. */
export function OverviewPage() {
  const { projectId = '' } = useParams();
  const [now] = useState(() => Date.now());
  const project = useProject(projectId);
  const recent = useRuns(projectId, { limit: RECENT_RUNS });
  const watched = useRuns(projectId, { status: OVERVIEW_WATCHED_STATUSES, filterKey: 'overview-watched' });
  const cost = useProjectCost(projectId);
  const providers = useProviders();
  const workflows = useWorkflows();
  const workflow = workflows.data?.[0];
  const workflowVersion = useWorkflow(workflow?.id, workflow?.latestValidatedVersion);

  const model =
    project.data === undefined || watched.data === undefined
      ? undefined
      : deriveOverview(project.data, watched.data.pages.flatMap((p) => p.items));
  const focusDetail = useRun(model?.focus?.id);
  const interruptedDetail = useRun(model?.interrupted?.id);
  const authDetail = useRun(model?.authPaused?.id);
  const recentRuns = recent.data?.pages[0]?.items;

  useNavPerf('overview', project.data !== undefined && recentRuns !== undefined);

  const header = (
    <PageHeader
      title="Project overview"
      breadcrumbs={project.data === undefined ? [] : [{ label: project.data.name }, { label: project.data.rootDisplayPath }]}
      actions={
        <Link className="btn primary" to={paths.newRun(projectId)}>
          <Play aria-hidden="true" />
          Start a workflow
        </Link>
      }
    />
  );

  const loadError = project.error ?? watched.error ?? recent.error;
  if (loadError !== null) {
    return (
      <>
        {header}
        <ErrorView
          error={toViewError(loadError)}
          onAction={() => {
            void project.refetch();
            void watched.refetch();
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
  let attention: ReactNode = null;
  if (model.empty) {
    attention = <StartCard project={p} templateVersion={workflow?.latestValidatedVersion ?? null} />;
  } else if (model.awaiting !== undefined && focus?.id === model.awaiting.id) {
    attention = <ApprovalAttentionCard projectId={p.id} run={focus} />;
  } else if (model.running !== undefined && focus?.id === model.running.id) {
    attention = <ActiveRunCard projectId={p.id} run={focus} />;
  } else if (model.interrupted !== undefined && interruptedDetail.data !== undefined) {
    attention = <RecoveryAttention projectId={p.id} run={interruptedDetail.data} />;
  }

  return (
    <>
      {header}
      {interruptedDetail.data === undefined ? null : <InterruptedBanner projectId={p.id} run={interruptedDetail.data} />}
      {disconnected.map((d) => (
        <ProviderBanner key={d.providerId} provider={d} />
      ))}
      <OverviewStats
        project={p}
        activeCount={model.activeCount}
        activeHint={activeHint(model)}
        tracked={cost.data}
        latestRunId={recentRuns?.[0]?.id}
        now={now}
      />
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(300px,1fr)] items-start gap-5 max-[1024px]:grid-cols-1">
        <div className="stack">{attention}</div>
        <RunControlsCard
          project={p}
          focusRun={focus}
          workflowLimits={workflowVersion.data?.spec.limits}
          workflowId={workflow?.id}
        />
      </div>
      <RecentRunsCard project={p} runs={recentRuns} now={now} />
    </>
  );
}
