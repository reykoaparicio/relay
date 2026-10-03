// E2 #8: a selected file exists but cannot be read (PERMISSION_DENIED `unreadable`). Shown next to that problem in
// New run: leave the file out of this run (immediate), or add it to the project's exclusions so future runs skip it
// too (`projects.update`, behind a confirm).
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Project } from '@relay/contracts';
import { Button, ConfirmDialog, InlineAlert } from '../../components/ui';
import { call } from '../../api/client';
import { appErrorOf } from '../../api/errors';
import { qk } from '../../api/keys';
import { MutationError } from '../common/MutationError';

/** Most patterns a project keeps (contracts `exclusionsSchema`, `.max(100)`). */
const MAX_EXCLUSIONS = 100;

/**
 * A project exclusion is a glob (picomatch, tools `compileUserPatterns`). Escapes the glob syntax in a literal path so
 * the pattern matches exactly that one file: `src/a[b].ts` must not also exclude `src/ab.ts`.
 */
export function literalExclusionPattern(relPath: string): string {
  return relPath.replace(/[\\*?[\]{}()!+@]/g, '\\$&');
}

export interface UnreadableFileActionsProps {
  readonly project: Project;
  readonly relPath: string;
  /** Untick the file in this run's selection. */
  readonly onDeselect: () => void;
}

export function UnreadableFileActions({ project, relPath, onDeselect }: UnreadableFileActionsProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const pattern = literalExclusionPattern(relPath);
  const already = project.exclusions.includes(pattern);
  const full = !already && project.exclusions.length >= MAX_EXCLUSIONS;
  const update = useMutation({
    // The latest loaded project is the base: after a CONFLICT the refetched one is used by the next confirm.
    mutationFn: () =>
      call('relay/v1/projects.update', {
        projectId: project.id,
        expectedUpdatedAt: project.updatedAt,
        patch: { exclusions: already ? [...project.exclusions] : [...project.exclusions, pattern] },
      }),
    onSuccess: () => {
      setOpen(false);
      onDeselect();
      void queryClient.invalidateQueries({ queryKey: qk.project(project.id) });
      void queryClient.invalidateQueries({ queryKey: qk.projects() });
      void queryClient.invalidateQueries({ queryKey: ['preview', project.id] });
    },
    onError: (e) => {
      // Changed elsewhere meanwhile: load the saved project, so confirming again adds to its current exclusions.
      if (appErrorOf(e)?.code === 'CONFLICT') void queryClient.invalidateQueries({ queryKey: qk.project(project.id) });
    },
  });
  const conflict = appErrorOf(update.error)?.code === 'CONFLICT';
  return (
    <span className="row" style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', verticalAlign: 'middle' }}>
      <Button size="sm" onClick={onDeselect}>
        Exclude this file
      </Button>
      {full ? (
        <span className="small">The project already has {String(MAX_EXCLUSIONS)} exclusion patterns; edit them in Settings.</span>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            update.reset();
            setOpen(true);
          }}
        >
          Exclude from project…
        </Button>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (!update.isPending) setOpen(next);
        }}
        title="Exclude this file from the project?"
        consequences={`${relPath} is added to ${project.name}'s exclusions and is skipped in this and future runs. You can remove the pattern in Settings → Projects.`}
        confirmLabel="Exclude from project"
        pending={update.isPending}
        onConfirm={() => {
          update.mutate();
        }}
      >
        {conflict ? (
          <InlineAlert tone="warning" title="The project settings changed meanwhile">
            <p>Nothing was saved. Relay loaded the current settings; confirm again to add the exclusion to them.</p>
          </InlineAlert>
        ) : (
          <MutationError error={update.error} projectId={project.id} />
        )}
      </ConfirmDialog>
    </span>
  );
}
