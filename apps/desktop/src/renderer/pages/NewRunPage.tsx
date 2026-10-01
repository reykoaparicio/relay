import { useId, useMemo, useReducer, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileDiff, Play } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { INPUT_CAPS } from '@relay/contracts';
import {
  Button,
  ButtonLink,
  Card,
  CardHeader,
  ErrorView,
  Field,
  InlineAlert,
  KeyValueList,
  MoneyInput,
  NumberInput,
  PageHeader,
  RadioGroup,
  Skeleton,
  Textarea,
} from '../components/ui';
import { call } from '../api/client';
import { toViewError, validationIssuesOf } from '../api/errors';
import { qk } from '../api/keys';
import { formatHash } from '../lib/format';
import { ErrorSummary } from '../features/common/ErrorSummary';
import type { FormProblem } from '../features/common/ErrorSummary';
import { BudgetBlockedPanel } from '../features/new-run/BudgetBlockedPanel';
import { FilePicker } from '../features/new-run/FilePicker';
import { MemoryPicker } from '../features/new-run/MemoryPicker';
import {
  budgetFromError,
  buildStartInput,
  checkForm,
  FIELD,
  fieldForPath,
  formReducer,
  INITIAL_FORM,
  limitDefaults,
  limitTexts,
  problemsFromError,
} from '../features/new-run/new-run-model';
import { LIMIT_BOUNDS } from '../features/run-setup/limits';
import { modelSteps, ROLE_LABELS } from '../features/run-setup/model-steps';
import {
  issueMessage,
  MISSING_CREDENTIAL,
  problemIssues,
  stepKeyOfPath,
  stepProviderId,
} from '../features/run-setup/preflight-issues';
import { PreflightSummary, ProvidersReceiving } from '../features/run-setup/PreflightSummary';
import { ProfileAssignmentTable } from '../features/run-setup/ProfileAssignmentTable';
import { href, paths } from '../features/shell/paths';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { canonicalJson, useIdempotentMutation } from '../hooks/useIdempotentMutation';
import { useMemoryList } from '../hooks/useMemoryList';
import { useNavPerf } from '../hooks/useNavPerf';
import { usePreflight } from '../hooks/usePreflight';
import type { PreflightInput } from '../hooks/usePreflight';
import { usePreview } from '../hooks/usePreview';
import { useProfiles } from '../hooks/useProfiles';
import { useProject } from '../hooks/useProject';
import { useProviders } from '../hooks/useProviders';
import { useWorkflow, useWorkflows } from '../hooks/useWorkflow';
import { useNextAction, useRetryAction } from '../features/common/useNextAction';

/** Preflight recomputes 400 ms after the last change (10 J7). */
export const PREFLIGHT_DEBOUNCE_MS = 400;

/** New run form (10 J7, §4.2). Mock states: ready / validation-errors / budget-blocked. */
export function NewRunPage() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ids = {
    input: useId(),
    workflow: useId(),
    limits: useId(),
    memory: useId(),
    summary: useId(),
    providers: useId(),
  };
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
  const settled = useDebouncedValue(draft === null ? '' : canonicalJson(draft), PREFLIGHT_DEBOUNCE_MS);
  const preflight = usePreflight(settled === '' ? null : (JSON.parse(settled) as PreflightInput));
  const pf = preflight.data;
  /** The preflight answer belongs to the settled input `settled`, and is not a kept-previous placeholder. */
  const preflightSettled = settled !== '' && !preflight.isFetching && !preflight.isPlaceholderData;

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

  // ----- problems (validation-errors) and budget (budget-blocked) -----
  const preflightError = preflight.error;
  const submittable = buildStartInput({ form, projectId, workflow: wfRef, files, rows, check, goal });
  const submitFingerprint = submittable === null ? null : canonicalJson(submittable);
  /** A settled preflight for exactly the input Start would send (B3: never start unpreflighted inputs). */
  const preflightMatches = preflightSettled && submitFingerprint === settled;
  const freshPreflight = preflightMatches && preflight.isSuccess ? pf : undefined;
  const startError =
    start.error === null ||
    start.error === undefined ||
    submittable === null ||
    failedInput !== canonicalJson(submittable)
      ? null
      : start.error;
  const budget =
    (startError === null ? null : budgetFromError(startError)) ??
    (pf !== undefined && !pf.budget.allowed ? pf.budget : null) ??
    budgetFromError(preflightError);
  const serverProblems: FormProblem[] = [];
  if (pf !== undefined && preflightError === null) {
    // budget_run / budget_project restate `budget.allowed = false`: the budget card already shows that block.
    for (const i of problemIssues(pf.issues, budget !== null)) {
      const stepKey = stepKeyOfPath(i.path);
      const row = stepKey === null ? undefined : rows.find((r) => r.stepKey === stepKey);
      const providerId =
        stepKey === null ? null : stepProviderId(stepKey, rows, form.profileSelection, profiles.data);
      serverProblems.push({
        fieldId: fieldForPath(i.path, form.source),
        message: issueMessage(i, providerId, row === undefined ? null : ROLE_LABELS[row.role]),
        code: i.code,
        ...(i.code === MISSING_CREDENTIAL
          ? {
              action: (
<Link to={paths.settings('providers')}>Connect provider</Link>
              ),
            }
          : {}),
      });
    }
  }
  // System errors (runner down, internal, conflict) are not form problems: they render as an ErrorView.
  const isSystemError = (e: unknown) => {
    const code = toViewError(e).code;
    return code === 'INTERNAL' || code === 'CONFLICT' || code === 'RUNNER_UNAVAILABLE';
  };
  for (const e of [preflightError, startError]) {
    if (e === null || budgetFromError(e) !== null || isSystemError(e)) continue;
    serverProblems.push(...problemsFromError(toViewError(e), validationIssuesOf(e), form.source));
  }
  const preflightSystemError =
    preflightError !== null && budgetFromError(preflightError) === null && isSystemError(preflightError)
      ? preflightError
      : null;
  // Summary links must reach a rendered control: a profile issue for a step not in the table has no anchor.
  const knownFields = new Set<string>([
    FIELD.goal,
    form.source === 'files' ? FIELD.files : FIELD.diff,
    FIELD.allowance,
    FIELD.revisions,
    FIELD.attempts,
    FIELD.timeout,
    FIELD.memory,
    ...rows.map((r) => FIELD.profile(r.stepKey)),
  ]);
  for (const [i, p] of serverProblems.entries())
    if (p.fieldId !== null && !knownFields.has(p.fieldId)) serverProblems[i] = { ...p, fieldId: null };
  const problems = [...check.problems, ...serverProblems].filter(
    (p, i, all) => all.findIndex((q) => q.fieldId === p.fieldId && q.message === p.message) === i,
  );
  const fieldErrors: Record<string, string> = { ...check.fieldErrors };
  for (const p of serverProblems)
    if (p.fieldId !== null && fieldErrors[p.fieldId] === undefined) fieldErrors[p.fieldId] = p.message;
  const profileErrors: Record<string, string> = {};
  for (const r of rows) {
    const msg = fieldErrors[FIELD.profile(r.stepKey)];
    if (msg !== undefined) profileErrors[r.stepKey] = msg;
  }
  const otherStartError =
    startError !== null && serverProblems.length === 0 && budgetFromError(startError) === null
      ? startError
      : null;

  /** Start needs a fresh, clean preflight of the submitted input. */
  const checked =
    freshPreflight !== undefined && freshPreflight.issues.length === 0 && freshPreflight.budget.allowed;
  // The (debounced) check has not caught up with the form yet.
  const draftFingerprint = draft === null ? '' : canonicalJson(draft);
  const checking =
    draft !== null &&
    (settled !== draftFingerprint || !preflightSettled) &&
    preflightSystemError === null &&
    budget === null &&
    problems.length === 0;
  const draftClean =
    !checking &&
    draft !== null &&
    preflight.isSuccess &&
    pf !== undefined &&
    pf.issues.length === 0 &&
    pf.budget.allowed;
  // With no goal yet the check uses a placeholder goal; Start then only reveals what is missing.
  const allPassed = submittable === null ? goal === '' && draftClean : checked;
  const onSubmit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (!form.submitted) dispatch({ type: 'patch', patch: { submitted: true } });
    if (start.isPending || submittable === null || budget !== null || !checked) return;
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
      status={
        preflightSystemError !== null ? (
          <span>Start unavailable: the run check failed.</span>
        ) : budget !== null ? (
          <span>
            Start blocked: the {budget.scope === 'project' ? 'project monthly' : 'run'} allowance would be
            exceeded.
          </span>
        ) : problems.length > 0 ? (
          <span>
            {String(problems.length)} problem{problems.length === 1 ? '' : 's'} prevent
            {problems.length === 1 ? 's' : ''} starting this run.
          </span>
        ) : allPassed ? (
          <span>All checks passed. Ready to start.</span>
        ) : checking ? (
          <span>Checking…</span>
        ) : undefined
      }
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

  const blocked = budget !== null;
  const startDisabledReason = blocked
    ? `Blocked by the ${budget.scope === 'project' ? 'monthly' : 'run'} allowance. Choose an option above.`
    : preflightSystemError !== null
      ? 'The run check failed. Retry it in Input summary.'
      : submittable !== null && !checked && problems.length === 0
        ? 'Checking…'
        : null;
  /** Disabled while blocked, checking, or with problems; with no input yet a submit shows what is missing. */
  const startDisabled = blocked || preflightSystemError !== null || (submittable !== null && !checked);
  const pendingProblems = problems.length;

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
            <Card labelledBy={ids.input}>
              <CardHeader title="Goal and input" titleId={ids.input} />
              <Field
                id={FIELD.goal}
                label="Goal"
                required
                hint="Describe the outcome. Relay sends this to every role in the workflow."
                error={fieldErrors[FIELD.goal]}
              >
                {(control) => (
                  <Textarea
                    {...control}
                    rows={3}
                    maxLength={2000}
                    value={form.goal}
                    onValueChange={(v) => {
                      dispatch({ type: 'patch', patch: { goal: v } });
                    }}
                  />
                )}
              </Field>
              <RadioGroup
                legend="Input source"
                value={form.source}
                onValueChange={(v) => {
                  dispatch({ type: 'patch', patch: { source: v } });
                }}
                options={[
                  {
                    value: 'files',
                    label: 'Selected files',
                    description: 'Pick files under the project root',
                  },
                  {
                    value: 'diff',
                    label: 'Import a .diff/.patch file',
                    description: 'A change prepared outside Relay',
                  },
                ]}
              />
              {form.source === 'files' ? (
                <FilePicker
                  preview={preview.data}
                  error={preview.error}
                  onRetry={() => void preview.refetch()}
                  selected={files}
                  fieldError={fieldErrors[FIELD.files]}
                  onChange={(next) => {
                    dispatch({ type: 'patch', patch: { files: next } });
                  }}
                />
              ) : (
                <div className="stack">
                  <div>
                    <Button
                      id={FIELD.diff}
                      icon={FileDiff}
                      pending={importDiff.isPending}
                      aria-describedby={
                        fieldErrors[FIELD.diff] === undefined ? undefined : `${FIELD.diff}-error`
                      }
                      onClick={() => {
                        importDiff.mutate();
                      }}
                    >
                      {form.diff === null ? 'Import a .diff/.patch file…' : 'Import a different file…'}
                    </Button>
                  </div>
                  {fieldErrors[FIELD.diff] === undefined ? null : (
                    <span className="error" id={`${FIELD.diff}-error`}>
                      {fieldErrors[FIELD.diff]}
                    </span>
                  )}
                  {form.diff === null ? null : (
                    <p className="small">
                      Imported diff touching {String(form.diff.files.length)} file
                      {form.diff.files.length === 1 ? '' : 's'}:{' '}
                      <span className="mono">{form.diff.files.join(', ')}</span>
                    </p>
                  )}
                  {form.diff === null || form.diff.parseWarnings.length === 0 ? null : (
                    <InlineAlert tone="warning" title="Relay read the file with warnings">
                      <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
                        {form.diff.parseWarnings.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    </InlineAlert>
                  )}
                  {importDiff.error === null ? null : (
                    <ErrorView error={toViewError(importDiff.error)} onAction={onImportErrorAction} />
                  )}
                </div>
              )}
            </Card>

            <Card labelledBy={ids.workflow}>
              <CardHeader
                title="Workflow"
                titleId={ids.workflow}
                actions={
                  <ButtonLink
                    as={Link}
                    size="sm"
                    variant="ghost"
                    to={paths.workflow(projectId, wfSummary.id)}
                  >
                    Open in editor
                  </ButtonLink>
                }
              />
              <KeyValueList
                items={[
                  {
                    id: 'version',
                    term: 'Version',
                    value: `${wfSummary.name} · v${String(wfSummary.latestValidatedVersion)} · pinned for this run`,
                  },
                  {
                    id: 'hash',
                    term: 'Snapshot',
                    value: formatHash(workflow.data?.contentHash ?? ''),
                    mono: true,
                  },
                ]}
              />
              <p className="small muted">
                Profiles below are copied into the run snapshot. Later edits to profiles or the workflow do
                not change this run.
              </p>
              <ProfileAssignmentTable
                caption="Role to model profile snapshot"
                rows={rows}
                profiles={profiles.data}
                providers={providers.data}
                selected={form.profileSelection}
                errors={profileErrors}
                selectId={FIELD.profile}
                onSelect={(stepKey, profileId) => {
                  dispatch({ type: 'select-profile', stepKey, profileId });
                }}
              />
            </Card>

            <Card labelledBy={ids.limits}>
              <CardHeader title="Limits" titleId={ids.limits} />
              <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
                <MoneyInput
                  id={FIELD.allowance}
                  label="Run allowance (USD)"
                  required
                  value={texts.allowance}
                  hint="Checked before every call. Tracked by Relay."
                  error={fieldErrors[FIELD.allowance]}
                  onValueChange={(t) => {
                    dispatch({ type: 'patch', patch: { allowanceText: t } });
                  }}
                />
                <LimitField
                  id={FIELD.revisions}
                  label="Revision cycles"
                  hint="Then the run is marked incomplete."
                  bounds={LIMIT_BOUNDS.maxRevisionCycles}
                  value={texts.revisions}
                  error={fieldErrors[FIELD.revisions]}
                  onChange={(t) => {
                    dispatch({ type: 'patch', patch: { revisionText: t } });
                  }}
                />
                <LimitField
                  id={FIELD.attempts}
                  label="Max attempts (run)"
                  hint="Across all steps."
                  bounds={LIMIT_BOUNDS.maxAttempts}
                  value={texts.attempts}
                  error={fieldErrors[FIELD.attempts]}
                  onChange={(t) => {
                    dispatch({ type: 'patch', patch: { attemptsText: t } });
                  }}
                />
                <LimitField
                  id={FIELD.timeout}
                  label="Timeout (minutes)"
                  hint="Execution time only; waiting for your approval does not count."
                  bounds={LIMIT_BOUNDS.timeoutMinutes}
                  value={texts.timeout}
                  error={fieldErrors[FIELD.timeout]}
                  onChange={(t) => {
                    dispatch({ type: 'patch', patch: { timeoutText: t } });
                  }}
                />
              </div>
              <p className="small muted">Concurrency: one step at a time (fixed in this release).</p>
            </Card>

            <Card labelledBy={ids.memory}>
              <CardHeader title="Memory records to include" titleId={ids.memory} />
              <p className="small muted">
                Approved records only. All approved records are included unless you untick them; pinned rules are always
                included.
              </p>
              <MemoryPicker
                records={approved.data}
                error={approved.error}
                onRetry={() => void approved.refetch()}
                checked={form.memoryIds}
                fieldError={fieldErrors[FIELD.memory]}
                suggestions={suggested.data?.length ?? 0}
                onToggle={(id, checked) => {
                  dispatch({
                    type: 'toggle-memory',
                    id,
                    checked,
                    defaults: (approved.data ?? []).filter((m) => !m.pinned).map((m) => m.id),
                  });
                }}
              />
            </Card>
          </div>

          <div className="stack">
            <Card labelledBy={ids.summary}>
              <CardHeader title="Input summary" titleId={ids.summary} />
              {preflightSystemError === null ? null : (
                <div className="stack">
                  <ErrorView error={toViewError(preflightSystemError)} onAction={onErrorAction} />
                  <div>
                    <Button pending={preflight.isFetching} onClick={() => void preflight.refetch()}>
                      Retry the check
                    </Button>
                  </div>
                </div>
              )}
              {pf === undefined ? (
                preflightSystemError !== null ? null : draft === null ? (
                  <p className="small muted">Select the input to see what this run will send and reserve.</p>
                ) : (
                  <div aria-busy="true">
                    <Skeleton lines={5} />
                  </div>
                )
              ) : (
                <div aria-busy={preflight.isFetching || undefined} className="stack">
                  <PreflightSummary
                    preflight={pf}
                    allowance={check.allowance}
                    capBytes={preview.data?.totals.capBytes}
                  />
                  <p className="small muted">
                    Reservation = estimated input + configured max output for the first model call. Tracked by
                    Relay; your provider bill may differ.
                  </p>
                </div>
              )}
            </Card>
            <Card labelledBy={ids.providers}>
              <CardHeader
                title="Providers that will receive this context"
                titleId={ids.providers}
                level={2}
              />
              {pf === undefined || preflightSystemError !== null ? (
                <p className="small muted">Shown after the check completes.</p>
              ) : (
                <ProvidersReceiving
                  preflight={pf}
                  footnote="Selected context leaves this computer only through these calls, and only to providers this project allows."
                />
              )}
            </Card>
            <p className="small">No project files will be modified. Output is a proposed patch.</p>
            <div className="stack">
              <Button
                type="submit"
                variant="primary"
                icon={Play}
                pending={start.isPending}
                disabled={startDisabled}
                aria-describedby="new-run-start-note"
              >
                Start run
              </Button>
              <p id="new-run-start-note" className="small subtle">
                {startDisabledReason ??
                  (pendingProblems > 0
                    ? `Fix ${String(pendingProblems)} problem${pendingProblems === 1 ? '' : 's'} to start.`
                    : 'Relay pauses for your approval before drafting a patch.')}
              </p>
              {otherStartError === null ? null : (
                <ErrorView error={toViewError(otherStartError)} onAction={onErrorAction} />
              )}
            </div>
          </div>
        </div>
      </form>
    </>
  );
}

interface LimitFieldProps {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly bounds: { readonly min: number; readonly max: number };
  readonly value: string;
  readonly error: string | undefined;
  readonly onChange: (text: string) => void;
}

/** A bounded whole-number limit (RUN_LIMIT_MAXIMUMS); the error shows as soon as the value is out of range. */
function LimitField({ id, label, hint, bounds, value, error, onChange }: LimitFieldProps) {
  return (
    <Field id={id} label={label} hint={`${hint} ${String(bounds.min)}–${String(bounds.max)}.`} error={error}>
      {(control) => (
        <NumberInput
          {...control}
          min={bounds.min}
          max={bounds.max}
          value={value}
          onValueChange={(t) => {
            onChange(t);
          }}
        />
      )}
    </Field>
  );
}
