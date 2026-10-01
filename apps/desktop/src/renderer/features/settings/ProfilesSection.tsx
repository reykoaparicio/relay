import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { EFFORT_LEVELS, MAX_OUTPUT_TOKENS_CEILING } from '@relay/contracts';
import type { CapabilityWarning, CatalogModel, Effort, ModelProfile, ProfileWithWarnings, ProviderId } from '@relay/contracts';
import {
  Button,
  ConfirmDialog,
  ErrorView,
  Field,
  InlineAlert,
  NumberInput,
  Select,
  Skeleton,
  TextInput,
} from '../../components/ui';
import { call } from '../../api/client';
import { toViewError, validationIssuesOf } from '../../api/errors';
import { qk } from '../../api/keys';
import { PROVIDER_LABELS } from '../../lib/format';
import { useCatalog } from '../../hooks/useCatalog';
import { useProfiles } from '../../hooks/useProfiles';
import { useProfileUsage, useWorkflows } from '../../hooks/useWorkflow';
import type { ProfileUse } from '../../hooks/useWorkflow';
import { MutationError } from '../common/MutationError';
import { conflictReason } from '../common/conflict';
import { useRetryAction } from '../common/useNextAction';
import { paths } from '../shell/paths';
import { useSettingsProject } from './useSettingsProject';

interface Draft {
  readonly id: ModelProfile['id'] | null;
  readonly expectedRevision: number | null;
  readonly name: string;
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly maxOutputTokens: string;
  readonly effort: Effort | '';
  readonly base: ModelProfile | null;
}

function draftOf(p: ModelProfile): Draft {
  return {
    id: p.id,
    expectedRevision: p.revision,
    name: p.name,
    providerId: p.providerId,
    modelId: p.modelId,
    maxOutputTokens: String(p.params.maxOutputTokens),
    effort: p.params.effort ?? '',
    base: p,
  };
}

function newDraft(catalog: readonly CatalogModel[]): Draft {
  const first = catalog[0];
  return {
    id: null,
    expectedRevision: null,
    name: '',
    providerId: first?.providerId ?? 'anthropic',
    modelId: first?.modelId ?? '',
    maxOutputTokens: '8000',
    effort: '',
    base: null,
  };
}

/** The saved params minus `effort` (the form sets it, or leaves it out for the provider default). */
function paramsWithoutEffort(base: ModelProfile | null): Omit<ModelProfile['params'], 'effort' | 'maxOutputTokens'> {
  if (base === null) return { refusalFallback: 'off' };
  const { refusalFallback, maxInputTokens } = base.params;
  return { refusalFallback, ...(maxInputTokens === undefined ? {} : { maxInputTokens }) };
}

function UsageList({ usage, projectId }: { readonly usage: readonly ProfileUse[]; readonly projectId: string | undefined }) {
  return (
    <ul className="small" style={{ margin: 0, paddingLeft: 16 }} aria-label="Workflows using this profile">
      {usage.map((u) => {
        const label = `${u.name} (${u.version === 'draft' ? 'draft' : `v${String(u.version)}`})`;
        return (
          <li key={`${u.workflowId}:${String(u.version)}`}>
            {projectId === undefined ? label : <Link to={paths.workflow(projectId, u.workflowId)}>{label}</Link>}
          </li>
        );
      })}
    </ul>
  );
}

function WarningList({ warnings }: { readonly warnings: readonly CapabilityWarning[] }) {
  if (warnings.length === 0) return <span className="badge success">OK</span>;
  return (
    <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
      {warnings.map((w, i) => (
        <li key={`${w.code}:${String(i)}`}>
          {w.message} <code>{w.code}</code>
        </li>
      ))}
    </ul>
  );
}

const FIELD = {
  name: 'profile-field-name',
  model: 'profile-field-model',
  tokens: 'profile-field-max-output',
} as const;

/**
 * Settings → Model profiles (10 J10): the profiles with the engine's capability warnings (never re-checked here),
 * create/edit through `profiles.upsert` (with the expected revision), and delete through `profiles.delete`.
 */
export function ProfilesSection() {
  const titleId = useId();
  const queryClient = useQueryClient();
  const profiles = useProfiles();
  const catalog = useCatalog();
  const retry = useRetryAction(() => {
    void profiles.refetch();
    void catalog.refetch();
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState<ProfileWithWarnings | null>(null);
  const [deleting, setDeleting] = useState<ModelProfile | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const workflows = useWorkflows();
  const { project: settingsProject } = useSettingsProject();
  const conflictNames = { workflowName: (id: string) => workflows.data?.find((w) => w.id === id)?.name };
  const renaming = draft !== null && draft.base !== null && draft.name.trim() !== draft.base.name;
  // Pre-warnings (the engine decides): workflows that name the profile being renamed or deleted.
  const usage = useProfileUsage(renaming ? draft.base.name : (deleting?.name ?? null));

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.profiles() });
  };
  /**
   * Reload of a stale CONFLICT: refetch the profiles and re-base the open edit on the saved revision. The user's edits
   * stay in the form; only the expected revision (and the params the form does not edit) come from the saved profile.
   */
  const reloadDraft = () => {
    void profiles.refetch().then((res) => {
      const fresh = res.data?.find((row) => row.profile.id === draft?.id)?.profile;
      if (fresh === undefined) return;
      setDraft((d) => (d === null || d.id !== fresh.id ? d : { ...d, expectedRevision: fresh.revision, base: fresh }));
      upsert.reset();
    });
  };
  const upsert = useMutation({
    mutationFn: (d: Draft) =>
      call('relay/v1/profiles.upsert', {
        profile: {
          ...(d.id === null ? {} : { id: d.id }),
          name: d.name.trim(),
          providerId: d.providerId,
          modelId: d.modelId,
          params: {
            ...paramsWithoutEffort(d.base),
            maxOutputTokens: Number.parseInt(d.maxOutputTokens, 10),
            ...(d.effort === '' ? {} : { effort: d.effort }),
          },
        },
        ...(d.expectedRevision === null ? {} : { expectedRevision: d.expectedRevision }),
      }),
    onSuccess: (res) => {
      refresh();
      setSaved(res);
      setDraft(null);
      setSubmitted(false);
    },
  });
  const remove = useMutation({
    mutationFn: (id: ModelProfile['id']) => call('relay/v1/profiles.delete', { profileId: id }),
    onSuccess: () => {
      refresh();
      setDeleting(null);
    },
  });

  const models = catalog.data ?? [];
  const providers = [...new Set(models.map((m) => m.providerId))];
  const providerModels = draft === null ? [] : models.filter((m) => m.providerId === draft.providerId);
  const model = draft === null ? undefined : models.find((m) => m.providerId === draft.providerId && m.modelId === draft.modelId);
  const local: Record<string, string> = {};
  if (draft !== null) {
    if (draft.name.trim() === '') local[FIELD.name] = 'Enter a profile name, for example Balanced.';
    else if (draft.name.trim().length > 40) local[FIELD.name] = 'Use at most 40 characters.';
    if (draft.modelId === '') local[FIELD.model] = 'Choose a model.';
    const tokens = /^\d+$/.test(draft.maxOutputTokens.trim()) ? Number.parseInt(draft.maxOutputTokens, 10) : NaN;
    const ceiling = model?.capabilities.maxOutputTokens ?? MAX_OUTPUT_TOKENS_CEILING;
    if (Number.isNaN(tokens) || tokens < 1) local[FIELD.tokens] = 'Enter a whole number of tokens.';
    else if (tokens > ceiling) local[FIELD.tokens] = `This model supports at most ${ceiling.toLocaleString()} output tokens.`;
  }
  const serverIssues = validationIssuesOf(upsert.error);
  const errorOf = (id: string) => (submitted ? local[id] : undefined);

  const body =
    profiles.error !== null ? (
      <ErrorView error={toViewError(profiles.error)} onAction={retry} />
    ) : profiles.data === undefined ? (
      <div aria-busy="true">
        <Skeleton lines={4} />
      </div>
    ) : (
      <div className="table-wrap" style={{ overflowX: 'auto' }}>
        <table className="table">
          <caption className="sr-only">Model profiles</caption>
          <thead>
            <tr>
              <th scope="col">Profile</th>
              <th scope="col">Provider</th>
              <th scope="col">Model</th>
              <th scope="col" className="num">
                Default max output
              </th>
              <th scope="col">Capability check</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {profiles.data.map(({ profile, warnings }) => (
              <tr key={profile.id}>
                <th scope="row">{profile.name}</th>
                <td>{PROVIDER_LABELS[profile.providerId]}</td>
                <td className="mono">{profile.modelId}</td>
                <td className="num">{profile.params.maxOutputTokens.toLocaleString()}</td>
                <td>
                  <WarningList warnings={warnings} />
                </td>
                <td>
                  <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    <Button
                      size="sm"
                      icon={Pencil}
                      aria-label={`Edit ${profile.name}`}
                      onClick={() => {
                        upsert.reset();
                        setSaved(null);
                        setSubmitted(false);
                        setDraft(draftOf(profile));
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Trash2}
                      aria-label={`Delete ${profile.name}`}
                      onClick={() => {
                        remove.reset();
                        setDeleting(profile);
                      }}
                    >
                      Delete
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <section className="card stack" aria-labelledby={titleId}>
      <div className="card-header">
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>
          Model profiles
        </h2>
        <Button
          icon={Plus}
          disabled={catalog.data === undefined}
          onClick={() => {
            upsert.reset();
            setSaved(null);
            setSubmitted(false);
            setDraft(newDraft(models));
          }}
        >
          Add profile
        </Button>
      </div>
      <p className="small muted">
        Workflows assign profiles to roles. Each run snapshots the profile, so edits here affect only future runs.
        Capability checks come from Relay&apos;s catalog and your credentials, and are re-checked before every run.
      </p>
      {saved === null ? null : (
        <InlineAlert tone={saved.warnings.length === 0 ? 'success' : 'warning'} title={`Saved “${saved.profile.name}” (revision ${String(saved.profile.revision)})`}>
          {saved.warnings.length === 0 ? <p>No capability warnings.</p> : <WarningList warnings={saved.warnings} />}
        </InlineAlert>
      )}
      {body}
      {draft === null ? null : (
        <form
          className="card stack"
          aria-label={draft.id === null ? 'New profile' : `Edit ${draft.base?.name ?? 'profile'}`}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
            if (Object.keys(local).length > 0) return;
            upsert.mutate(draft);
          }}
        >
          <h3>{draft.id === null ? 'New profile' : `Edit ${draft.base?.name ?? 'profile'}`}</h3>
          <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
            <Field label="Name" id={FIELD.name} error={errorOf(FIELD.name)} required>
              {(control) => (
                <TextInput
                  {...control}
                  value={draft.name}
                  onValueChange={(name) => {
                    setDraft({ ...draft, name });
                  }}
                />
              )}
            </Field>
            <Field label="Provider">
              {(control) => (
                <Select
                  {...control}
                  value={draft.providerId}
                  options={providers.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))}
                  onValueChange={(v) => {
                    const providerId = v as ProviderId;
                    setDraft({ ...draft, providerId, modelId: models.find((m) => m.providerId === providerId)?.modelId ?? '', effort: '' });
                  }}
                />
              )}
            </Field>
            <Field label="Model" id={FIELD.model} error={errorOf(FIELD.model)} required>
              {(control) => (
                <Select
                  {...control}
                  value={draft.modelId}
                  options={[
                    ...(providerModels.some((m) => m.modelId === draft.modelId) || draft.modelId === ''
                      ? []
                      : [{ value: draft.modelId, label: `${draft.modelId} (not in the catalog)` }]),
                    ...providerModels.map((m) => ({ value: m.modelId, label: `${m.displayName} (${m.modelId})` })),
                  ]}
                  onValueChange={(modelId) => {
                    setDraft({ ...draft, modelId, effort: '' });
                  }}
                />
              )}
            </Field>
            <Field
              label="Default max output tokens"
              id={FIELD.tokens}
              hint={model?.capabilities.maxOutputTokens === undefined ? undefined : `This model supports up to ${model.capabilities.maxOutputTokens.toLocaleString()}.`}
              error={errorOf(FIELD.tokens)}
              required
            >
              {(control) => (
                <NumberInput
                  {...control}
                  value={draft.maxOutputTokens}
                  min={1}
                  max={model?.capabilities.maxOutputTokens ?? MAX_OUTPUT_TOKENS_CEILING}
                  onValueChange={(text) => {
                    setDraft({ ...draft, maxOutputTokens: text });
                  }}
                />
              )}
            </Field>
            <Field label="Reasoning effort" hint="Only levels the model supports are listed.">
              {(control) => (
                <Select
                  {...control}
                  value={draft.effort}
                  options={[
                    { value: '', label: 'Provider default' },
                    ...EFFORT_LEVELS.filter((l) => model?.capabilities.effortLevels.includes(l) ?? false).map((l) => ({ value: l, label: l })),
                  ]}
                  onValueChange={(v) => {
                    setDraft({ ...draft, effort: v as Effort | '' });
                  }}
                />
              )}
            </Field>
          </div>
          {serverIssues.length > 0 ? (
            <InlineAlert tone="danger" title="Relay could not save this profile">
              <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
                {serverIssues.map((i) => (
                  <li key={`${i.path}:${i.message}`}>{i.message}</li>
                ))}
              </ul>
            </InlineAlert>
          ) : (
            <MutationError
              error={upsert.error}
              handlers={{ reload: reloadDraft }}
              names={conflictNames}
              projectId={settingsProject?.id}
            />
          )}
          {renaming && usage !== null && usage.length > 0 && conflictReason(upsert.error) !== 'profile_in_use' ? (
            <InlineAlert tone="warning" title={`Relay will refuse to rename “${draft.base.name}” while workflows use it`}>
              <p>These workflows name the profile; choose another profile in their steps first, or keep the name:</p>
              <UsageList usage={usage} projectId={settingsProject?.id} />
            </InlineAlert>
          ) : null}
          <div className="actions">
            <Button type="submit" variant="primary" pending={upsert.isPending}>
              {draft.id === null ? 'Create profile' : `Save revision ${String((draft.expectedRevision ?? 0) + 1)}`}
            </Button>
            <Button
              disabled={upsert.isPending}
              onClick={() => {
                setDraft(null);
                upsert.reset();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {deleting === null ? null : (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          title={`Delete the “${deleting.name}” profile?`}
          returnFocusFallback={headingRef}
          consequences={
            <div className="stack">
              <p>
                Future runs can no longer choose it. Past runs keep the profile snapshot they used. Relay refuses to
                delete a profile that a workflow draft or validated version still names: choose another profile in
                those workflows first.
              </p>
              {usage !== null && usage.length > 0 ? (
                <InlineAlert tone="warning" title={`Used by ${String(new Set(usage.map((u) => u.workflowId)).size)} workflow${new Set(usage.map((u) => u.workflowId)).size === 1 ? '' : 's'}: deleting will be refused`}>
                  <UsageList usage={usage} projectId={settingsProject?.id} />
                </InlineAlert>
              ) : null}
              <MutationError error={remove.error} names={conflictNames} projectId={settingsProject?.id} />
            </div>
          }
          confirmLabel="Delete profile"
          cancelLabel="Cancel"
          pending={remove.isPending}
          onConfirm={() => {
            remove.mutate(deleting.id);
          }}
        />
      )}
    </section>
  );
}
