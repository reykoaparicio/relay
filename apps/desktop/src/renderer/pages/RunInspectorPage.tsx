import { useCallback, useMemo, useState } from 'react';
import { Download, FileText, Pause, XCircle } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ApprovalDecision, ExportWhat, RunAction, RunDetail, RunEvent, StepView } from '@relay/contracts';
import {
  AttemptsTable,
  BudgetLedger,
  Button,
  ButtonLink,
  ConfirmDialog,
  ContextManifestView,
  EmptyState,
  ErrorView,
  PageHeader,
  ResponsivePanels,
  Skeleton,
  StatusBadge,
  StepTimeline,
  useToast,
} from '../components/ui';
import type { ApprovalDecisionInput, Panel } from '../components/ui';
import { isAppErrorException } from '../api/client';
import { toViewError } from '../api/errors';
import { RUN_ACTION_LABELS } from '../lib/format';
import { runLabel } from '../features/runs/run-display';
import { href, paths } from '../features/shell/paths';
import { ActionErrorNotice } from '../features/run-inspector/ActionErrorNotice';
import { ContextSummary, EventsList, LedgerPanel } from '../features/run-inspector/InspectorPanels';
import {
  APPROVAL_ACTIONS,
  blockedStep,
  defaultStep,
  HEADER_ACTIONS,
  parseInspectorTab,
  stepTitle,
} from '../features/run-inspector/inspector-model';
import {
  ChooseProfileDialog,
  DecideUnknownDialog,
  IncreaseAllowanceDialog,
  ProjectAllowanceDialog,
  RaiseLimitsDialog,
} from '../features/run-inspector/RunActionDialogs';
import type { RunActionRequest } from '../features/run-inspector/run-actions';
import { StatusBanner } from '../features/run-inspector/StatusBanner';
import { StepOutputTab } from '../features/run-inspector/StepOutput';
import { useRunActions } from '../features/run-inspector/useRunActions';
import { useArtifactExport, useLedgerExport } from '../features/run-inspector/useRunExports';
import { useLedger } from '../hooks/useLedger';
import { useNavPerf } from '../hooks/useNavPerf';
import { NOW_RUNNING_INTERVAL_MS, useNow } from '../hooks/useNow';
import { useProfiles } from '../hooks/useProfiles';
import { useProject } from '../hooks/useProject';
import { useRun } from '../hooks/useRun';
import { useRunEvents } from '../hooks/useRunEvents';
import { useStep } from '../hooks/useStep';

type DialogKind = 'allowance' | 'project_allowance' | 'profile' | 'limits' | 'unknown';

const DECISION_ACTION: Readonly<Record<ApprovalDecision, 'approve' | 'request_revision' | 'reject'>> = {
  approved: 'approve',
  revision_requested: 'request_revision',
  rejected: 'reject',
};

const ACTION_DECISION: Partial<Readonly<Record<RunAction, ApprovalDecision>>> = {
  approve: 'approved',
  request_revision: 'revision_requested',
  reject: 'rejected',
};

/** FR-11: cancellation of the in-flight request is best effort; charges may be unknown. */
const CONFIRM_COPY: Readonly<Record<'cancel' | 'stop', { title: string; consequences: string }>> = {
  cancel: {
    title: 'Cancel this run?',
    consequences:
      'No new steps will start. Stopping the in-flight request is best effort: the provider may still finish it, and its charge may stay unknown. Finished steps, artifacts, and costs are kept.',
  },
  stop: {
    title: 'Stop this run?',
    consequences:
      'The run ends as cancelled. Finished steps, artifacts, and costs are kept; any possible charge stays recorded as unknown liability.',
  },
};

const STALE_CODES = new Set(['APPROVAL_STALE', 'PROJECT_CHANGED']);

function stepEvents(all: readonly RunEvent[], fromStep: readonly RunEvent[] | undefined, step: StepView): RunEvent[] {
  const bySeq = new Map<number, RunEvent>();
  for (const e of fromStep ?? []) bySeq.set(e.seq, e);
  for (const e of all) {
    if (e.payload['stepKey'] === step.stepKey || e.payload['stepId'] === step.id) bySeq.set(e.seq, e);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Run inspector (10 J8, §5.4): timeline | selected step panel | budget + context. */
export function RunInspectorPage() {
  const { projectId = '', runId = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const runQ = useRun(runId);
  const run = runQ.data;
  const stream = useRunEvents(runId);
  const selected = run === undefined ? undefined : (run.steps.find((s) => s.id === search.get('step')) ?? defaultStep(run));
  const stepQ = useStep(runId, selected?.id);
  const ledger = useLedger(runId);
  const project = useProject(projectId);
  const profiles = useProfiles();
  const now = useNow(NOW_RUNNING_INTERVAL_MS, runQ.dataUpdatedAt);
  const actions = useRunActions({ runId, projectId });
  const artifactExport = useArtifactExport(runId);
  const ledgerExport = useLedgerExport(runId);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [confirm, setConfirm] = useState<'cancel' | 'stop' | null>(null);
  const [lastAction, setLastAction] = useState<RunAction | null>(null);
  const tab = parseInspectorTab(search.get('tab'));

  useNavPerf('run-inspector', run !== undefined);

  const setTab = useCallback(
    (id: string) => {
      setSearch(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('tab', id);
          return next;
        },
        { replace: true },
      );
    },
    [setSearch],
  );

  const selectStep = useCallback(
    (stepId: string) => {
      setSearch(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('step', stepId);
          return next;
        },
        { replace: true },
      );
    },
    [setSearch],
  );

  const dispatch = useCallback(
    async (req: RunActionRequest): Promise<boolean> => {
      setLastAction(req.action);
      const ok = await actions.dispatch(req);
      if (ok && req.action !== 'reconnect_provider') {
        toast.show({ key: `run-action:${req.action}:${runId}`, title: `${RUN_ACTION_LABELS[req.action]}: done`, tone: 'success' });
      }
      return ok;
    },
    [actions, runId, toast],
  );

  const runExport = useCallback(
    (what: ExportWhat, action: RunAction) => {
      setLastAction(action);
      artifactExport.mutate(what, {
        onSuccess: (res) => {
          if (res.exported) {
            toast.show({ key: `export:${runId}:${what}`, title: 'Export saved', body: res.displayPaths.join(', '), tone: 'success' });
          }
        },
      });
    },
    [artifactExport, runId, toast],
  );

  /** A user chose `action`. `confirmed` = a confirmation already happened (RecoveryPanel's own dialog). */
  const trigger = useCallback(
    (action: RunAction, confirmed = false) => {
      if (run === undefined) return;
      actions.clearError();
      switch (action) {
        case 'pause':
        case 'resume':
        case 'acknowledge_overrun':
        case 'resnapshot_and_replan':
        case 'use_preserved_snapshot':
        case 'review_recovery':
          void dispatch({ action, runId: run.id });
          return;
        case 'cancel':
        case 'stop':
          if (confirmed) void dispatch({ action, runId: run.id });
          else setConfirm(action);
          return;
        case 'retry_step': {
          const step = blockedStep(run);
          if (step !== undefined) void dispatch({ action, runId: run.id, stepId: step.id });
          return;
        }
        case 'reconnect_provider':
          void dispatch({ action });
          return;
        case 'increase_allowance':
          setDialog('allowance');
          return;
        case 'edit_project_allowance':
          setDialog('project_allowance');
          return;
        case 'choose_profile':
          setDialog('profile');
          return;
        case 'raise_limits':
          setDialog('limits');
          return;
        case 'decide_unknown':
          setDialog('unknown');
          return;
        case 'export_report':
          runExport('report', action);
          return;
        case 'export_patch':
          runExport('patch', action);
          return;
        case 'approve':
        case 'request_revision':
        case 'reject': {
          const approvalStep = run.steps.find((s) => s.state === 'awaiting_approval');
          if (approvalStep !== undefined) selectStep(approvalStep.id);
          return;
        }
      }
    },
    [actions, dispatch, run, runExport, selectStep],
  );

  const onDecide = useCallback(
    async (input: ApprovalDecisionInput) => {
      const ok = await dispatch({
        action: DECISION_ACTION[input.decision],
        approvalId: input.approvalId,
        planHash: input.planHash,
        contextHash: input.contextHash,
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      // A stale plan/context (§11.3) or any failure: show the current plan and hashes before the next decision.
      if (!ok) {
        void runQ.refetch();
        void queryClient.invalidateQueries({ queryKey: ['step', runId] });
      }
    },
    [dispatch, queryClient, runId, runQ],
  );

  const submitDialog = useCallback(
    async (req: RunActionRequest) => {
      if (await dispatch(req)) setDialog(null);
    },
    [dispatch],
  );

  const liveEvents = stream.events;
  const selectedEvents = useMemo(
    () => (selected === undefined ? [] : stepEvents(liveEvents, stepQ.data?.events, selected)),
    [liveEvents, selected, stepQ.data?.events],
  );

  const header = (r: RunDetail | undefined) => (
    <PageHeader
      title="Run inspection"
      breadcrumbs={[
        { label: 'Runs', href: href(paths.runs(projectId)) },
        { label: r === undefined ? 'Run' : `${runLabel(r.id)} · ${r.workflow.name} v${String(r.workflow.version)}` },
      ]}
      status={r === undefined ? undefined : <StatusBadge kind="run" value={r.status} pauseReason={r.pauseReason} />}
      actions={r === undefined ? undefined : <HeaderActions run={r} projectId={projectId} onAction={trigger} pending={actions.pending} busy={actions.busy} exporting={artifactExport.isPending ? lastAction : null} />}
    />
  );

  if (runQ.error !== null) {
    return (
      <>
        {header(undefined)}
        <ErrorView
          error={toViewError(runQ.error)}
          onAction={() => {
            void runQ.refetch();
          }}
        />
      </>
    );
  }
  if (run === undefined || selected === undefined) {
    return (
      <>
        {header(run)}
        <div aria-busy="true" className="stack">
          {run !== undefined && run.steps.length === 0 ? (
            <EmptyState title="This run has no steps yet" body="Steps appear once the run starts." />
          ) : (
            <Skeleton lines={6} height={40} />
          )}
        </div>
      </>
    );
  }

  const errorCode = isAppErrorException(actions.error) ? actions.error.appError.code : null;
  const approvalError = lastAction !== null && APPROVAL_ACTIONS.has(lastAction) ? actions.error : null;
  const dialogError = dialog === null ? null : actions.error;
  const generalError = dialog === null && approvalError === null ? (actions.error ?? artifactExport.error) : null;
  const pendingDecision = actions.pending === null ? null : (ACTION_DECISION[actions.pending] ?? null);
  const blocked = blockedStep(run);
  const allowedProviders = new Set<string>(project.data?.providerPolicy.allowedProviderIds ?? []);
  const permittedProfiles = (profiles.data ?? []).filter((p) => allowedProviders.size === 0 || allowedProviders.has(p.profile.providerId));
  const entries = ledger.entries.data?.pages.flatMap((p) => p.items);

  const tabs: Panel[] = [
    {
      id: 'output',
      label: 'Output',
      content: (
        <StepOutputTab
          run={run}
          projectId={projectId}
          step={selected}
          detail={stepQ.data}
          detailError={stepQ.error}
          progress={stream.progress}
          now={now}
          approval={{
            canDecide: run.availableActions.includes('approve'),
            onDecide: (input) => {
              void onDecide(input);
            },
            pendingDecision,
            error: approvalError,
            staleNotice: errorCode !== null && STALE_CODES.has(errorCode) && approvalError !== null,
          }}
        />
      ),
    },
    {
      id: 'context',
      label: 'Context',
      content:
        stepQ.data === undefined ? (
          <Skeleton lines={4} />
        ) : stepQ.data.manifest === null ? (
          <p className="subtle">No context was sent for this step. Only the items in a manifest are ever sent to a provider.</p>
        ) : (
          <div className="stack">
            <p className="subtle">Immutable manifest for this request. Only these items were sent to providers.</p>
            <ContextManifestView manifest={stepQ.data.manifest} />
          </div>
        ),
    },
    {
      id: 'attempts',
      label: 'Attempts',
      content:
        stepQ.data === undefined ? (
          <Skeleton lines={4} />
        ) : (
          <AttemptsTable attempts={stepQ.data.attempts} caption={`Attempts for ${stepTitle(selected)}`} />
        ),
    },
    { id: 'events', label: 'Events', content: <EventsList events={selectedEvents} loaded={stream.loaded || stepQ.data !== undefined} /> },
    {
      id: 'ledger',
      label: 'Ledger',
      content: (
        <LedgerPanel
          runLabel={runLabel(run.id)}
          entries={entries}
          error={ledger.entries.error}
          hasMore={ledger.entries.hasNextPage}
          loadingMore={ledger.entries.isFetchingNextPage}
          onLoadMore={() => {
            void ledger.entries.fetchNextPage();
          }}
          onExport={() => {
            ledgerExport.mutate();
          }}
          exporting={ledgerExport.isPending}
          exportError={ledgerExport.error}
          exportedTo={ledgerExport.data?.exported === true ? (ledgerExport.data.displayPath ?? 'the chosen file') : null}
        />
      ),
    },
  ];
  const secondary: Panel[] = [
    {
      id: 'budget',
      label: 'Budget',
      content: (
        <div className="stack">
          <BudgetLedger cost={run.cost} byStep={ledger.summary.data?.byStep ?? []} caption={`${runLabel(run.id)} tracked usage`} />
          <div className="actions">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setTab('ledger');
              }}
            >
              Per-attempt ledger entries
            </Button>
          </div>
        </div>
      ),
    },
    {
      id: 'summary',
      label: 'Context summary',
      content: (
        <ContextSummary
          run={run}
          manifest={stepQ.data === undefined ? undefined : stepQ.data.manifest}
          onInspect={() => {
            setTab('context');
          }}
        />
      ),
    },
  ];

  return (
    <>
      {header(run)}
      <div className="grid grid-cols-[minmax(220px,280px)_minmax(0,1fr)] items-start gap-5 max-[900px]:grid-cols-1">
        <section className="card" aria-labelledby="inspector-timeline-heading">
          <h2 id="inspector-timeline-heading">Timeline</h2>
          <StepTimeline steps={run.steps} selectedId={selected.id} onSelect={selectStep} titleFor={stepTitle} />
        </section>
        <div className="stack min-w-0">
          <StatusBanner
            run={run}
            projectId={projectId}
            events={liveEvents}
            onAction={(a) => {
              trigger(a);
            }}
            onConfirmedAction={(a) => {
              trigger(a, true);
            }}
            pending={actions.pending}
            busy={actions.busy}
          />
          <ActionErrorNotice error={generalError} />
          <section className="stack" aria-labelledby="inspector-step-heading">
            <div className="card-header">
              <h2 id="inspector-step-heading" className="text-lg font-semibold">{stepTitle(selected)}</h2>
              <StatusBadge kind="step" value={selected.state} showDetail />
            </div>
            <ResponsivePanels
              label="Step details"
              tabs={tabs}
              secondary={secondary}
              value={tab}
              onValueChange={setTab}
            />
          </section>
        </div>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm === null ? '' : CONFIRM_COPY[confirm].title}
        consequences={confirm === null ? '' : CONFIRM_COPY[confirm].consequences}
        confirmLabel={confirm === null ? 'Confirm' : RUN_ACTION_LABELS[confirm]}
        cancelLabel="Keep the run"
        pending={confirm !== null && actions.pending === confirm}
        onConfirm={() => {
          const action = confirm;
          setConfirm(null);
          if (action !== null) void dispatch({ action, runId: run.id });
        }}
      />
      {dialog === 'allowance' ? (
        <IncreaseAllowanceDialog
          open
          onOpenChange={(o) => {
            if (!o) setDialog(null);
          }}
          pending={actions.pending === 'increase_allowance'}
          error={dialogError}
          run={run}
          onSubmit={(value) => {
            void submitDialog({ action: 'increase_allowance', runId: run.id, newAllowanceMicrousd: value });
          }}
        />
      ) : null}
      {dialog === 'project_allowance' ? (
        <ProjectAllowanceDialog
          open
          onOpenChange={(o) => {
            if (!o) setDialog(null);
          }}
          pending={actions.pending === 'edit_project_allowance'}
          error={dialogError}
          project={project.data}
          onSubmit={(value, expectedUpdatedAt) => {
            void submitDialog({ action: 'edit_project_allowance', projectId, expectedUpdatedAt, monthlyAllowanceMicrousd: value });
          }}
        />
      ) : null}
      {dialog === 'profile' ? (
        <ChooseProfileDialog
          open
          onOpenChange={(o) => {
            if (!o) setDialog(null);
          }}
          pending={actions.pending === 'choose_profile'}
          error={dialogError}
          step={blocked}
          profiles={permittedProfiles}
          onSubmit={(profileId) => {
            if (blocked !== undefined) {
              void submitDialog({
                action: 'choose_profile',
                runId: run.id,
                profileId,
                step: { id: blocked.id, stepKey: blocked.stepKey, state: blocked.state },
              });
            }
          }}
        />
      ) : null}
      {dialog === 'limits' ? (
        <RaiseLimitsDialog
          open
          onOpenChange={(o) => {
            if (!o) setDialog(null);
          }}
          pending={actions.pending === 'raise_limits'}
          error={dialogError}
          run={run}
          onSubmit={(limits) => {
            void submitDialog({ action: 'raise_limits', runId: run.id, ...limits });
          }}
        />
      ) : null}
      {dialog === 'unknown' ? (
        <DecideUnknownDialog
          open
          onOpenChange={(o) => {
            if (!o) setDialog(null);
          }}
          pending={actions.pending === 'decide_unknown'}
          error={dialogError}
          run={run}
          onSubmit={(attemptId, decision) => {
            void submitDialog({ action: 'decide_unknown', runId: run.id, attemptId, decision });
          }}
        />
      ) : null}
    </>
  );
}

const HEADER_ICONS: Partial<Record<RunAction, typeof Pause>> = {
  pause: Pause,
  cancel: XCircle,
  export_report: Download,
  export_patch: Download,
};

/** Header buttons: only the header actions present in `availableActions`, plus a link to the report. */
function HeaderActions({
  run,
  projectId,
  onAction,
  pending,
  busy,
  exporting,
}: {
  readonly run: RunDetail;
  readonly projectId: string;
  readonly onAction: (a: RunAction) => void;
  readonly pending: RunAction | null;
  readonly busy: boolean;
  readonly exporting: RunAction | null;
}) {
  const list = run.availableActions.filter((a) => HEADER_ACTIONS.has(a));
  return (
    <>
      {run.reportArtifactId === null ? null : (
        <ButtonLink as={Link} variant="ghost" icon={FileText} to={paths.report(projectId, run.id)}>
          View report
        </ButtonLink>
      )}
      {list.map((a) => (
        <Button
          key={a}
          variant={a === 'cancel' ? 'danger' : a === 'export_report' ? 'primary' : 'secondary'}
          icon={HEADER_ICONS[a] ?? Download}
          pending={pending === a || exporting === a}
          disabled={busy && pending !== a}
          onClick={() => {
            onAction(a);
          }}
        >
          {RUN_ACTION_LABELS[a]}
        </Button>
      ))}
    </>
  );
}
