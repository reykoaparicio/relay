import { useState } from 'react';
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
import { useIdempotentMutation } from '../../hooks/useIdempotentMutation';
import { usePreflight } from '../../hooks/usePreflight';
import { usePreview } from '../../hooks/usePreview';
import { useProfiles } from '../../hooks/useProfiles';
import { useWorkflow } from '../../hooks/useWorkflow';
import { NotAvailableNotice } from '../common/NotAvailableNotice';
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
  const preflight = usePreflight(
    base === null || debouncedGoal === '' ? null : { ...base, goal: debouncedGoal },
  );

  const start = useIdempotentMutation('relay/v1/runs.start', {
    onSuccess: (res) => {
      if (project === null) return;
      const finish = async () => {
        try {
          await call('relay/v1/app.updateSettings', {
            onboardingCompletedAt: Date.now(),
            activeProjectId: project.id,
          });
        } catch {
          // The run exists either way: open it. `/` offers setup again, where "Skip setup" completes it.
        }
        await queryClient.invalidateQueries({ queryKey: qk.settings() });
        void queryClient.invalidateQueries({ queryKey: qk.projects() });
        void navigate(paths.run(project.id, res.runId));
      };
      void finish();
    },
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
  const pf = preflight.data;
  const blocked = pf !== undefined && !pf.budget.allowed;
  const onStart = () => {
    setShowErrors(true);
    if (goalError !== null || base === null) return;
    start.mutate({ ...base, goal: goal.trim() });
  };

  return (
    <StepFrame
      title="Review the input and start"
      go={go}
      back="profiles-and-allowance"
      primary={{
        label: 'Start run',
        onSubmit: onStart,
        pending: start.isPending,
        disabled: blocked || base === null,
        disabledReason: blocked
          ? 'Blocked by the run allowance. Go back and raise it.'
          : 'Waiting for the file preview.',
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
        <ErrorView error={toViewError(preview.error)} onAction={() => void preview.refetch()} />
      )}
      {preflight.error === null ? null : isNotImplemented(preflight.error) ? (
        <NotAvailableNotice error={preflight.error} />
      ) : (
        <ErrorView error={toViewError(preflight.error)} onAction={() => void preflight.refetch()} />
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
          {blocked ? (
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
        <ErrorView error={toViewError(start.error)} onAction={onStart} />
      )}
    </StepFrame>
  );
}
