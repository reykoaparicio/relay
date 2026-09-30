import { useEffect, useReducer, useRef } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate, useParams } from 'react-router';
import { Button, ErrorView, PageHeader, Stepper, useLiveRegion } from '../components/ui';
import { call } from '../api/client';
import { toViewError } from '../api/errors';
import { qk } from '../api/keys';
import { ConnectProviderStep } from '../features/onboarding/ConnectProviderStep';
import {
  INITIAL_ONBOARDING,
  isOnboardingStep,
  ONBOARDING_STEPS,
  onboardingReducer,
  stepIndex,
} from '../features/onboarding/onboarding-state';
import type { OnboardingStep } from '../features/onboarding/onboarding-state';
import { ProfilesStep } from '../features/onboarding/ProfilesStep';
import { ReviewStep } from '../features/onboarding/ReviewStep';
import { AddRuleStep, ChooseTemplateStep } from '../features/onboarding/RuleTemplateSteps';
import { SelectProjectStep } from '../features/onboarding/SelectProjectStep';
import type { StepProps } from '../features/onboarding/StepFrame';
import { StartPointStep, WelcomeStep } from '../features/onboarding/WelcomeSteps';
import { paths } from '../features/shell/paths';
import { useNextAction } from '../features/common/useNextAction';
import { useNavPerf } from '../hooks/useNavPerf';
import { useProjects } from '../hooks/useProjects';
import { useSettings } from '../hooks/useSettings';

const STEP_VIEWS: Readonly<Record<OnboardingStep, (p: StepProps) => ReactNode>> = {
  welcome: WelcomeStep,
  'start-point': StartPointStep,
  'connect-provider': ConnectProviderStep,
  'select-project': SelectProjectStep,
  'add-rule': AddRuleStep,
  'choose-template': ChooseTemplateStep,
  'profiles-and-allowance': ProfilesStep,
  'review-and-start': ReviewStep,
};

/** "Skip setup" (only when a project already exists, so `/` has somewhere to go). */
function SkipSetup() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projects = useProjects();
  const settings = useSettings();
  const onSkipErrorAction = useNextAction();
  const target = projects.data?.find((p) => p.id === settings.data?.activeProjectId) ?? projects.data?.[0];
  const skip = useMutation({
    mutationFn: (projectId: string) =>
      call('relay/v1/app.updateSettings', { onboardingCompletedAt: Date.now(), activeProjectId: projectId }),
    onSuccess: (s) => {
      queryClient.setQueryData(qk.settings(), s);
      if (s.activeProjectId !== null) void navigate(paths.overview(s.activeProjectId));
    },
  });
  if (target === undefined) return null;
  return (
    <div className="stack" style={{ alignItems: 'flex-end' }}>
      <Button
        variant="ghost"
        pending={skip.isPending}
        onClick={() => {
          skip.mutate(target.id);
        }}
      >
        Skip setup
      </Button>
      {skip.error === null ? null : <ErrorView error={toViewError(skip.error)} onAction={onSkipErrorAction} />}
    </div>
  );
}

/**
 * On a step change (not the first render), focus moves to the new step's heading and the live region announces
 * "Step N of 8: <heading>" (keyboard and screen-reader users otherwise stay on a button that no longer exists).
 */
function useStepFocus(current: OnboardingStep | null) {
  const { announce } = useLiveRegion();
  const previous = useRef(current);
  useEffect(() => {
    if (current === null || previous.current === current) return;
    previous.current = current;
    const heading = document.querySelector<HTMLElement>('[data-step-heading]');
    heading?.focus();
    const title = heading?.textContent.trim() ?? '';
    const n = stepIndex(current) + 1;
    const label = title === '' ? (ONBOARDING_STEPS[n - 1]?.label ?? '') : title;
    announce(`Step ${String(n)} of ${String(ONBOARDING_STEPS.length)}: ${label}`);
  }, [current, announce]);
}

/**
 * First-run setup (10 J6, §4.1): 8 steps addressed by `/onboarding/:step`. Back and Continue keep the state in a
 * reducer; nothing is persisted until an explicit action.
 */
export function OnboardingPage() {
  const { step } = useParams();
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(onboardingReducer, INITIAL_ONBOARDING);
  const current: OnboardingStep | null =
    step === undefined ? 'welcome' : isOnboardingStep(step) ? step : null;
  useNavPerf('onboarding', current !== null);
  useStepFocus(current);
  if (current === null) return <Navigate to={paths.onboarding('welcome')} replace />;

  const index = stepIndex(current);
  const go = (next: OnboardingStep) => {
    void navigate(paths.onboarding(next));
  };
  const View = STEP_VIEWS[current];
  return (
    <>
      <PageHeader
        title="Set up Relay"
        breadcrumbs={[{ label: 'First launch' }]}
        status={
          <span className="small">
            Step {String(index + 1)} of {String(ONBOARDING_STEPS.length)}
          </span>
        }
        actions={<SkipSetup />}
      />
      <Stepper steps={ONBOARDING_STEPS} currentKey={current} label="Setup progress" />
      <View state={state} dispatch={dispatch} go={go} />
    </>
  );
}
