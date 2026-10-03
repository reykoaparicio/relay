import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  BudgetBreakdownTable,
  Button,
  ErrorView,
  Field,
  InlineAlert,
  Skeleton,
  Textarea,
} from '../../components/ui';
import { call } from '../../api/client';
import { toViewError } from '../../api/errors';
import { qk } from '../../api/keys';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { canonicalJson, useIdempotentMutation } from '../../hooks/useIdempotentMutation';
import { usePreflight } from '../../hooks/usePreflight';
import { usePreview } from '../../hooks/usePreview';
import { useProfiles } from '../../hooks/useProfiles';
import { useWorkflow } from '../../hooks/useWorkflow';
import { useNextAction } from '../common/useNextAction';
import { FilePicker } from '../new-run/FilePicker';
import {
  ackEntries,
  ackInputs,
  acknowledgedFor,
  acknowledgedInput,
  budgetFromError,
  defaultFiles,
  deniedSecretMessage,
  deniedSecretsOf,
  fileCheckboxIds,
  validAcknowledged,
} from '../new-run/new-run-model';
import type { SecretAck } from '../new-run/new-run-model';
import { appErrorOf } from '../../api/errors';
import { PROVIDER_LABELS } from '../../lib/format';
import { paths } from '../shell/paths';
import { checkAllowance, checkWhole, LIMIT_BOUNDS } from '../run-setup/limits';
import { modelSteps, profileOverridesFor, ROLE_LABELS } from '../run-setup/model-steps';
import { issueMessage, MISSING_CREDENTIAL, problemIssues, stepKeyOfPath, stepProviderId } from '../run-setup/preflight-issues';
import { PreflightSummary, ProvidersReceiving, rolesByProvider } from '../run-setup/PreflightSummary';
import { useProviders } from '../../hooks/useProviders';
import { MissingPrerequisite } from './RuleTemplateSteps';
import { StepFrame } from './StepFrame';
import type { StepProps } from './StepFrame';

const SAMPLE_GOAL =
  'Reject invalid request values consistently, without changing the public response format.';

/** Step 8 `review-and-start`: preflight summary → Start run → onboarding completed → the run inspector. */
export function ReviewStep({ state, dispatch, go }: StepProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showErrors, setShowErrors] = useState(false);
  const project = state.project;
  const wf = state.workflow;
  const preview = usePreview(project === null ? null : { projectId: project.id });
  const workflow = useWorkflow(wf?.id, wf?.version);
  const profiles = useProfiles();
  const providers = useProviders();
  const goal = state.goal ?? (project?.isSample === true ? SAMPLE_GOAL : '');
  const debouncedGoal = useDebouncedValue(goal.trim(), 400);

  const allowance = checkAllowance(state.allowanceText ?? '3.00');
  const cycles = checkWhole(state.revisionText ?? '2', LIMIT_BOUNDS.maxRevisionCycles);
  // Every included file except suspected secrets (E2 #11) until the user narrows the selection (New run's FilePicker:
  // see and narrow the input); a suspected secret is added only by a confirmed tick.
  const [chosenFiles, setChosenFiles] = useState<readonly string[] | null>(null);
  // Each confirmation records the preview hash of the content confirmed (round-3 M4): a file changed since is asked again.
  const [acknowledged, setAcknowledged] = useState<readonly SecretAck[]>([]);
  const relPaths = [...(chosenFiles ?? defaultFiles(preview.data))];
  const validAcks = validAcknowledged(acknowledged, [], preview.data);
  const acked = acknowledgedFor(relPaths, validAcks);
  const checkboxIds = fileCheckboxIds(preview.data);
  const rows =
    workflow.data === undefined || profiles.data === undefined ? [] : modelSteps(workflow.data.spec, profiles.data);
  const overrides =
    workflow.data === undefined || profiles.data === undefined
      ? undefined
      : profileOverridesFor(rows, state.profileSelection);
  const base =
    project === null || wf === null || relPaths.length === 0
      ? null
      : {
          projectId: project.id,
          workflowId: wf.id,
          workflowVersion: wf.version,
          input: {
            kind: 'files' as const,
            relPaths,
            ...acknowledgedInput(relPaths, ackInputs(acknowledged, acked, preview.data)),
          },
          limitOverrides: {
            ...('value' in allowance ? { budgetMicrousd: allowance.value } : {}),
            ...('value' in cycles ? { maxRevisionCycles: cycles.value } : {}),
          },
          ...(overrides === undefined ? {} : { profileOverrides: overrides }),
        };
  const preflightInput = base === null || debouncedGoal === '' ? null : { ...base, goal: debouncedGoal };
  const preflightKey = preflightInput === null ? null : canonicalJson(preflightInput);
  const preflight = usePreflight(preflightKey);
  const submitInput = base === null ? null : { ...base, goal: goal.trim() };

  /** Set synchronously once runs.start succeeded: no further start from this step (one run per setup). */
  const startedRef = useRef(false);
  const [started, setStarted] = useState(false);
  const start = useIdempotentMutation('relay/v1/runs.start', {
    onSuccess: (res) => {
      startedRef.current = true;
      setStarted(true);
      if (project === null) return;
      // Open the run first; completing onboarding runs detached (it does not need this step mounted).
      void navigate(paths.run(project.id, res.runId));
      const projectId = project.id;
      void (async () => {
        try {
          await call('relay/v1/app.updateSettings', {
            onboardingCompletedAt: Date.now(),
            activeProjectId: projectId,
          });
        } catch {
          // The run exists either way. `/` offers setup again, where "Skip setup" completes it.
        }
        void queryClient.invalidateQueries({ queryKey: qk.settings() });
        void queryClient.invalidateQueries({ queryKey: qk.projects() });
      })();
    },
  });
  /** Focus a file's checkbox (a suspected-secret problem links back to it). */
  const focusFile = (relPath: string | undefined) => {
    const id = relPath === undefined ? undefined : checkboxIds.get(relPath);
    if (id !== undefined) document.getElementById(id)?.focus();
  };
  const goToFile = (relPath: string | undefined) =>
    relPath === undefined || !checkboxIds.has(relPath) ? null : (
      <>
        {' '}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            focusFile(relPath);
          }}
        >
          Go to file
        </Button>
      </>
    );
  const focusGoal = () => {
    document.getElementById('onboarding-goal')?.focus();
  };
  const toProfiles = () => {
    go('profiles-and-allowance');
  };
  const onStartErrorAction = useNextAction({
    increase_allowance: toProfiles,
    choose_profile: toProfiles,
    raise_limits: toProfiles,
    fix_input: focusGoal,
    edit_goal: focusGoal,
    narrow_scope: () => {
      go('select-project');
    },
    reload: () => void preflight.refetch(),
  });
  const onPreflightErrorAction = useNextAction({
    increase_allowance: toProfiles,
    choose_profile: toProfiles,
    raise_limits: toProfiles,
    fix_input: focusGoal,
    edit_goal: focusGoal,
    reload: () => void preflight.refetch(),
    wait: () => void preflight.refetch(),
  });

  if (project === null)
    return (
      <MissingPrerequisite
        go={go}
        title="Review the input and start"
        what="Choose a project"
        step="start-point"
      />
    );
  if (wf === null)
    return (
      <MissingPrerequisite
        go={go}
        title="Review the input and start"
        what="Choose a template"
        step="choose-template"
      />
    );

  const goalError =
    goal.trim() === ''
      ? 'Describe the outcome you want.'
      : goal.length > 2000
        ? 'Use at most 2000 characters.'
        : null;
  // Start is gated on a preflight of exactly the input that would be submitted: not a debounced/placeholder
  // result for an older input, not while it refetches, with no issues and within the allowance.
  const matches = preflightKey !== null && submitInput !== null && preflightKey === canonicalJson(submitInput);
  const settledCheck = matches && !preflight.isFetching && !preflight.isPlaceholderData;
  const fresh = settledCheck && preflight.isSuccess ? preflight.data : undefined;
  const pf = preflight.data;
  // Who would receive a confirmed suspected secret: the checked run's providers, else the steps' providers.
  const providerNames = (
    pf?.inputSummary.providersReceivingContext ?? [...rolesByProvider(rows, state.profileSelection, profiles.data).keys()]
  ).map((id) => PROVIDER_LABELS[id]);
  const deniedSecrets = deniedSecretsOf(appErrorOf(start.error));
  const budgetError = budgetFromError(preflight.error);
  const budget = budgetError ?? (pf !== undefined && !pf.budget.allowed ? pf.budget : null);
  const blocked = budget !== null;
  // budget_run / budget_project restate the blocked budget, which has its own alert below.
  const issues = pf === undefined ? [] : problemIssues(pf.issues, blocked);
  const preflightFailed = preflight.error !== null && budgetError === null;
  const checked = fresh !== undefined && fresh.issues.length === 0 && fresh.budget.allowed;
  const canStart = goalError !== null || (checked && !blocked);
  const onStart = () => {
    setShowErrors(true);
    if (startedRef.current || goalError !== null || submitInput === null || !canStart) return;
    start.mutate(submitInput);
  };
  const disabledReason = blocked
    ? 'Blocked by the run allowance. Go back and raise it.'
    : base === null
      ? preview.data !== undefined && relPaths.length === 0
        ? 'Select at least one file.'
        : 'Waiting for the file preview.'
      : preflightFailed
        ? 'The run check failed. Retry it above.'
        : issues.length > 0 && settledCheck
          ? 'Fix the problems above to start.'
          : 'Checking…';

  return (
    <StepFrame
      title="Review the input and start"
      go={go}
      back="profiles-and-allowance"
      primary={{
        label: 'Start run',
        onSubmit: onStart,
        pending: start.isPending || started,
        disabled: started || base === null || !canStart,
        disabledReason,
      }}
    >
      <Field
        id="onboarding-goal"
        label="Goal"
        required
        hint="Describe the outcome. Relay sends this to every role in the workflow."
        error={showErrors ? goalError : null}
      >
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            maxLength={2000}
            value={goal}
            onValueChange={(v) => {
              dispatch({ type: 'patch', patch: { goal: v } });
            }}
          />
        )}
      </Field>
      <FilePicker
        preview={preview.data}
        error={preview.error}
        onRetry={() => void preview.refetch()}
        selected={relPaths}
        acknowledged={acked}
        providerNames={providerNames}
        onChange={(next, ack) => {
          setChosenFiles(next);
          setAcknowledged(ackEntries(ack, acknowledged, validAcks, [], preview.data));
        }}
        fieldError={showErrors && preview.data !== undefined && relPaths.length === 0 ? 'Select at least one file.' : undefined}
      />
      <h3>Input summary</h3>
      {preflight.error === null ? null : budgetError !== null ? (
        <InlineAlert
          tone="warning"
          title="The run allowance would be exceeded"
          actions={<Button onClick={toProfiles}>Raise the run allowance</Button>}
        >
          <p>Relay did not reserve or send anything.</p>
          <BudgetBreakdownTable breakdown={budgetError} />
        </InlineAlert>
      ) : (
        <div className="stack">
          <ErrorView error={toViewError(preflight.error)} onAction={onPreflightErrorAction} />
          <div>
            <Button pending={preflight.isFetching} onClick={() => void preflight.refetch()}>
              Retry the check
            </Button>
          </div>
        </div>
      )}
      {pf === undefined ? (
        preflight.error === null ? (
          <div aria-busy="true" aria-label="Checking the run">
            <Skeleton lines={5} />
          </div>
        ) : null
      ) : (
        <div aria-busy={preflight.isFetching || undefined}>
          <PreflightSummary
            preflight={pf}
            allowance={'value' in allowance ? allowance.value : null}
            capBytes={preview.data?.totals.capBytes}
            leading={[
              { id: 'project', term: 'Project', value: project.name },
              { id: 'workflow', term: 'Workflow', value: `${wf.name} · v${String(wf.version)}` },
            ]}
          />
          {issues.length === 0 ? null : (
            <InlineAlert
              tone="danger"
              title={`${String(issues.length)} problem${issues.length === 1 ? '' : 's'} prevent starting`}
              actions={
                issues.some((i) => i.code === MISSING_CREDENTIAL) ? (
                  <Button
                    onClick={() => {
                      go('connect-provider');
                    }}
                  >
                    Connect provider
                  </Button>
                ) : undefined
              }
            >
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {issues.map((i) => {
                  const stepKey = stepKeyOfPath(i.path);
                  const row = stepKey === null ? undefined : rows.find((r) => r.stepKey === stepKey);
                  const providerId =
                    stepKey === null ? null : stepProviderId(stepKey, rows, state.profileSelection, profiles.data);
                  return (
                    <li key={`${i.path}:${i.code}`}>
                      {issueMessage(i, providerId, row === undefined ? null : ROLE_LABELS[row.role])}{' '}
                      <code className="small">{i.code}</code>
                      {goToFile(fileOfIssuePath(i.path, preflightRelPaths(preflightInput)))}
                    </li>
                  );
                })}
              </ul>
            </InlineAlert>
          )}
          {blocked && budgetError === null ? (
            <InlineAlert
              tone="warning"
              title="The run allowance would be exceeded"
              actions={
                <Button
                  onClick={() => {
                    go('profiles-and-allowance');
                  }}
                >
                  Raise the run allowance
                </Button>
              }
            >
              <p>Relay did not reserve or send anything.</p>
              <BudgetBreakdownTable breakdown={pf.budget} />
            </InlineAlert>
          ) : null}
          <h3>Providers receiving data</h3>
          <ProvidersReceiving
            preflight={pf}
            roles={rolesByProvider(rows, state.profileSelection, profiles.data)}
            statuses={providers.data}
            footnote="Excluded files such as .env are never sent."
          />
        </div>
      )}
      <p className="small">
        Relay will pause for your approval before drafting a patch. No project files will be modified.
      </p>
      {start.error === null || start.error === undefined ? null : deniedSecrets.length > 0 ? (
        <InlineAlert tone="danger" title="Relay did not start the run">
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {deniedSecrets.map((d) => (
              <li key={d.relPath}>
                {deniedSecretMessage(d)} <code className="small">suspected_secret</code>
                {goToFile(d.relPath)}
              </li>
            ))}
          </ul>
        </InlineAlert>
      ) : (
        <ErrorView live="assertive" error={toViewError(start.error)} onAction={onStartErrorAction} />
      )}
    </StepFrame>
  );
}

/** The `relPaths` of the checked input, else []. */
function preflightRelPaths(input: { readonly input: { readonly relPaths: readonly string[] } } | null): readonly string[] {
  return input?.input.relPaths ?? [];
}

/** The file an `input.relPaths.<i>` issue path names, else undefined. */
function fileOfIssuePath(path: string, relPaths: readonly string[]): string | undefined {
  const m = /^input\.relPaths\.(\d+)/.exec(path);
  return m?.[1] === undefined ? undefined : relPaths[Number(m[1])];
}
