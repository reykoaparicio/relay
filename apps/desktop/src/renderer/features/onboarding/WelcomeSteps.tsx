import { Box, Cloud, HardDrive } from 'lucide-react';
import { Button, ErrorView, RadioGroup } from '../../components/ui';
import { toViewError } from '../../api/errors';
import { StepFrame } from './StepFrame';
import type { StepProps } from './StepFrame';
import { useSampleProject } from './useSampleProject';

/** Step 1 `welcome`: the local-storage vs remote-processing boundary (§6.2), with the sample offered up front. */
export function WelcomeStep({ dispatch, go }: StepProps) {
  const sample = useSampleProject(dispatch, () => {
    go('connect-provider');
  });
  return (
    <StepFrame
      title="Welcome to Relay"
      intro="Run a repeatable AI review-to-patch workflow on your code, with visible spending and your approval before any patch is drafted."
      go={go}
      primary={{
        label: 'Continue',
        onSubmit: () => {
          go('start-point');
        },
      }}
    >
      <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
        <div className="stack rounded-md border border-border bg-surface-raised p-4">
          <h3 className="row" style={{ gap: 8 }}>
            <HardDrive aria-hidden="true" width={18} height={18} />
            Stored on this computer
          </h3>
          <ul className="stack small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Projects, runs, step checkpoints and artifacts</li>
            <li>Approved project memory and its revision history</li>
            <li>The usage ledger tracked by Relay</li>
            <li>API keys, in your OS credential store (never plaintext)</li>
          </ul>
        </div>
        <div className="stack rounded-md border border-border bg-surface-raised p-4">
          <h3 className="row" style={{ gap: 8 }}>
            <Cloud aria-hidden="true" width={18} height={18} />
            Processed remotely
          </h3>
          <ul className="stack small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Only the context you select: goal, diff or files, approved memory</li>
            <li>Sent only to model providers you connect and allow per project</li>
            <li>Nothing is sent until you start a run</li>
            <li>Local storage does not make remote processing private or offline</li>
          </ul>
        </div>
      </div>
      <p className="small">
        In this preview Relay never modifies your project files. Results are proposed patches you export.
      </p>
      <div className="stack rounded-md border border-border p-4">
        <strong>Want to look around first?</strong>
        <p className="small muted">
          A fictional sample project with a prepared change lets you try a full run before pointing Relay at
          your own code.
        </p>
        <div>
          <Button
            icon={Box}
            pending={sample.isPending}
            onClick={() => {
              sample.mutate({});
            }}
          >
            Use the sample project
          </Button>
        </div>
        {sample.error === null || sample.error === undefined ? null : (
          <ErrorView
            error={toViewError(sample.error)}
            onAction={() => {
              sample.mutate({});
            }}
          />
        )}
      </div>
    </StepFrame>
  );
}

/** Step 2 `start-point`: the sample (`projects.createSample`) or my own folder (created on step 4). */
export function StartPointStep({ state, dispatch, go }: StepProps) {
  const sample = useSampleProject(dispatch, () => {
    go('connect-provider');
  });
  const onContinue = () => {
    if (state.startPoint === 'own') {
      // Switching away from the sample: the own project is created on the folder step.
      if (state.project?.isSample === true) dispatch({ type: 'patch', patch: { project: null } });
      go('connect-provider');
    } else if (state.project?.isSample === true) {
      go('connect-provider');
    } else {
      sample.mutate({});
    }
  };
  return (
    <StepFrame
      title="Choose a starting point"
      go={go}
      back="welcome"
      primary={{ label: 'Continue', onSubmit: onContinue, pending: sample.isPending }}
    >
      <RadioGroup
        legend="Project to set up"
        value={state.startPoint}
        onValueChange={(v) => {
          dispatch({ type: 'patch', patch: { startPoint: v } });
        }}
        options={[
          {
            value: 'sample',
            label: 'Built-in sample project',
            description:
              'A small fictional API with a prepared change that adds input validation. Safe to share on screen. Recommended for a first run.',
          },
          {
            value: 'own',
            label: 'My own project folder',
            description:
              'Use a repository you own or have permission to process. You will see exactly which files are eligible before anything is sent.',
          },
        ]}
      />
      <p className="small muted">Either way, you need one connected provider to run the workflow.</p>
      {sample.error === null || sample.error === undefined ? null : (
        <ErrorView
          error={toViewError(sample.error)}
          onAction={() => {
            sample.mutate({});
          }}
        />
      )}
    </StepFrame>
  );
}
