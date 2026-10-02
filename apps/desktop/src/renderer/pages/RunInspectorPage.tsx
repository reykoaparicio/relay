import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileText, Pause, XCircle } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ApprovalDecision, ExportWhat, RunAction, RunDetail } from '@relay/contracts';
import {
  Button,
  ButtonLink,
  EmptyState,
  ErrorView,
  PageHeader,
  ResponsivePanels,
  Skeleton,
  StatusBadge,
  StepTimeline,
  useToast,
  usePageFocusRescue,
} from '../components/ui';
import type { ApprovalDecisionInput, RecoveryDecisionDetail } from '../components/ui';
import { isAppErrorException } from '../api/client';
import { toViewError } from '../api/errors';
import { RUN_ACTION_DONE_LABELS, RUN_ACTION_LABELS } from '../lib/format';
import { runLabel } from '../features/runs/run-display';
import { href, paths } from '../features/shell/paths';
import { ActionErrorNotice } from '../features/run-inspector/ActionErrorNotice';
import { InspectorDialogs, useInspectorDialogs } from '../features/run-inspector/InspectorDialogs';
import {
  APPROVAL_ACTIONS,
  blockedStep,
  defaultStep,
  HEADER_ACTIONS,
  isLatestRow,
  latestRowOf,
  parseInspectorTab,
  stepEventsOf,
  stepTitle,
} from '../features/run-inspector/inspector-model';
import type { RunActionRequest } from '../features/run-inspector/run-actions';
import { StatusBanner } from '../features/run-inspector/StatusBanner';
import { useInspectorPanels } from '../features/run-inspector/useInspectorPanels';
import { useRunActions } from '../features/run-inspector/useRunActions';
import { useArtifactExport, useLedgerExport } from '../features/run-inspector/useRunExports';
import { useLedger } from '../hooks/useLedger';
import { useNavPerf } from '../hooks/useNavPerf';
import { useProfiles } from '../hooks/useProfiles';
import { useProject } from '../hooks/useProject';
import { useRun } from '../hooks/useRun';
import { useRunEvents } from '../hooks/useRunEvents';
import { StreamProgressContext } from '../hooks/useStreamProgress';
import { useStep } from '../hooks/useStep';

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

const STALE_CODES = new Set(['APPROVAL_STALE', 'PROJECT_CHANGED']);

/** Actions that create a newer `(revision, retry)` row of a step: the selection follows it (B3). */
const ROW_CREATING_ACTIONS: ReadonlySet<RunAction> = new Set<RunAction>(['retry_step', 'choose_profile', 'request_revision']);

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
  const actions = useRunActions({ runId, projectId });
  const artifactExport = useArtifactExport(runId);
  const ledgerExport = useLedgerExport(runId);
  const dialogs = useInspectorDialogs();
  const { openDialog, askConfirm, chooseUnknown } = dialogs;
  const [lastAction, setLastAction] = useState<RunAction | null>(null);
  const tab = parseInspectorTab(search.get('tab'));
  // B1: permitted profiles come from the LOADED project's provider allowlist; until it loads, nothing is offered.
  const allowedProviderIds = project.data?.providerPolicy.allowedProviderIds;
  const chooseProfileBlocked: string | null =
    allowedProviderIds !== undefined
      ? null
      : project.error !== null
        ? "the project's allowed providers could not be loaded, so no profile can be offered. Reload the page to try again."
        : "loading the project's allowed providers…";
  // B5: where focus lands when a dialog's opener is gone or disabled, and after a page-level focus loss.
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  usePageFocusRescue(stepHeadingRef);
  // B3: after an action that creates a newer row of the selected step, follow it once it appears.
  const followRef = useRef<{ readonly stepKey: string; readonly fromId: string } | null>(null);

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
      followRef.current = null;
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
      // Armed before the call: the newer row can arrive (push event, refetch) before the call resolves.
      const follow = selected !== undefined && ROW_CREATING_ACTIONS.has(req.action) ? { stepKey: selected.stepKey, fromId: selected.id } : null;
      if (follow !== null) followRef.current = follow;
      const ok = await actions.dispatch(req);
      if (!ok && followRef.current === follow) followRef.current = null;
      if (ok && req.action !== 'reconnect_provider') {
        toast.show({ key: `run-action:${req.action}:${runId}`, title: RUN_ACTION_DONE_LABELS[req.action], tone: 'success' });
      }
      // The approval step was selected (the default, a `?step=` from Overview's "Inspect plan", or a click) only to
      // decide it. Once approved it has nothing more to show, so the selection goes back to following the run: the
      // step that runs next, and the most informative finished step once the run ends (`defaultStep`).
      if (ok && req.action === 'approve' && selected?.state === 'awaiting_approval') {
        const decidedId = selected.id;
        setSearch(
          (prev) => {
            if (prev.get('step') !== decidedId) return prev;
            const next = new URLSearchParams(prev);
            next.delete('step');
            return next;
          },
          { replace: true },
        );
      }
      return ok;
    },
    [actions, runId, selected, setSearch, toast],
  );

  // B3: move the selection (and `?step=`) to the latest (revision, retry) row the action created.
  useEffect(() => {
    const follow = followRef.current;
    if (follow === null || run === undefined) return;
    const latest = latestRowOf(run.steps, follow.stepKey);
    if (latest !== undefined && latest.id !== follow.fromId) selectStep(latest.id);
  }, [run, selectStep]);

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
    (action: RunAction, confirmed = false, detail?: RecoveryDecisionDetail) => {
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
          else askConfirm(action);
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
          openDialog('allowance');
          return;
        case 'edit_project_allowance':
          openDialog('project_allowance');
          return;
        case 'choose_profile':
          if (chooseProfileBlocked === null) openDialog('profile');
          return;
        case 'raise_limits':
          openDialog('limits');
          return;
        case 'decide_unknown':
          // A RecoveryPanel row names the attempt and decision: confirm it, then decide exactly that attempt.
          if (detail?.attemptId !== undefined && detail.decision !== undefined) {
            chooseUnknown({ attemptId: detail.attemptId, decision: detail.decision });
          } else {
            openDialog('unknown');
          }
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
    [actions, askConfirm, chooseProfileBlocked, chooseUnknown, dispatch, openDialog, run, runExport, selectStep],
  );

  /** The RecoveryPanel confirmed the decision itself. */
  const onRecoveryAction = useCallback(
    (action: RunAction, detail?: RecoveryDecisionDetail) => {
      trigger(action, true, detail);
    },
    [trigger],
  );
  const disabledReasons = useMemo(
    () => (chooseProfileBlocked === null ? undefined : { choose_profile: chooseProfileBlocked }),
    [chooseProfileBlocked],
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
      if (await dispatch(req)) openDialog(null);
    },
    [dispatch, openDialog],
  );

  const liveEvents = stream.events;
  const selectedEvents = useMemo(
    () => (selected === undefined ? { events: [], runLevel: [] } : stepEventsOf([stepQ.data?.events, liveEvents], selected)),
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

  const errorCode = isAppErrorException(actions.error) ? actions.error.appError.code : null;
  const approvalError = lastAction !== null && APPROVAL_ACTIONS.has(lastAction) ? actions.error : null;
  const generalError = dialogs.dialog === null && approvalError === null ? (actions.error ?? artifactExport.error) : null;
  const pendingDecision = actions.pending === null ? null : (ACTION_DECISION[actions.pending] ?? null);
  const panels = useInspectorPanels({
    run,
    projectId,
    selected,
    detail: stepQ.data,
    detailError: stepQ.error,
    selectedEvents,
    eventsLoaded: stream.loaded || stepQ.data !== undefined,
    ledger,
    ledgerExport,
    approval: {
      onDecide: (input) => {
        void onDecide(input);
      },
      pendingDecision,
      error: approvalError,
      staleNotice: errorCode !== null && STALE_CODES.has(errorCode) && approvalError !== null,
    },
    setTab,
  });

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

  const blocked = blockedStep(run);
  const allowedProviders = new Set<string>(allowedProviderIds ?? []);
  // An empty allowlist permits no provider (never "everything").
  const permittedProfiles = (profiles.data ?? []).filter((p) => allowedProviders.has(p.profile.providerId));
  const newerRow =
    search.get('step') === selected.id && !isLatestRow(selected, run.steps) ? latestRowOf(run.steps, selected.stepKey) : undefined;
  if (panels === null) return null;

  return (
    <StreamProgressContext.Provider value={stream.progress}>
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
            onAction={trigger}
            onRecoveryAction={onRecoveryAction}
            pending={actions.pending}
            busy={actions.busy}
            {...(disabledReasons === undefined ? {} : { disabledReasons })}
          />
          <ActionErrorNotice error={generalError} />
          <section className="stack" aria-labelledby="inspector-step-heading">
            <div className="card-header">
              <h2 id="inspector-step-heading" ref={stepHeadingRef} tabIndex={-1} className="section-heading">
                {stepTitle(selected)}
              </h2>
              <StatusBadge kind="step" value={selected.state} showDetail />
            </div>
            {newerRow === undefined ? null : (
              <p className="subtle" data-testid="newer-attempt-notice">
                A newer attempt of this step exists.{' '}
                <Link
                  to={paths.run(projectId, run.id, { step: newerRow.id, ...(tab === 'budget' || tab === 'summary' ? {} : { tab }) })}
                  replace
                >
                  View latest
                </Link>
              </p>
            )}
            <ResponsivePanels
              label="Step details"
              tabs={panels.tabs}
              secondary={panels.secondary}
              value={tab}
              onValueChange={setTab}
            />
          </section>
        </div>
      </div>
      <InspectorDialogs
        state={dialogs}
        run={run}
        projectId={projectId}
        project={project.data}
        blocked={blocked}
        permittedProfiles={permittedProfiles}
        allowedProviderIds={allowedProviderIds}
        pending={actions.pending}
        error={actions.error}
        returnFocusFallback={stepHeadingRef}
        dispatch={dispatch}
        submitDialog={submitDialog}
      />
    </StreamProgressContext.Provider>
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
