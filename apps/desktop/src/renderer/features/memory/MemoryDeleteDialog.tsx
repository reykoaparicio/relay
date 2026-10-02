import { useState } from 'react';
import { Link } from 'react-router';
import { ConfirmDialog, useToast } from '../../components/ui';
import type { RefObject } from 'react';
import { MutationError } from '../common/MutationError';
import { paths } from '../shell/paths';
import type { useMemoryMutations } from './useMemoryMutations';

/** The record a delete confirmation is about. */
export interface DeleteTarget {
  readonly id: string;
  readonly title: string;
  readonly usedByRuns: number;
  /** Approved records offer "Archive instead". */
  readonly approved: boolean;
}

export interface MemoryDeleteDialogProps {
  readonly target: DeleteTarget;
  readonly projectId: string;
  readonly mutations: ReturnType<typeof useMemoryMutations>;
  /** The last detail command: an "Archive instead" failure is shown here only when archive was the last one. */
  readonly archiveWasLast: boolean;
  readonly returnFocusFallback: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  /** "Archive instead" started (the page records it as the last detail command). */
  readonly onArchiveStart: () => void;
  /** The record was deleted (the page clears the selection). */
  readonly onDeleted: () => void;
}

/** Memory `delete-confirm` (§5.5): what deleting changes for future and past runs, with "Archive instead". */
export function MemoryDeleteDialog({
  target,
  projectId,
  mutations,
  archiveWasLast,
  returnFocusFallback,
  onClose,
  onArchiveStart,
  onDeleted,
}: MemoryDeleteDialogProps) {
  const toast = useToast();
  /** The command last started from this dialog: its error is the one shown (a later archive failure replaces a delete one). */
  const [last, setLast] = useState<'remove' | 'archive' | null>(null);
  const error =
    last === 'remove'
      ? mutations.remove.error
      : last === 'archive'
        ? archiveWasLast
          ? mutations.archive.error
          : null
        : (mutations.remove.error ?? (archiveWasLast ? mutations.archive.error : null));
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          mutations.remove.reset();
        }
      }}
      title={`Delete “${target.title}”?`}
      returnFocusFallback={returnFocusFallback}
      consequences={
        <div className="stack">
          <ul className="stack" style={{ margin: 0, paddingLeft: 16, gap: 4 }}>
            <li>
              <strong>Future runs:</strong> the record is removed from retrieval immediately. No new run will
              include it.
            </li>
            <li>
              <strong>Past runs:</strong>{' '}
              {target.usedByRuns === 0
                ? 'no run has used it yet.'
                : `snapshots of ${String(target.usedByRuns)} run${target.usedByRuns === 1 ? '' : 's'} keep their copies, so those runs stay reproducible.`}
            </li>
            <li>Its revision history is removed from the Memory page.</li>
          </ul>
          <p className="subtle">
            To keep the record but stop using it, archive it instead. To also remove copies inside run snapshots, use{' '}
            <Link to={paths.settings('data', { project: projectId })}>Purge project history</Link> in Settings → Storage &amp; data (affects
            run reports).
          </p>
        </div>
      }
      {...(target.approved
        ? {
            secondaryAction: {
              label: 'Archive instead',
              pending: mutations.archive.isPending,
              onClick: () => {
                setLast('archive');
                onArchiveStart();
                mutations.archive.mutate(
                  { recordId: target.id },
                  {
                    onSuccess: () => {
                      onClose();
                      toast.show({ key: `memory:archived:${target.id}`, title: `Archived “${target.title}”`, tone: 'success' });
                    },
                  },
                );
              },
            },
          }
        : {})}
      confirmLabel="Delete record from future runs"
      cancelLabel="Cancel"
      pending={mutations.remove.isPending}
      onConfirm={() => {
        setLast('remove');
        mutations.remove.mutate(
          { recordId: target.id, confirm: true },
          {
            onSuccess: (res) => {
              onClose();
              onDeleted();
              toast.show({
                key: `memory:deleted:${target.id}`,
                title: `Deleted “${target.title}”`,
                body:
                  res.retainedInRunSnapshots === 0
                    ? 'No run snapshot used it.'
                    : `${String(res.retainedInRunSnapshots)} run snapshot${res.retainedInRunSnapshots === 1 ? '' : 's'} keep their copies.`,
                tone: 'success',
              });
            },
          },
        );
      }}
    >
      <MutationError error={error} />
    </ConfirmDialog>
  );
}
