import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import type { ProviderId } from '@relay/contracts';
import { Button, Checkbox, ErrorView, Field, InlineAlert, TextInput } from '../../components/ui';
import { call } from '../../api/client';
import { toViewError } from '../../api/errors';
import { qk } from '../../api/keys';
import { PROVIDER_LABELS } from '../../lib/format';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useIdempotentMutation } from '../../hooks/useIdempotentMutation';
import { usePreview } from '../../hooks/usePreview';
import { useProviders } from '../../hooks/useProviders';
import { PreviewPanel } from '../run-setup/PreviewPanel';
import { StepFrame } from './StepFrame';
import type { StepProps } from './StepFrame';

const LISTED: readonly ProviderId[] = ['anthropic', 'openai', 'gemini'];

/** "dist/**, *.log" → ["dist/**", "*.log"]. */
export function parseExclusions(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

const SAFE_NOTE =
  'Only files you select for a run are sent. This preview shows what is eligible. Paths are checked against the canonical project root, including symlinks.';

/** The sample (or an already created project): its preview only; the folder step is skipped (10 J6 step 4). */
function ExistingProject({
  go,
  projectId,
  name,
  isSample,
}: {
  readonly go: StepProps['go'];
  readonly projectId: string;
  readonly name: string;
  readonly isSample: boolean;
}) {
  const preview = usePreview({ projectId });
  return (
    <StepFrame
      title={isSample ? 'The sample project' : 'Project folder'}
      intro={
        isSample
          ? `${name} is a fictional project bundled with Relay, so there is no folder to choose. This is what a run can use.`
          : `${name} is set up. This is what a run can use.`
      }
      go={go}
      back="connect-provider"
      primary={{
        label: 'Continue',
        onSubmit: () => {
          go('add-rule');
        },
      }}
    >
      <h3>Included-file preview</h3>
      <PreviewPanel
        data={preview.data}
        error={preview.error}
        onRetry={() => void preview.refetch()}
        label={`Files in ${name}`}
      />
      <p className="small muted">{SAFE_NOTE}</p>
    </StepFrame>
  );
}

/** Step 4 `select-project`: pickDirectory → previewFiles → FileTree → projects.create (name + allowed providers). */
export function SelectProjectStep({ state, dispatch, go }: StepProps) {
  const queryClient = useQueryClient();
  const providers = useProviders();
  const [showErrors, setShowErrors] = useState(false);
  const exclusions = parseExclusions(useDebouncedValue(state.exclusionsText, 400));
  const preview = usePreview(
    state.selection === null ? null : { selectionId: state.selection.selectionId },
    exclusions,
  );
  const pick = useMutation({
    mutationFn: () => call('relay/v1/projects.pickDirectory', {}),
    onSuccess: (res) => {
      if (res.selection !== null) dispatch({ type: 'selection', selection: res.selection });
    },
  });
  const create = useIdempotentMutation('relay/v1/projects.create', {
    onSuccess: (project) => {
      dispatch({
        type: 'patch',
        patch: { project: { id: project.id, name: project.name, isSample: false } },
      });
      void queryClient.invalidateQueries({ queryKey: qk.projects() });
      go('add-rule');
    },
  });

  if (state.project !== null) {
    return (
      <ExistingProject
        go={go}
        projectId={state.project.id}
        name={state.project.name}
        isSample={state.project.isSample}
      />
    );
  }

  const connected = (providers.data ?? [])
    .filter((p) => p.connected && LISTED.includes(p.providerId))
    .map((p) => p.providerId);
  const allowed = state.allowedProviders ?? connected;
  const nameError =
    state.projectName.trim() === ''
      ? 'Give the project a name.'
      : state.projectName.length > 80
        ? 'Use at most 80 characters.'
        : null;
  const allowedError =
    allowed.length === 0 ? 'Allow at least one provider, or runs cannot send any context.' : null;

  const onCreate = () => {
    setShowErrors(true);
    if (state.selection === null || nameError !== null || allowedError !== null) return;
    create.mutate({
      selectionId: state.selection.selectionId,
      name: state.projectName.trim(),
      allowedProviderIds: [...allowed],
      ...(exclusions.length === 0 ? {} : { exclusions }),
    });
  };

  const pickButton = (
    <Button
      icon={FolderOpen}
      pending={pick.isPending}
      onClick={() => {
        pick.mutate();
      }}
    >
      {state.selection === null ? 'Choose folder…' : 'Choose a different folder'}
    </Button>
  );

  return (
    <StepFrame
      title="Select the project folder"
      intro="Relay reads files from this folder when you start a run. It never writes to it in this preview."
      go={go}
      back="connect-provider"
      primary={{
        label: 'Create project and continue',
        onSubmit: onCreate,
        pending: create.isPending,
        disabled: state.selection === null,
        disabledReason: 'Choose a folder first.',
      }}
    >
      {state.selection === null ? (
        <div className="stack">
          <p className="small">Pick a repository you own or have permission to process.</p>
          <div>{pickButton}</div>
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="mono">{state.selection.displayPath}</span>
            {pickButton}
          </div>
          <Field label="Project name" required error={showErrors ? nameError : null}>
            {(control) => (
              <TextInput
                {...control}
                value={state.projectName}
                maxLength={80}
                onValueChange={(v) => {
                  dispatch({ type: 'patch', patch: { projectName: v } });
                }}
              />
            )}
          </Field>
          <Field
            label="Extra exclude patterns"
            hint="Comma-separated, for example fixtures/**, *.log. Added to the built-in exclusions for dependencies, build output, secrets, binaries and OS files."
          >
            {(control) => (
              <TextInput
                {...control}
                mono
                value={state.exclusionsText}
                onValueChange={(v) => {
                  dispatch({ type: 'patch', patch: { exclusionsText: v } });
                }}
              />
            )}
          </Field>
          <fieldset
            className="fieldset field"
            aria-describedby={showErrors && allowedError !== null ? 'allowed-providers-error' : undefined}
          >
            <legend>Providers allowed to receive selected context</legend>
            <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
              {LISTED.map((id) => (
                <Checkbox
                  key={id}
                  label={`${PROVIDER_LABELS[id]}${connected.includes(id) ? '' : ' (not connected)'}`}
                  checked={allowed.includes(id)}
                  onCheckedChange={(checked) => {
                    const next = checked
                      ? [...allowed.filter((p) => p !== id), id]
                      : allowed.filter((p) => p !== id);
                    dispatch({ type: 'patch', patch: { allowedProviders: next } });
                  }}
                />
              ))}
            </div>
            {showErrors && allowedError !== null ? (
              <span className="error" id="allowed-providers-error">
                {allowedError}
              </span>
            ) : null}
          </fieldset>
          <h3>Included-file preview</h3>
          <PreviewPanel
            data={preview.data}
            error={preview.error}
            onRetry={() => void preview.refetch()}
            label={`Files in ${state.selection.displayPath}`}
          />
          <p className="small muted">{SAFE_NOTE}</p>
        </>
      )}
      {pick.error === null ? null : (
        <ErrorView
          error={toViewError(pick.error)}
          onAction={() => {
            pick.mutate();
          }}
        />
      )}
      {create.error === null || create.error === undefined ? null : (
        <ErrorView error={toViewError(create.error)} onAction={onCreate} />
      )}
      {state.selection === null && pick.isSuccess ? (
        <InlineAlert tone="neutral" title="No folder chosen">
          <p>The folder dialog was closed without a choice.</p>
        </InlineAlert>
      ) : null}
    </StepFrame>
  );
}
