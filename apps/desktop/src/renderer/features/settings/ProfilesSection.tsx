import { useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { ModelProfile, ProfileWithWarnings } from '@relay/contracts';
import { Button, ErrorView, InlineAlert, Skeleton } from '../../components/ui';
import { call } from '../../api/client';
import { toViewError } from '../../api/errors';
import { qk } from '../../api/keys';
import { useCatalog } from '../../hooks/useCatalog';
import { useProfiles } from '../../hooks/useProfiles';
import { useProfileUsage, useWorkflows } from '../../hooks/useWorkflow';
import { useRetryAction } from '../common/useNextAction';
import { ProfileDeleteDialog } from './ProfileDeleteDialog';
import { draftOf, newDraft, paramsWithoutEffort, profileDraftErrors } from './ProfileEditor';
import type { Draft } from './ProfileEditor';
import { ProfileEditor } from './ProfileEditor';
import { WarningList } from './ProfileLists';
import { ProfilesTable } from './ProfilesTable';
import { useSettingsProject } from './useSettingsProject';

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
  const model = draft === null ? undefined : models.find((m) => m.providerId === draft.providerId && m.modelId === draft.modelId);
  const local = draft === null ? {} : profileDraftErrors(draft, model);

  const body =
    profiles.error !== null ? (
      <ErrorView error={toViewError(profiles.error)} onAction={retry} />
    ) : profiles.data === undefined ? (
      <div aria-busy="true">
        <Skeleton lines={4} />
      </div>
    ) : (
      <ProfilesTable
        rows={profiles.data}
        onEdit={(profile) => {
          upsert.reset();
          setSaved(null);
          setSubmitted(false);
          setDraft(draftOf(profile));
        }}
        onDelete={(profile) => {
          remove.reset();
          setDeleting(profile);
        }}
      />
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
        <InlineAlert tone={saved.warnings.length === 0 ? 'success' : 'warning'} live="polite" title={`Saved “${saved.profile.name}” (revision ${String(saved.profile.revision)})`}>
          {saved.warnings.length === 0 ? <p>No capability warnings.</p> : <WarningList warnings={saved.warnings} providerId={saved.profile.providerId} />}
        </InlineAlert>
      )}
      {body}
      {draft === null ? null : (
        <ProfileEditor
          draft={draft}
          onChange={setDraft}
          models={models}
          errors={local}
          submitted={submitted}
          pending={upsert.isPending}
          error={upsert.error}
          renamedFrom={renaming ? draft.base.name : null}
          renameUsage={usage}
          conflictNames={conflictNames}
          projectId={settingsProject?.id}
          onSubmit={() => {
            setSubmitted(true);
            if (Object.keys(local).length > 0) return;
            upsert.mutate(draft);
          }}
          onCancel={() => {
            setDraft(null);
            upsert.reset();
          }}
          onReload={reloadDraft}
        />
      )}
      {deleting === null ? null : (
        <ProfileDeleteDialog
          profile={deleting}
          usage={usage}
          pending={remove.isPending}
          error={remove.error}
          conflictNames={conflictNames}
          projectId={settingsProject?.id}
          returnFocusFallback={headingRef}
          onConfirm={() => {
            remove.mutate(deleting.id);
          }}
          onClose={() => {
            setDeleting(null);
          }}
        />
      )}
    </section>
  );
}
