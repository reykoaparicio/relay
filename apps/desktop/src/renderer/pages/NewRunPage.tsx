import { useEffect, useMemo, useReducer, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { assertNever, INPUT_CAPS } from '@relay/contracts';
import { ButtonLink, ErrorView, InlineAlert, PageHeader, Skeleton } from '../components/ui';
import { call } from '../api/client';
import { toViewError } from '../api/errors';
import { qk } from '../api/keys';
import { ErrorSummary } from '../features/common/ErrorSummary';
import { useNextAction, useRetryAction } from '../features/common/useNextAction';
import { BudgetBlockedPanel } from '../features/new-run/BudgetBlockedPanel';
import {
  GoalInputCard,
  InputSummaryCard,
  LimitsCard,
  MemoryCard,
  ProvidersCard,
  StartPanel,
  WorkflowCard,
} from '../features/new-run/NewRunCards';
import {
  buildStartInput,
  checkForm,
  deriveNewRunState,
  FIELD,
  formReducer,
  INITIAL_FORM,
  limitDefaults,
  limitTexts,
} from '../features/new-run/new-run-model';
import type { NewRunState } from '../features/new-run/new-run-model';
import { modelSteps } from '../features/run-setup/model-steps';
import { prefetchRunInspector } from '../features/shell/prefetch';
import { href, paths } from '../features/shell/paths';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { canonicalJson, useIdempotentMutation } from '../hooks/useIdempotentMutation';
import { useMemoryList } from '../hooks/useMemoryList';
import { useNavPerf } from '../hooks/useNavPerf';
import { usePreflight } from '../hooks/usePreflight';
import { usePreview } from '../hooks/usePreview';
import { useProfiles } from '../hooks/useProfiles';
import { useProject } from '../hooks/useProject';
import { useProviders } from '../hooks/useProviders';
import { useWorkflow, useWorkflows } from '../hooks/useWorkflow';

/** Preflight recomputes 400 ms after the last change (10 J7). */
const PREFLIGHT_DEBOUNCE_MS = 400;

/** New run form (10 J7, §4.2). Mock states: ready / validation-errors / budget-blocked. */
export function NewRunPage() {
  const { projectId = '' } = useParams();
  // PERF-04: the usual next page is a run; warm its chunk while this page is open.
  useEffect(() => {
    prefetchRunInspector();
  }, []);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, dispatch] = useReducer(formReducer, INITIAL_FORM);

  const project = useProject(projectId);
  const preview = usePreview(projectId === '' ? null : { projectId });
  const workflows = useWorkflows();
  const wfSummary = workflows.data?.find((w) => w.latestValidatedVersion !== null);
  const workflow = useWorkflow(wfSummary?.id, wfSummary?.latestValidatedVersion);
  const profiles = useProfiles();
  const providers = useProviders();
  const approved = useMemoryList(projectId, 'approved');
  const suggested = useMemoryList(projectId, 'suggested');

  const spec = workflow.data?.spec;
  const defaults = limitDefaults(spec?.limits);
  const texts = limitTexts(form, defaults);
  const rows = useMemo(
    () => (spec === undefined || profiles.data === undefined ? [] : modelSteps(spec, profiles.data)),
    [spec, profiles.data],
  );
  const files =
    form.files ?? (preview.data?.included ?? []).slice(0, INPUT_CAPS.maxFiles).map((f) => f.relPath);
  const check = checkForm(form, texts, defaults, files.length);
  const wfVersion = wfSummary?.latestValidatedVersion ?? null;
  const wfRef =
    wfSummary === undefined || wfVersion === null ? null : { id: wfSummary.id, version: wfVersion };
  const goal = form.goal.trim();

  // Preflight on a settled input. It runs as soon as the form can produce an input (the goal is required by the
  // contract, so a placeholder goal is used for the estimate until one is typed).
  const draft = buildStartInput({
    form,
    projectId,
    workflow: wfRef,
    files,
    rows,
    check,
    goal: goal === '' ? 'Draft goal' : goal,
  });
  const draftKey = draft === null ? null : canonicalJson(draft);
  const settled = useDebouncedValue(draftKey ?? '', PREFLIGHT_DEBOUNCE_MS);
  const preflight = usePreflight(settled === '' ? null : settled);
  const pf = preflight.data;

  const importDiff = useMutation({
    mutationFn: () => call('relay/v1/artifacts.importDiff', { projectId }),
    onSuccess: (res) => {
      if (res !== null) dispatch({ type: 'patch', patch: { diff: res } });
    },
  });
  // The start error belongs to the input that failed; once the form changes, it no longer applies.
  const [failedInput, setFailedInput] = useState<string | null>(null);
  const start = useIdempotentMutation('relay/v1/runs.start', {
    onError: (_e, input) => {
      setFailedInput(canonicalJson(input));
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['runs', projectId] });
      void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
      void navigate(paths.run(projectId, res.runId));
    },
  });

  useNavPerf('new-run', project.data !== undefined && workflow.data !== undefined);

  // ----- problems (validation-errors), budget (budget-blocked) and readiness: one pure derivation -----
  const submittable = buildStartInput({ form, projectId, workflow: wfRef, files, rows, check, goal });
  const submitKey = submittable === null ? null : canonicalJson(submittable);
  const state = deriveNewRunState({
    form,
    rows,
    check,
    profiles: profiles.data,
    goal,
    draftKey,
    settledKey: settled,
    submitKey,
    preflight: {
      data: pf,
      error: preflight.error,
      isFetching: preflight.isFetching,
      isPlaceholderData: preflight.isPlaceholderData,
      isSuccess: preflight.isSuccess,
    },
    startError: start.error,
    failedKey: failedInput,
    connectProviderAction: <Link to={paths.settings('providers')}>Connect provider</Link>,
  });
  const { budget, problems, fieldErrors, preflightSystemError } = state;
  const onSubmit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (!form.submitted) dispatch({ type: 'patch', patch: { submitted: true } });
    if (start.isPending || submittable === null || budget !== null || !state.checked) return;
    start.mutate(submittable);
  };
  const focusField = (id: string) => {
    document.getElementById(id)?.focus();
  };
  const focusFirstProfile = () => {
    const first = rows[0];
    if (first !== undefined) focusField(FIELD.profile(first.stepKey));
  };
  const focusFirstProblem = () => {
    const first = problems.find((p) => p.fieldId !== null);
    focusField(first?.fieldId ?? FIELD.goal);
  };
  const onLoadAction = useRetryAction(() => {
    void project.refetch();
    void workflows.refetch();
    void workflow.refetch();
    void profiles.refetch();
  });
  const onImportErrorAction = useNextAction({}, { projectId });
  const onErrorAction = useNextAction(
    {
      choose_profile: focusFirstProfile,
      increase_allowance: () => {
        focusField(FIELD.allowance);
      },
      raise_limits: () => {
        focusField(FIELD.attempts);
      },
      narrow_scope: () => {
        focusField(form.source === 'files' ? FIELD.files : FIELD.diff);
      },
      fix_input: focusFirstProblem,
      edit_goal: () => {
        focusField(FIELD.goal);
      },
      reload: () => void preflight.refetch(),
    },
    { projectId },
  );

  const header = (
    <PageHeader
      title="Start a workflow"
      breadcrumbs={[
        ...(project.data === undefined
          ? []
          : [{ label: project.data.name, href: href(paths.overview(projectId)) }]),
        { label: 'Runs', href: href(paths.runs(projectId)) },
        { label: 'New run' },
      ]}
      status={state.status === null ? undefined : <NewRunStatusText state={state} />}
      actions={
        <ButtonLink as={Link} variant="ghost" to={paths.runs(projectId)}>
          Cancel
        </ButtonLink>
      }
    />
  );

  const loadError = project.error ?? workflows.error ?? workflow.error ?? profiles.error;
  if (loadError !== null) {
    return (
      <>
        {header}
        <ErrorView error={toViewError(loadError)} onAction={onLoadAction} />
      </>
    );
  }
  if (
    project.data === undefined ||
    spec === undefined ||
    profiles.data === undefined ||
    workflows.data === undefined
  ) {
    return (
      <>
        {header}
        <div aria-busy="true" className="stack">
          <Skeleton lines={6} height={40} />
        </div>
      </>
    );
  }
  if (wfSummary === undefined) {
    return (
      <>
        {header}
        <InlineAlert tone="warning" title="No validated workflow yet">
          <p>Publish a workflow version before starting a run.</p>
        </InlineAlert>
      </>
    );
  }

  return (
    <>
      {header}
      <form className="stack" onSubmit={onSubmit} noValidate aria-label="New run">
        <ErrorSummary problems={problems} focusOnMount={form.submitted} />
        {budget === null ? null : (
          <BudgetBlockedPanel
            budget={budget}
            projectId={projectId}
            onSetAllowance={(text) => {
              start.newIntent();
              dispatch({ type: 'patch', patch: { allowanceText: text } });
            }}
            onChooseProfile={focusFirstProfile}
          />
        )}
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(300px,1fr)] items-start gap-5 max-[1100px]:grid-cols-1">
          <div className="stack">
            <GoalInputCard
              form={form}
              dispatch={dispatch}
              fieldErrors={fieldErrors}
              files={files}
              preview={{ data: preview.data, error: preview.error, refetch: () => void preview.refetch() }}
              importDiff={{ isPending: importDiff.isPending, error: importDiff.error, start: () => { importDiff.mutate(); } }}
              onImportErrorAction={onImportErrorAction}
            />
            <WorkflowCard
              projectId={projectId}
              summary={wfSummary}
              contentHash={workflow.data?.contentHash}
              rows={rows}
              profiles={profiles.data}
              providers={providers.data}
              selection={form.profileSelection}
              profileErrors={state.profileErrors}
              dispatch={dispatch}
            />
            <LimitsCard texts={texts} fieldErrors={fieldErrors} dispatch={dispatch} />
            <MemoryCard
              approved={{ data: approved.data, error: approved.error, refetch: () => void approved.refetch() }}
              suggestions={suggested.data?.length ?? 0}
              checked={form.memoryIds}
              fieldError={fieldErrors[FIELD.memory]}
              dispatch={dispatch}
            />
          </div>

          <div className="stack">
            <InputSummaryCard
              preflight={pf}
              fetching={preflight.isFetching}
              systemError={preflightSystemError}
              hasDraft={draft !== null}
              allowance={check.allowance}
              capBytes={preview.data?.totals.capBytes}
              onRetry={() => void preflight.refetch()}
              onErrorAction={onErrorAction}
            />
            <ProvidersCard preflight={pf} systemError={preflightSystemError} />
            <p className="small">No project files will be modified. Output is a proposed patch.</p>
            <StartPanel
              pending={start.isPending}
              disabled={state.startDisabled}
              disabledReason={state.startDisabledReason}
              problemCount={problems.length}
              otherError={state.otherStartError}
              onErrorAction={onErrorAction}
            />
          </div>
        </div>
      </form>
    </>
  );
}

/** The header sentence for the derived state (validation-errors / budget-blocked / ready / checking). */
function NewRunStatusText({ state }: { readonly state: NewRunState }) {
  const { problems, budget } = state;
  switch (state.status) {
    case 'system_error':
      return <span>Start unavailable: the run check failed.</span>;
    case 'budget':
      return (
        <span>
          Start blocked: the {budget?.scope === 'project' ? 'project monthly' : 'run'} allowance would be exceeded.
        </span>
      );
    case 'problems':
      return (
        <span>
          {String(problems.length)} problem{problems.length === 1 ? '' : 's'} prevent
          {problems.length === 1 ? 's' : ''} starting this run.
        </span>
      );
    case 'ready':
      return <span>All checks passed. Ready to start.</span>;
    case 'checking':
      return <span>Checking…</span>;
    case null:
      return null;
    default:
      return assertNever(state.status);
  }
}
