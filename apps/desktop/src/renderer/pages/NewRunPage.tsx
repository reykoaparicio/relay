import { useEffect, useMemo, useReducer, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { assertNever } from '@relay/contracts';
import type { PreviewResult, RunPreflight } from '@relay/contracts';
import { ButtonLink, ErrorView, InlineAlert, PageHeader, Skeleton, useLiveRegion } from '../components/ui';
import { call } from '../api/client';
import { isProjectRootMissing, toViewError } from '../api/errors';
import { ProjectRootMissing } from '../features/projects/ProjectRootMissing';
import { qk } from '../api/keys';
import { ErrorSummary } from '../features/common/ErrorSummary';
import { useNextAction, useRetryAction } from '../features/common/useNextAction';
import { BudgetBlockedPanel } from '../features/new-run/BudgetBlockedPanel';
import { clearNewRunDraft, loadNewRunDraft, saveNewRunDraft } from '../features/new-run/new-run-draft';
import {
  GoalInputCard,
  InputSummaryCard,
  LimitsCard,
  MemoryCard,
  ProvidersCard,
  StartPanel,
  WorkflowCard,
} from '../features/new-run/NewRunCards';
import { UnreadableFileActions } from '../features/new-run/UnreadableFileActions';
import {
  ackEntries,
  ackInputs,
  budgetFromError,
  buildStartInput,
  checkForm,
  defaultFiles,
  deriveNewRunState,
  FIELD,
  fileCheckboxIds,
  formReducer,
  INITIAL_FORM,
  limitDefaults,
  limitTexts,
  validAcknowledged,
} from '../features/new-run/new-run-model';
import type { NewRunState } from '../features/new-run/new-run-model';
import { modelSteps, profileOverridesFor } from '../features/run-setup/model-steps';
import { modelMaxOutput, modelName, stepOutputLimits } from '../features/run-setup/output-limits';
import { rolesByProvider } from '../features/run-setup/PreflightSummary';
import { prefetchRunInspector } from '../features/shell/prefetch';
import { href, paths } from '../features/shell/paths';
import { useCatalog } from '../hooks/useCatalog';
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
import { PROVIDER_LABELS } from '../lib/format';

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
  // A draft of this project's form comes back after a trip elsewhere (e.g. Settings to raise the monthly allowance).
  const [form, dispatch] = useReducer(formReducer, projectId, (id: string) => loadNewRunDraft(id) ?? INITIAL_FORM);
  // Whether this form came back from a draft: files it names that are gone now are reported once below.
  const [fromDraft] = useState(() => loadNewRunDraft(projectId) !== undefined);
  useEffect(() => {
    saveNewRunDraft(projectId, form);
  }, [projectId, form]);

  const project = useProject(projectId);
  const preview = usePreview(projectId === '' ? null : { projectId });
  const workflows = useWorkflows();
  const wfSummary = workflows.data?.find((w) => w.latestValidatedVersion !== null);
  const workflow = useWorkflow(wfSummary?.id, wfSummary?.latestValidatedVersion);
  const profiles = useProfiles();
  const providers = useProviders();
  // Decision 3: each model's most output tokens (the range of the "Max output (tokens)" inputs until preflight answers).
  const catalog = useCatalog();
  const approved = useMemoryList(projectId, 'approved');
  const suggested = useMemoryList(projectId, 'suggested');

  const spec = workflow.data?.spec;
  const defaults = limitDefaults(spec?.limits);
  const texts = limitTexts(form, defaults);
  const rows = useMemo(
    () => (spec === undefined || profiles.data === undefined ? [] : modelSteps(spec, profiles.data)),
    [spec, profiles.data],
  );
  // Untouched: every included file except suspected secrets (E2 #11), up to the cap. An explicit selection (e.g. from a
  // draft) keeps only files the current preview still includes: a file deleted, moved or excluded since is never sent.
  const { files, unavailable } = useMemo(() => selectedFiles(form.files, preview.data), [form.files, preview.data]);
  // Decision 3: the preflight's per-step output limits, kept for the profile choice they were computed for (a change of
  // profile falls back to the local values until the next answer; typing elsewhere never flips the defaults).
  const [knownLimits, setKnownLimits] = useState<{ readonly choice: string; readonly limits: RunPreflight['stepLimits'] } | null>(null);
  const profileChoice = canonicalJson(profileOverridesFor(rows, form.profileSelection) ?? {});
  const outputLimits = stepOutputLimits({
    rows,
    selection: form.profileSelection,
    profiles: profiles.data,
    catalog: catalog.data,
    stepLimits: knownLimits?.choice === profileChoice ? knownLimits.limits : undefined,
  });
  const check = checkForm(form, texts, defaults, files.length, outputLimits);
  // Who receives the run's context with the current profile choice (engine: the snapshot's providers with overrides).
  const roles = rolesByProvider(rows, form.profileSelection, profiles.data);
  const receiving = [...roles.keys()];
  // E2 #11: a confirmation holds only while it named every receiving provider and the file is unchanged.
  const acknowledged = validAcknowledged(form.acknowledgedSecrets, receiving, preview.data);
  // Round-3 M4: each is sent with the hash of the content confirmed; the engine flags a file changed since.
  const ackInput = ackInputs(form.acknowledgedSecrets, acknowledged, preview.data);
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
    acknowledged: ackInput,
  });
  const draftKey = draft === null ? null : canonicalJson(draft);
  const settled = useDebouncedValue(draftKey ?? '', PREFLIGHT_DEBOUNCE_MS);
  const preflight = usePreflight(settled === '' ? null : settled);
  const pf = preflight.data;
  const settledChoice = pf === undefined || preflight.isPlaceholderData || settled === '' ? null : profileChoiceOfKey(settled);
  if (settledChoice !== null && pf !== undefined && (knownLimits?.choice !== settledChoice || knownLimits.limits !== pf.stepLimits)) {
    setKnownLimits({ choice: settledChoice, limits: pf.stepLimits });
  }
  // `input.relPaths.<i>` preflight issues index the checked input's files: read them from the key it ran for.
  const settledFiles = useMemo(() => relPathsOfKey(settled), [settled]);
  const checkboxIds = useMemo(() => fileCheckboxIds(preview.data), [preview.data]);
  // Who would receive a confirmed suspected secret: the checked run's providers and the current choice's (a check that
  // has not caught up with a profile change never names fewer providers than the run would use).
  const namedProviders = [...new Set([...(pf?.inputSummary.providersReceivingContext ?? []), ...receiving])];
  const providerNames = namedProviders.map((id) => PROVIDER_LABELS[id]);
  const onFilesChange = (next: readonly string[], ackPaths: readonly string[]) => {
    dispatch({
      type: 'set-files',
      files: next,
      acknowledged: ackEntries(ackPaths, form.acknowledgedSecrets, acknowledged, namedProviders, preview.data),
    });
  };

  const importDiff = useMutation({
    mutationFn: () => call('relay/v1/artifacts.importDiff', { projectId }),
    onSuccess: (res) => {
      if (res !== null) dispatch({ type: 'patch', patch: { diff: res } });
    },
  });
  // The start error belongs to the input that failed; once the form changes, it no longer applies.
  const [failedInput, setFailedInput] = useState<string | null>(null);
  const { announce } = useLiveRegion();
  const start = useIdempotentMutation('relay/v1/runs.start', {
    onError: (e, input) => {
      setFailedInput(canonicalJson(input));
      // The preflight passed, so nothing on screen changed before Start: the admission block that now replaces it
      // (BudgetBlockedPanel, not a live region) is announced as the answer to the user's submit.
      const blocked = budgetFromError(e);
      if (blocked !== null) {
        announce(
          `Start blocked: the ${blocked.scope === 'project' ? 'project monthly' : 'run'} allowance would be exceeded. Nothing was reserved or sent. Choose how to continue below.`,
        );
      }
    },
    onSuccess: (res) => {
      clearNewRunDraft(projectId);
      void queryClient.invalidateQueries({ queryKey: ['runs', projectId] });
      void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
      void navigate(paths.run(projectId, res.runId));
    },
  });

  // A profile change can add a provider: confirmations that did not name it are dropped (asked again).
  const selectProfile = (stepKey: string, profileId: string) => {
    start.newIntent();
    const next = { ...form.profileSelection, [stepKey]: profileId };
    const chosen = profiles.data?.find((p) => p.profile.id === profileId);
    dispatch({
      type: 'select-profile',
      stepKey,
      profileId,
      receivingProviders: [...rolesByProvider(rows, next, profiles.data).keys()],
      // Decision 3: an output override above the new model's maximum is lowered to it (with a note at the field).
      ...(chosen === undefined ? {} : { outputMax: { max: modelMaxOutput(catalog.data, chosen), modelName: modelName(catalog.data, chosen) } }),
    });
  };

  useNavPerf('new-run', project.data !== undefined && workflow.data !== undefined);

  // ----- problems (validation-errors), budget (budget-blocked) and readiness: one pure derivation -----
  const submittable = buildStartInput({ form, projectId, workflow: wfRef, files, rows, check, goal, acknowledged: ackInput });
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
    fileAnchors: { relPaths: settledFiles, ids: checkboxIds },
    unreadableAction: (relPath) =>
      project.data === undefined ? undefined : (
        <UnreadableFileActions
          project={project.data}
          relPath={relPath}
          onDeselect={() => {
            start.newIntent();
            dispatch({ type: 'set-files', files: files.filter((p) => p !== relPath) });
          }}
        />
      ),
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
  const refetchLoad = () => {
    void project.refetch();
    void workflows.refetch();
    void workflow.refetch();
    void profiles.refetch();
  };
  const onLoadAction = useRetryAction(refetchLoad);
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
        <ErrorView error={toViewError(loadError)} onAction={onLoadAction} onRetry={refetchLoad} />
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
  // E2 #7: the project folder was moved, renamed, or deleted — nothing can be previewed or started until it is found.
  if (isProjectRootMissing(preview.error) || isProjectRootMissing(preflight.error) || isProjectRootMissing(start.error)) {
    return (
      <>
        {header}
        {/* A start that failed on the missing folder is cleared once the folder is found, so the form comes back. */}
        <ProjectRootMissing
          project={project.data}
          onRelocated={() => {
            start.reset();
          }}
        />
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
        {fromDraft && unavailable > 0 ? (
          <InlineAlert tone="info" live="polite" title={`${String(unavailable)} file${unavailable === 1 ? '' : 's'} from your draft ${unavailable === 1 ? 'is' : 'are'} no longer available`}>
            <p>{unavailable === 1 ? 'It was' : 'They were'} deleted, moved, or excluded since, and {unavailable === 1 ? 'is' : 'are'} left out of this run.</p>
          </InlineAlert>
        ) : null}
        {budget === null ? null : (
          <BudgetBlockedPanel
            budget={budget}
            project={project.data}
            rows={rows}
            profiles={profiles.data}
            selection={form.profileSelection}
            onSelectProfile={selectProfile}
            onProjectAllowanceSaved={() => {
              start.newIntent();
              void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
              void queryClient.invalidateQueries({ queryKey: ['preflight'] });
            }}
            onSetAllowance={(text) => {
              start.newIntent();
              dispatch({ type: 'patch', patch: { allowanceText: text } });
            }}
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
              providerNames={providerNames}
              acknowledged={acknowledged}
              onFilesChange={onFilesChange}
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
              onSelectProfile={selectProfile}
              output={{
                limits: outputLimits,
                values: form.outputTokenTexts,
                errors: state.outputErrors,
                notes: form.outputTokenNotes,
                inputId: FIELD.maxOutput,
                onChange: (stepKey, text) => {
                  start.newIntent();
                  dispatch({ type: 'set-output-tokens', stepKey, text });
                },
                onReset: (stepKey) => {
                  start.newIntent();
                  dispatch({ type: 'reset-output-tokens', stepKey });
                },
                onResetAll: () => {
                  start.newIntent();
                  dispatch({ type: 'reset-output-tokens' });
                },
              }}
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
            <ProvidersCard
              preflight={pf}
              systemError={preflightSystemError}
              inputKind={form.source === 'diff' ? 'diff' : 'files'}
              roles={roles}
              statuses={providers.data}
            />
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

/**
 * The files the run would send: the default selection while untouched, else the explicit selection minus files the
 * current preview no longer includes (`unavailable` counts those). Until the preview loads, the selection as is.
 */
function selectedFiles(
  selection: readonly string[] | null,
  preview: PreviewResult | undefined,
): { readonly files: readonly string[]; readonly unavailable: number } {
  if (selection === null) return { files: defaultFiles(preview), unavailable: 0 };
  if (preview === undefined) return { files: selection, unavailable: 0 };
  const included = new Set<string>(preview.included.map((f) => f.relPath));
  const files = selection.filter((p) => included.has(p));
  return { files, unavailable: selection.length - files.length };
}

/** The `input.relPaths` of a preflight key (`canonicalJson` of the checked input), else []. */
function relPathsOfKey(key: string): readonly string[] {
  if (key === '') return [];
  try {
    const parsed: unknown = JSON.parse(key);
    const input = (parsed as { input?: { relPaths?: unknown } } | null)?.input;
    return Array.isArray(input?.relPaths) ? input.relPaths.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** The profile choice (`canonicalJson` of `profileOverrides`, `{}` when none) a preflight key was checked with. */
function profileChoiceOfKey(key: string): string | null {
  try {
    const parsed: unknown = JSON.parse(key);
    const overrides = (parsed as { profileOverrides?: unknown } | null)?.profileOverrides;
    return canonicalJson(overrides ?? {});
  } catch {
    return null;
  }
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
    case 'needs_goal':
      return <span>Checks passed. Enter a goal to start.</span>;
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
