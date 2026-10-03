import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import type { ProviderId } from '@relay/contracts';
import { Button, Checkbox, ErrorView, Field, InlineAlert, TextInput } from '../../components/ui';
import { call } from '../../api/client';
import { isAppErrorException } from '../../api/client';
import { toViewError } from '../../api/errors';
import { qk } from '../../api/keys';
import { PROVIDER_LABELS } from '../../lib/format';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useIdempotentMutation } from '../../hooks/useIdempotentMutation';
import { usePreview } from '../../hooks/usePreview';
import { useProject } from '../../hooks/useProject';
import { useProviders } from '../../hooks/useProviders';
import { PreviewPanel } from '../run-setup/PreviewPanel';
import { useNextAction } from '../common/useNextAction';
import { selectionExpired } from './onboarding-state';
import { StepFrame } from './StepFrame';
import type { StepProps } from './StepFrame';

const LISTED: readonly ProviderId[] = ['anthropic', 'openai', 'gemini'];

/** "dist/**, *.log" → ["dist/**", "*.log"]. */
function parseExclusions(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

const SAFE_NOTE =
  'Only files you select for a run are sent. This preview shows what is eligible. Paths are checked against the canonical project root, including symlinks.';

/** "Providers allowed to receive selected context" checkboxes (own folder and the sample alike). */
function ProviderAllowList({
  allowed,
  connected,
  error,
  onChange,
}: {
  readonly allowed: readonly ProviderId[];
  readonly connected: readonly ProviderId[];
  readonly error: string | null;
  readonly onChange: (next: ProviderId[]) => void;
}) {
  return (
    <fieldset className="fieldset field" aria-describedby={error === null ? undefined : 'allowed-providers-error'}>
      <legend>Providers allowed to receive selected context</legend>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
        {LISTED.map((id) => (
          <Checkbox
            key={id}
            label={`${PROVIDER_LABELS[id]}${connected.includes(id) ? '' : ' (not connected)'}`}
            checked={allowed.includes(id)}
            onCheckedChange={(checked) => {
              onChange(checked ? [...allowed.filter((p) => p !== id), id] : allowed.filter((p) => p !== id));
            }}
          />
        ))}
      </div>
      {error === null ? null : (
        <span className="error" id="allowed-providers-error">
          {error}
        </span>
      )}
    </fieldset>
  );
}

const ALLOWED_ERROR = 'Allow at least one provider, or runs cannot send any context.';

/**
 * The sample (or an already created project): its preview, and for the sample the allowed providers (saved with
 * `projects.update`, like your own folder's are set at create); the folder step is skipped (10 J6 step 4).
 */
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
  const queryClient = useQueryClient();
  const preview = usePreview({ projectId });
  const project = useProject(isSample ? projectId : undefined);
  const providers = useProviders();
  const [edited, setEdited] = useState<readonly ProviderId[] | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const connected = (providers.data ?? []).filter((p) => p.connected && LISTED.includes(p.providerId)).map((p) => p.providerId);
  const saved = project.data?.providerPolicy.allowedProviderIds;
  const allowed = edited ?? saved ?? [];
  const update = useMutation({
    mutationFn: (ids: readonly ProviderId[]) =>
      call('relay/v1/projects.update', {
        projectId,
        expectedUpdatedAt: project.data?.updatedAt ?? 0,
        patch: { allowedProviderIds: [...ids] },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
      void queryClient.invalidateQueries({ queryKey: qk.projects() });
      go('add-rule');
    },
  });
  const allowedError = isSample && allowed.length === 0 ? ALLOWED_ERROR : null;
  const changed = edited !== null && saved !== undefined && [...edited].sort().join() !== [...saved].sort().join();
  const onContinue = () => {
    setShowErrors(true);
    if (allowedError !== null) return;
    if (changed) update.mutate(allowed);
    else go('add-rule');
  };
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
        onSubmit: onContinue,
        pending: update.isPending,
        disabled: isSample && project.data === undefined,
        disabledReason: 'Loading the sample project…',
      }}
    >
      {isSample ? (
        <ProviderAllowList
          allowed={allowed}
          connected={connected}
          error={showErrors ? allowedError : null}
          onChange={setEdited}
        />
      ) : null}
      {update.error === null ? null : <ErrorView live="assertive" error={toViewError(update.error)} onAction={() => { update.reset(); }} />}
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
  /** The folder choice expired (or main no longer knows it): the user must choose the folder again. */
  const [selectionLost, setSelectionLost] = useState(false);
  const pick = useMutation({
    mutationFn: () => call('relay/v1/projects.pickDirectory', {}),
    onSuccess: (res) => {
      if (res.selection !== null) {
        setSelectionLost(false);
        dispatch({ type: 'selection', selection: res.selection });
      }
    },
  });
  const create = useIdempotentMutation('relay/v1/projects.create', {
    onError: (e) => {
      if (isAppErrorException(e) && e.appError.code === 'NOT_FOUND') loseSelection();
    },
    onSuccess: (project) => {
      dispatch({
        type: 'patch',
        patch: { project: { id: project.id, name: project.name, isSample: false } },
      });
      void queryClient.invalidateQueries({ queryKey: qk.projects() });
      go('add-rule');
    },
  });

  function loseSelection() {
    // A new folder choice is a new intent: never reuse the key of the create that named the old selection.
    create.newIntent();
    setSelectionLost(true);
    setShowErrors(false);
    dispatch({ type: 'clear-selection' });
  }
  const onPickErrorAction = useNextAction();
  const onCreateErrorAction = useNextAction({
    fix_input: () => {
      setShowErrors(true);
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
  const allowedError = allowed.length === 0 ? ALLOWED_ERROR : null;

  const onCreate = () => {
    setShowErrors(true);
    if (state.selection === null) return;
    if (selectionExpired(state.selection, Date.now())) {
      loseSelection();
      return;
    }
    if (nameError !== null || allowedError !== null) return;
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
      {state.selection === null && selectionLost ? (
        <InlineAlert tone="warning" title="Choose the folder again">
          <p>
            The folder choice expired before the project was created. Nothing was created. Choose the folder
            again to continue.
          </p>
        </InlineAlert>
      ) : null}
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
          <ProviderAllowList
            allowed={allowed}
            connected={connected}
            error={showErrors ? allowedError : null}
            onChange={(next) => {
              dispatch({ type: 'patch', patch: { allowedProviders: next } });
            }}
          />
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
        <ErrorView live="assertive" error={toViewError(pick.error)} onAction={onPickErrorAction} />
      )}
      {create.error === null || create.error === undefined || selectionLost ? null : (
        <ErrorView live="assertive" error={toViewError(create.error)} onAction={onCreateErrorAction} />
      )}
      {state.selection === null && pick.isSuccess && !selectionLost ? (
        <InlineAlert tone="neutral" title="No folder chosen">
          <p>The folder dialog was closed without a choice.</p>
        </InlineAlert>
      ) : null}
    </StepFrame>
  );
}
