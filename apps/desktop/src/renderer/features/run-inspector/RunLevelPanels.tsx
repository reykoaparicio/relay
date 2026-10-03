// Attempts and Context tabs of the run inspector with their run-level views (E1): every attempt of the run
// (`RunDetail.attempts`) next to the selected step's, and the newest context manifest of the run
// (`RunDetail.latestManifest`, fetched with `artifacts.get`) when the selected step sent none.
import { useCallback, useState } from 'react';
import { contextManifestSchema } from '@relay/contracts';
import type { AttemptView, ContextManifest, RunDetail, StepDetail, StepView } from '@relay/contracts';
import { AttemptsTable, Button, ContextManifestView, Skeleton } from '../../components/ui';
import { isAppErrorException } from '../../api/client';
import { useArtifact } from '../../hooks/useArtifact';
import { ActionErrorNotice } from './ActionErrorNotice';
import { stepTitle } from './inspector-model';

type AttemptsScope = 'step' | 'run';

export interface AttemptsPanelProps {
  readonly run: RunDetail;
  readonly step: StepView;
  /** The selected step's attempts; undefined while its detail loads. */
  readonly stepAttempts: readonly AttemptView[] | undefined;
}

/**
 * "This step / Whole run" toggle over the Attempts table. The whole-run view needs `RunDetail.attempts` (older runners
 * omit it: then only the step's attempts are shown, with no toggle). A step with no attempts opens on the whole run.
 */
export function AttemptsPanel({ run, step, stepAttempts }: AttemptsPanelProps) {
  const [chosen, setChosen] = useState<AttemptsScope | null>(null);
  const runAttempts = run.attempts;
  const stepName = stepTitle(step, run.stepMeta);
  const stepNameFor = useCallback((stepKey: string) => stepTitle({ stepKey }, run.stepMeta), [run.stepMeta]);
  if (runAttempts === undefined) {
    return stepAttempts === undefined ? (
      <Skeleton lines={4} />
    ) : (
      <AttemptsTable attempts={stepAttempts} caption={`Attempts for ${stepName}`} />
    );
  }
  const scope: AttemptsScope =
    chosen ??
    (stepAttempts !== undefined && stepAttempts.length === 0 && runAttempts.length > 0 ? 'run' : 'step');
  return (
    <div className="stack">
      <div className="actions" role="group" aria-label="Attempts to show">
        <Button
          size="sm"
          variant={scope === 'step' ? 'primary' : 'ghost'}
          aria-pressed={scope === 'step'}
          onClick={() => {
            setChosen('step');
          }}
        >
          This step
        </Button>
        <Button
          size="sm"
          variant={scope === 'run' ? 'primary' : 'ghost'}
          aria-pressed={scope === 'run'}
          onClick={() => {
            setChosen('run');
          }}
        >
          Whole run
        </Button>
      </div>
      {scope === 'run' ? (
        <>
          {chosen === null ? (
            <p className="subtle small">
              {stepName} has no attempts yet, so every attempt of the run is shown.
            </p>
          ) : null}
          <AttemptsTable
            attempts={runAttempts}
            caption="Attempts for the whole run, oldest first"
            stepNameFor={stepNameFor}
          />
        </>
      ) : stepAttempts === undefined ? (
        <Skeleton lines={4} />
      ) : (
        <AttemptsTable attempts={stepAttempts} caption={`Attempts for ${stepName}`} />
      )}
    </div>
  );
}

export interface ContextPanelProps {
  readonly run: RunDetail;
  /** The selected step's detail; undefined while it loads. */
  readonly detail: StepDetail | undefined;
}

/** The selected step's manifest, else the run's latest one ("Latest context sent (step X)"), else a plain note. */
export function ContextPanel({ run, detail }: ContextPanelProps) {
  if (detail === undefined) return <Skeleton lines={4} />;
  if (detail.manifest !== null) {
    return (
      <div className="stack">
        <p className="subtle">
          Immutable manifest for this request. Only these items were sent to providers.
        </p>
        <ContextManifestView manifest={detail.manifest} />
      </div>
    );
  }
  const latest = run.latestManifest;
  if (latest === undefined || latest === null) {
    return (
      <p className="subtle">
        No context was sent for this step. Only the items in a manifest are ever sent to a provider.
      </p>
    );
  }
  return (
    <LatestManifest
      artifactId={latest.artifactId}
      stepName={stepTitle({ stepKey: latest.stepKey }, run.stepMeta)}
    />
  );
}

type ManifestLoad =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly manifest: ContextManifest }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'error'; readonly error: unknown };

/** `artifacts.get` of the latest manifest, schema-checked (`contextManifestSchema`) before anything is rendered. */
function useLatestManifest(artifactId: string): ManifestLoad {
  const q = useArtifact(artifactId);
  if (q.error !== null) {
    return isAppErrorException(q.error) && q.error.appError.code === 'NOT_FOUND'
      ? { kind: 'gone' }
      : { kind: 'error', error: q.error };
  }
  if (q.data === undefined) return { kind: 'loading' };
  if (q.data.meta.purged) return { kind: 'gone' };
  if (q.data.content.kind !== 'json') return { kind: 'unreadable' };
  const parsed = contextManifestSchema.safeParse(q.data.content.value);
  return parsed.success ? { kind: 'ready', manifest: parsed.data } : { kind: 'unreadable' };
}

function LatestManifest({
  artifactId,
  stepName,
}: {
  readonly artifactId: string;
  readonly stepName: string;
}) {
  const load = useLatestManifest(artifactId);
  const heading = `Latest context sent (step ${stepName})`;
  return (
    <div className="stack">
      <p className="subtle">
        This step sent no context to a provider. The most recent request of the run is shown instead. Only the
        items in a manifest are ever sent to a provider.
      </p>
      <h3 className="section-label">{heading}</h3>
      {load.kind === 'loading' ? (
        <Skeleton lines={4} />
      ) : load.kind === 'ready' ? (
        <ContextManifestView manifest={load.manifest} />
      ) : load.kind === 'gone' ? (
        <p className="subtle">
          This manifest is no longer stored (removed by retention). Its record in the run is kept.
        </p>
      ) : load.kind === 'unreadable' ? (
        <p className="subtle">This manifest could not be read, so it is not shown.</p>
      ) : (
        <ActionErrorNotice error={load.error} />
      )}
    </div>
  );
}
