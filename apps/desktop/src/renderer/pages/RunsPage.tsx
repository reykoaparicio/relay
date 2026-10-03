import { useEffect, useId } from 'react';
import { ChevronDown, Play, Activity } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import { runStatusSchema, TERMINAL_RUN_STATUSES } from '@relay/contracts';
import type { RunStatus, RunSummary } from '@relay/contracts';
import {
  Button,
  ButtonLink,
  Card,
  DataTable,
  EmptyState,
  ErrorView,
  PageHeader,
  RelativeTime,
  Skeleton,
  StatusBadge,
  Tabs,
} from '../components/ui';
import { formatDuration, statusPresentation } from '../lib/format';
import { toViewError } from '../api/errors';
import { runLabel, RunCost } from '../features/runs/run-display';
import { href, paths } from '../features/shell/paths';
import { markHistoryLoaded, resetHistoryLoaded, useNavPerf } from '../hooks/useNavPerf';
import { NOW_IDLE_INTERVAL_MS, NOW_RUNNING_INTERVAL_MS, useNow } from '../hooks/useNow';
import { useProject } from '../hooks/useProject';
import { useRuns } from '../hooks/useRuns';

/** Quick status filters (`?status=`). A single RunStatus value is also accepted. */
export const RUN_FILTERS = {
  all: { label: 'All', statuses: undefined },
  attention: { label: 'Needs attention', statuses: ['awaiting_approval', 'paused', 'interrupted'] },
  active: { label: 'Active', statuses: ['queued', 'running', 'cancelling'] },
  finished: { label: 'Finished', statuses: [...TERMINAL_RUN_STATUSES] },
} as const satisfies Record<string, { label: string; statuses: readonly RunStatus[] | undefined }>;
type FilterKey = keyof typeof RUN_FILTERS;

function isFilterKey(v: string): v is FilterKey {
  return Object.hasOwn(RUN_FILTERS, v);
}

interface ResolvedFilter {
  readonly key: string;
  readonly label: string;
  readonly statuses: readonly RunStatus[] | undefined;
}

function resolveFilter(param: string | null): ResolvedFilter {
  if (param === null || param === '' || param === 'all') return { key: 'all', ...RUN_FILTERS.all };
  if (isFilterKey(param)) return { key: param, ...RUN_FILTERS[param] };
  const single = runStatusSchema.safeParse(param);
  if (single.success) return { key: single.data, label: statusPresentation('run', single.data).label, statuses: [single.data] };
  return { key: 'all', ...RUN_FILTERS.all };
}

function isAccruing(r: RunSummary): boolean {
  return r.endedAt === null && r.startedAt !== null && (r.status === 'running' || r.status === 'cancelling');
}

/** Wall time of a finished run, or elapsed time of one in progress. Paused/interrupted runs show "—" (not accruing). */
function durationOf(r: RunSummary, now: number): string {
  if (r.startedAt === null) return '—';
  if (r.endedAt !== null) return formatDuration(r.endedAt - r.startedAt);
  return r.status === 'running' || r.status === 'cancelling' ? formatDuration(now - r.startedAt) : '—';
}

function subline(r: RunSummary): string | null {
  if (r.status === 'paused' && r.pauseReason !== null) return statusPresentation('pause', r.pauseReason).detail ?? null;
  const detail = statusPresentation('run', r.status).detail;
  return detail ?? null;
}

/** Run history (10 J7 list; mock states list / filtered / empty). */
export function RunsPage() {
  const { projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = resolveFilter(searchParams.get('status'));
  const historyTitleId = useId();
  const project = useProject(projectId);
  const runs = useRuns(projectId, { ...(filter.statuses === undefined ? {} : { status: filter.statuses }), filterKey: filter.key });
  const rows = runs.data?.pages.flatMap((p) => p.items);
  // Running durations tick every second; otherwise relative times refresh every minute and on every refetch.
  const now = useNow(rows?.some(isAccruing) === true ? NOW_RUNNING_INTERVAL_MS : NOW_IDLE_INTERVAL_MS, runs.dataUpdatedAt);

  useEffect(() => {
    resetHistoryLoaded();
  }, []);
  const loaded = rows !== undefined;
  useEffect(() => {
    if (loaded) markHistoryLoaded();
  }, [loaded]);
  useNavPerf('runs', rows !== undefined);

  const tabs: ResolvedFilter[] = (Object.keys(RUN_FILTERS) as FilterKey[]).map((key) => ({ key, ...RUN_FILTERS[key] }));
  if (!tabs.some((t) => t.key === filter.key)) tabs.push(filter);

  const setFilter = (key: string) => {
    const next = new URLSearchParams(searchParams);
    if (key === 'all') next.delete('status');
    else next.set('status', key);
    setSearchParams(next);
  };

  const projectName = project.data?.name;
  const isFiltered = filter.key !== 'all';

  let list;
  if (runs.error !== null) {
    list = <ErrorView error={toViewError(runs.error)} onAction={() => void runs.refetch()} onRetry={() => void runs.refetch()} />;
  } else if (rows === undefined) {
    list = (
      <div aria-busy="true">
        <Skeleton lines={6} height={22} />
      </div>
    );
  } else if (rows.length === 0) {
    list = isFiltered ? (
      <EmptyState
        headingLevel={3}
        title="No runs match this filter"
        body={`There are no runs with the status "${filter.label}".`}
        actions={
          <Button
            onClick={() => {
              setFilter('all');
            }}
          >
            Show all runs
          </Button>
        }
      />
    ) : (
      <EmptyState
        headingLevel={3}
        icon={Activity}
        title="No runs yet"
        body="Start the review-to-patch template on selected files. Each run keeps its steps, approvals, artifacts and tracked cost here."
        actions={
          <ButtonLink as={Link} variant="primary" icon={Play} to={paths.newRun(projectId)}>
            Start a workflow
          </ButtonLink>
        }
      />
    );
  } else {
    list = (
      <div className="stack">
        <DataTable
          caption={`Runs in ${projectName ?? 'this project'}, newest first`}
          rows={rows}
          getRowKey={(r) => r.id}
          getRowHref={(r) => href(paths.run(projectId, r.id))}
          columns={[
            { key: 'run', header: 'Run', nowrap: true, cell: (r) => <span className="mono">{runLabel(r.id)}</span> },
            {
              key: 'goal',
              header: 'Goal',
              // Text columns wrap; the goal keeps a readable measure while the fixed columns stay on one line.
              minWidth: '12rem',
              cell: (r) => {
                const sub = subline(r);
                return (
                  <span className="flex flex-col">
                    <span className="font-medium">{r.goal}</span>
                    {sub === null ? null : <span className="subtle text-xs">{sub}</span>}
                  </span>
                );
              },
            },
            {
              key: 'workflow',
              header: 'Workflow version',
              minWidth: '8rem',
              cell: (r) => (
                <span>
                  {r.workflow.name} <span className="tag mono whitespace-nowrap">v{r.workflow.version}</span>
                </span>
              ),
            },
            { key: 'status', header: 'Status', nowrap: true, cell: (r) => <StatusBadge kind="run" value={r.status} pauseReason={r.pauseReason} /> },
            { key: 'steps', header: 'Steps', numeric: true, cell: (r) => `${String(r.stepProgress.done)}/${String(r.stepProgress.total)}` },
            {
              key: 'cost',
              header: 'Tracked cost',
              numeric: true,
              cell: (r) => <RunCost cost={r.cost} detailed ledgerPath={paths.run(projectId, r.id, { tab: 'ledger' })} />,
            },
            {
              key: 'started',
              header: 'Started',
              nowrap: true,
              cell: (r) => (
                <span className="subtle">
                  <RelativeTime epochMs={r.startedAt ?? r.createdAt} now={now} />
                </span>
              ),
            },
            { key: 'duration', header: 'Duration', numeric: true, cell: (r) => durationOf(r, now) },
          ]}
        />
        <div className="pager">
          <p className="subtle">
            {runs.hasNextPage
              ? `Showing ${String(rows.length)} runs, newest first.`
              : `${String(rows.length)} run${rows.length === 1 ? '' : 's'}${isFiltered ? ` (${filter.label})` : ''}.`}
          </p>
          {runs.hasNextPage ? (
            <Button
              icon={ChevronDown}
              pending={runs.isFetchingNextPage}
              onClick={() => {
                void runs.fetchNextPage();
              }}
            >
              Load older runs
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Runs"
        breadcrumbs={projectName === undefined ? [] : [{ label: projectName }, { label: 'All workflows' }]}
        actions={
          <ButtonLink as={Link} variant="primary" icon={Play} to={paths.newRun(projectId)}>
            Start a workflow
          </ButtonLink>
        }
      />
      <Card labelledBy={historyTitleId}>
        <h2 id={historyTitleId} className="sr-only">
          Run history
        </h2>
        <ul className="cost-legend m-0 list-none p-0" aria-label="Cost labels">
          <li>
            <span className="tag certainty-reported">reported</span> provider-reported usage
          </li>
          <li>
            <span className="tag certainty-estimated">estimated</span> ~ Relay estimate where the exact cost is not
            available
          </li>
          <li>Costs are tracked by Relay, not your provider bill.</li>
        </ul>
        <p className="sr-only" role="status" aria-live="polite">
          {rows === undefined ? '' : `Showing ${String(rows.length)} runs${isFiltered ? ` (${filter.label})` : ''}.`}
        </p>
        <Tabs
          label="Quick status filter"
          value={filter.key}
          onValueChange={setFilter}
          tabs={tabs.map((t) => ({ id: t.key, label: t.label, content: list }))}
        />
      </Card>
    </>
  );
}
