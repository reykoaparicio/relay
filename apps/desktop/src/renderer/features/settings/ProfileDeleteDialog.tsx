import type { RefObject } from 'react';
import type { ModelProfile } from '@relay/contracts';
import { ConfirmDialog, InlineAlert } from '../../components/ui';
import type { ProfileUse } from '../../hooks/useWorkflow';
import { MutationError } from '../common/MutationError';
import type { ConflictNames } from '../common/conflict';
import { UsageList } from './ProfileLists';

export interface ProfileDeleteDialogProps {
  readonly profile: ModelProfile;
  /** Workflows that still name the profile (a pre-warning: the engine refuses the delete). */
  readonly usage: readonly ProfileUse[] | null;
  readonly pending: boolean;
  readonly error: unknown;
  readonly conflictNames: ConflictNames;
  readonly projectId: string | undefined;
  readonly returnFocusFallback: RefObject<HTMLElement | null>;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

/** Delete confirmation of a model profile, with the workflows that would block it. */
export function ProfileDeleteDialog({
  profile,
  usage,
  pending,
  error,
  conflictNames,
  projectId,
  returnFocusFallback,
  onConfirm,
  onClose,
}: ProfileDeleteDialogProps) {
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Delete the “${profile.name}” profile?`}
      returnFocusFallback={returnFocusFallback}
      consequences={
        <p>
          Future runs can no longer choose it. Past runs keep the profile snapshot they used. Relay refuses to
          delete a profile that a workflow draft or validated version still names: choose another profile in
          those workflows first.
        </p>
      }
      confirmLabel="Delete profile"
      cancelLabel="Cancel"
      pending={pending}
      onConfirm={onConfirm}
    >
      {usage !== null && usage.length > 0 ? (
        <InlineAlert tone="warning" title={`Used by ${String(new Set(usage.map((u) => u.workflowId)).size)} workflow${new Set(usage.map((u) => u.workflowId)).size === 1 ? '' : 's'}: deleting will be refused`}>
          <UsageList usage={usage} projectId={projectId} />
        </InlineAlert>
      ) : null}
      <MutationError error={error} names={conflictNames} projectId={projectId} />
    </ConfirmDialog>
  );
}
