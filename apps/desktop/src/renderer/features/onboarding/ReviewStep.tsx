import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { INPUT_CAPS } from '@relay/contracts';
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
import { isNotImplemented, toViewError } from '../../api/errors';
import { qk } from '../../api/keys';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { canonicalJson, useIdempotentMutation } from '../../hooks/useIdempotentMutation';
import { usePreflight } from '../../hooks/usePreflight';
import { usePreview } from '../../hooks/usePreview';
import { useProfiles } from '../../hooks/useProfiles';
import { useWorkflow } from '../../hooks/useWorkflow';
import { NotAvailableNotice } from '../common/NotAvailableNotice';
import { useNextAction } from '../common/useNextAction';
import { budgetFromError } from '../new-run/new-run-model';
import { paths } from '../shell/paths';
import { checkAllowance, checkWhole, LIMIT_BOUNDS } from '../run-setup/limits';
import { modelSteps, profileOverridesFor } from '../run-setup/model-steps';
import { PreflightSummary, ProvidersReceiving } from '../run-setup/PreflightSummary';
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
  const goal = state.goal ?? (project?.isSample === true ? SAMPLE_GOAL : '');
  const debouncedGoal = useDebouncedValue(goal.trim(), 400);

  const allowance = checkAllowance(state.allowanceText ?? '3.00');
  const cycles = checkWhole(state.revisionText ?? '2', LIMIT_BOUNDS.maxRevisionCycles);
  const relPaths = (preview.data?.included ?? []).slice(0, INPUT_CAPS.maxFiles).map((f) => f.relPath);
  const overrides =
    workflow.data === undefined || profiles.data === undefined
      ? undefined
      : profileOverridesFor(modelSteps(workflow.data.spec, profiles.data), state.profileSelection);
  const base =
    project === null || wf === null || relPaths.length === 0
      ? null
      : {
          projectId: project.id,
          workflowId: wf.id,
          workflowVersion: wf.version,
          input: { kind: 'files' as const, relPaths },
          limitOverrides: {
            ...('value' in allowance ? { budgetMicrousd: allowance.value } : {}),
            ...('value' in cycles ? { maxRevisionCycles: cycles.value } : {}),
          },
          ...(overrides === undefined ? {} : { profileOverrides: overrides }),
        };
  const preflightInput = base === null || debouncedGoal === '' ? null : { ...base, goal: debouncedGoal };
  const preflight = usePreflight(preflightInput);
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
  const onPreviewErrorAction = useNextAction({
    reload: () => void preview.refetch(),
    wait: () => void preview.refetch(),
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
  const matches =
    preflightInput !== null &&
    submitInput !== null &&
    canonicalJson(preflightInput) === canonicalJson(submitInput);
  const settledCheck = matches && !preflight.isFetching && !preflight.isPlaceholderData;
  const fresh = settledCheck && preflight.isSuccess ? preflight.data : undefined;
  const pf = preflight.data;
  const budgetError = budgetFromError(preflight.error);
  const budget = budgetError ?? (pf !== undefined && !pf.budget.allowed ? pf.budget : null);
  const blocked = budget !== null;
  // A stubbed preflight (not implemented in this build) cannot gate: runs.start runs its own admission check.
  const preflightUnavailable = settledCheck && isNotImplemented(preflight.error);
  const preflightFailed =
    preflight.error !== null && !isNotImplemented(preflight.error) && budgetError === null;
  const checked =
    preflightUnavailable || (fresh !== undefined && fresh.issues.length === 0 && fresh.budget.allowed);
  const canStart = goalError !== null || (checked && !blocked);
  const onStart = () => {
    setShowErrors(true);
    if (startedRef.current || goalError !== null || submitInput === null || !canStart) return;
    start.mutate(submitInput);
  };
  const disabledReason = blocked
    ? 'Blocked by the run allowance. Go back and raise it.'
    : base === null
      ? 'Waiting for the file preview.'
      : preflightFailed
        ? 'The run check failed. Retry it above.'
        : pf !== undefined && pf.issues.length > 0 && settledCheck
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
      <h3>Input summary</h3>
      {preview.error === null ? null : (
        <ErrorView error={toViewError(preview.error)} onAction={onPreviewErrorAction} />
      )}
      {preflight.error === null ? null : isNotImplemented(preflight.error) ? (
        <NotAvailableNotice error={preflight.error} />
      ) : budgetError !== null ? (
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
          {pf.issues.length === 0 ? null : (
            <InlineAlert
              tone="danger"
              title={`${String(pf.issues.length)} problem${pf.issues.length === 1 ? '' : 's'} prevent starting`}
            >
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {pf.issues.map((i) => (
                  <li key={`${i.path}:${i.code}`}>{i.message}</li>
                ))}
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
          <ProvidersReceiving preflight={pf} footnote="Excluded files such as .env are never sent." />
        </div>
      )}
      <p className="small">
        Relay will pause for your approval before drafting a patch. No project files will be modified.
      </p>
      {start.error === null || start.error === undefined ? null : (
        <ErrorView error={toViewError(start.error)} onAction={onStartErrorAction} />
      )}
    </StepFrame>
  );
}
