import { useState } from 'react';
import { DEFAULT_LIMITS } from '@relay/contracts';
import type { Microusd } from '@relay/contracts';
import { ErrorView, Field, MoneyInput, NumberInput, Skeleton } from '../../components/ui';
import { toViewError } from '../../api/errors';
import { useProfiles } from '../../hooks/useProfiles';
import { useProviders } from '../../hooks/useProviders';
import { useWorkflow } from '../../hooks/useWorkflow';
import { checkAllowance, checkWhole, dollarsText, LIMIT_BOUNDS } from '../run-setup/limits';
import { modelSteps } from '../run-setup/model-steps';
import { ProfileAssignmentTable } from '../run-setup/ProfileAssignmentTable';
import { MissingPrerequisite } from './RuleTemplateSteps';
import { StepFrame } from './StepFrame';
import type { StepProps } from './StepFrame';

/** Step 7 `profiles-and-allowance`: role → profile table (editable) and the run allowance (default $3.00). */
export function ProfilesStep({ state, dispatch, go }: StepProps) {
  const workflow = useWorkflow(state.workflow?.id, state.workflow?.version);
  const profiles = useProfiles();
  const providers = useProviders();
  const [showErrors, setShowErrors] = useState(false);
  if (state.workflow === null)
    return (
      <MissingPrerequisite
        go={go}
        title="Pick role profiles and a run allowance"
        what="Choose a template"
        step="choose-template"
      />
    );

  const spec = workflow.data?.spec;
  const defaultAllowance = (spec?.limits.budgetMicrousd ?? DEFAULT_LIMITS.budgetMicrousd) as Microusd;
  const defaultCycles = spec?.limits.maxRevisionCycles ?? DEFAULT_LIMITS.maxRevisionCycles;
  const allowanceText = state.allowanceText ?? dollarsText(defaultAllowance);
  const revisionText = state.revisionText ?? String(defaultCycles);
  const allowance = checkAllowance(allowanceText);
  const cycles = checkWhole(revisionText, LIMIT_BOUNDS.maxRevisionCycles);
  const loadError = workflow.error ?? profiles.error;
  const connected = (providers.data ?? []).filter((p) => p.connected);

  return (
    <StepFrame
      title="Pick role profiles and a run allowance"
      intro="Each role in the template uses a model profile. Profiles are copied into the run, so later edits do not change it."
      go={go}
      back="choose-template"
      primary={{
        label: 'Continue',
        onSubmit: () => {
          setShowErrors(true);
          if ('error' in allowance || 'error' in cycles) return;
          dispatch({ type: 'patch', patch: { allowanceText, revisionText } });
          go('review-and-start');
        },
      }}
    >
      {loadError === null ? null : (
        <ErrorView
          error={toViewError(loadError)}
          onAction={() => {
            void workflow.refetch();
            void profiles.refetch();
          }}
        />
      )}
      {spec === undefined || profiles.data === undefined ? (
        loadError === null ? (
          <div aria-busy="true">
            <Skeleton lines={4} />
          </div>
        ) : null
      ) : (
        <>
          <h3>Model profile for each role</h3>
          <ProfileAssignmentTable
            caption="Model profile for each role"
            rows={modelSteps(spec, profiles.data)}
            profiles={profiles.data}
            providers={providers.data}
            selected={state.profileSelection}
            selectId={(k) => `onboarding-profile-${k}`}
            onSelect={(stepKey, profileId) => {
              dispatch({ type: 'select-profile', stepKey, profileId });
            }}
          />
          {connected.length === 1 ? (
            <p className="small muted">
              Only {connected[0]?.displayName} is connected. Roles whose profile uses another provider cannot
              start until you pick a profile on {connected[0]?.displayName} or connect that provider in
              Settings.
            </p>
          ) : null}
        </>
      )}
      <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
        <MoneyInput
          id="onboarding-allowance"
          label="Run allowance (USD)"
          value={allowanceText}
          required
          hint="Relay blocks the next call if its reservation would exceed this. Tracked by Relay, not a provider billing cap."
          error={showErrors && 'error' in allowance ? allowance.error : undefined}
          onValueChange={(text) => {
            dispatch({ type: 'patch', patch: { allowanceText: text } });
          }}
        />
        <Field
          id="onboarding-revisions"
          label="Revision cycles"
          hint={`Then the run is marked incomplete. At most ${String(LIMIT_BOUNDS.maxRevisionCycles.max)}.`}
          error={'error' in cycles ? cycles.error : null}
        >
          {(control) => (
            <NumberInput
              {...control}
              min={LIMIT_BOUNDS.maxRevisionCycles.min}
              max={LIMIT_BOUNDS.maxRevisionCycles.max}
              value={revisionText}
              onValueChange={(text) => {
                dispatch({ type: 'patch', patch: { revisionText: text } });
              }}
            />
          )}
        </Field>
      </div>
      <p className="small muted">Set a project monthly allowance later in Settings → Projects.</p>
    </StepFrame>
  );
}
