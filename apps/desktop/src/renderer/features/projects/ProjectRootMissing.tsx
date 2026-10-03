// E2 #7: the project's folder was moved, renamed, or deleted (PROJECT_ROOT_MISSING). Shown on Overview, New run and
// Settings → Projects: "Locate folder…" re-points the project (`projects.pickDirectory` → `projects.relocate`), with a
// confirmation when Relay cannot verify the new folder (CONFLICT `root_unverified` + `details.verification`), and
// "Remove project" archives it.
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, FolderSearch } from 'lucide-react';
import { useNavigate } from 'react-router';
import { rootVerificationSchema } from '@relay/contracts';
import type { AppSettings, Project, RootVerification } from '@relay/contracts';
import { Button, ConfirmDialog, InlineAlert, useToast } from '../../components/ui';
import { call } from '../../api/client';
import { appErrorOf, errorReason } from '../../api/errors';
import { qk } from '../../api/keys';
import { MutationError } from '../common/MutationError';
import { paths } from '../shell/paths';

/** What the panel needs of the project. */
export type MissingRootProject = Pick<Project, 'id' | 'name' | 'rootDisplayPath'>;

export interface ProjectRootMissingProps {
  readonly project: MissingRootProject;
  /** Called after a successful relocate, e.g. so a page clears the error that showed this panel. */
  readonly onRelocated?: () => void;
}

/** The verification of a CONFLICT `root_unverified`, else null. */
export function unverifiedRootOf(e: unknown): RootVerification | null {
  const error = appErrorOf(e);
  if (error?.code !== 'CONFLICT' || errorReason(error) !== 'root_unverified') return null;
  const parsed = rootVerificationSchema.safeParse(error.details?.['verification']);
  return parsed.success ? parsed.data : { checkedFiles: 0, matchedFiles: 0, mismatched: [] };
}

/**
 * "Relay compared 9 files it used before: none match." The engine asks for a confirmation unless a clear majority
 * matches (round-3 M3), so a partial match reads "only 2 match".
 */
export function verificationText(v: RootVerification): string {
  if (v.checkedFiles === 0) return 'Relay has no earlier files of this project to compare with this folder.';
  const matched = v.matchedFiles === 0 ? 'none match' : `only ${String(v.matchedFiles)} match`;
  return `Relay compared ${String(v.checkedFiles)} file${v.checkedFiles === 1 ? '' : 's'} it used before with this folder: ${matched}.`;
}

interface Pending {
  readonly selectionId: string;
  readonly displayPath: string;
  readonly verification: RootVerification;
}

/** Invalidates everything that depends on the project's folder. */
function useRefreshProject(projectId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: qk.projects() });
    void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
    void queryClient.invalidateQueries({ queryKey: ['preview', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['preflight'] });
  };
}

/** "Project folder not found" with "Locate folder…" and "Remove project". */
export function ProjectRootMissing({ project, onRelocated }: ProjectRootMissingProps) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const refresh = useRefreshProject(project.id);
  const headingRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  const relocate = useMutation({
    mutationFn: async (input: { readonly selectionId: string; readonly displayPath: string; readonly confirm: boolean }) =>
      call('relay/v1/projects.relocate', {
        projectId: project.id,
        selectionId: input.selectionId,
        ...(input.confirm ? { confirm: true as const } : {}),
      }),
    onSuccess: (res) => {
      setPending(null);
      refresh();
      onRelocated?.();
      const v = res.verification;
      toast.show({
        key: `project:relocated:${project.id}`,
        title: `Project folder updated: ${res.project.rootDisplayPath}`,
        body: v.checkedFiles === 0 ? 'Relay had no earlier files to compare.' : `${String(v.matchedFiles)} of ${String(v.checkedFiles)} earlier files match.`,
        tone: 'success',
      });
    },
    onError: (e, input) => {
      const verification = unverifiedRootOf(e);
      if (verification !== null) setPending({ selectionId: input.selectionId, displayPath: input.displayPath, verification });
    },
  });
  const pick = useMutation({
    mutationFn: () => call('relay/v1/projects.pickDirectory', {}),
    onSuccess: (res) => {
      // null = the user cancelled the folder dialog.
      if (res.selection === null) return;
      relocate.mutate({ selectionId: res.selection.selectionId, displayPath: res.selection.displayPath, confirm: false });
    },
  });
  const archive = useMutation({
    mutationFn: () => call('relay/v1/projects.archive', { projectId: project.id }),
    onSuccess: async (p) => {
      setRemoveOpen(false);
      toast.show({ key: `project:archived:${p.id}`, title: `Removed “${p.name}” from Relay`, body: 'It is archived: its runs and memory stay on this computer, and you can restore it in Settings → Projects.', tone: 'success' });
      const settings = queryClient.getQueryData<AppSettings>(qk.settings());
      const next = (queryClient.getQueryData<readonly Project[]>(qk.projects()) ?? []).find((x) => x.id !== p.id && x.archivedAt === null);
      if (settings?.activeProjectId === p.id) {
        try {
          await call('relay/v1/app.updateSettings', { activeProjectId: next?.id ?? null });
        } finally {
          void queryClient.invalidateQueries({ queryKey: qk.settings() });
        }
      }
      refresh();
      void navigate(next === undefined ? paths.onboarding('select-project') : paths.overview(next.id));
    },
  });

  const busy = pick.isPending || relocate.isPending;
  // A root_unverified conflict is answered by the confirm dialog, not shown as an error.
  const relocateError = unverifiedRootOf(relocate.error) === null ? relocate.error : null;

  return (
    <InlineAlert
      tone="warning"
      title="Project folder not found"
      actions={
        <>
          <Button
            variant="primary"
            icon={FolderSearch}
            pending={busy}
            onClick={() => {
              relocate.reset();
              pick.mutate();
            }}
          >
            Locate folder…
          </Button>
          <Button
            variant="ghost"
            icon={Archive}
            disabled={busy}
            onClick={() => {
              archive.reset();
              setRemoveOpen(true);
            }}
          >
            Remove project
          </Button>
        </>
      }
    >
      <div ref={headingRef} tabIndex={-1}>
        <p>
          Relay cannot find the folder of <b>{project.name}</b> at <span className="mono">{project.rootDisplayPath}</span>. It may
          have been moved, renamed, or deleted. Locate it to continue; runs, reports and memory are kept.
        </p>
      </div>
      <MutationError error={pick.error ?? (pending === null ? relocateError : null)} projectId={project.id} />
      {pending === null ? null : (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setPending(null);
              relocate.reset();
            }
          }}
          title="Use this folder anyway?"
          returnFocusFallback={headingRef}
          consequences={
            <div className="stack">
              <p>
                {verificationText(pending.verification)} Relay cannot confirm that <span className="mono">{pending.displayPath}</span>{' '}
                is the folder of <b>{project.name}</b>.
              </p>
              <p>Use it only if it is the same project (for example, a folder you moved or renamed). Project files are never changed.</p>
            </div>
          }
          confirmLabel="Use this folder"
          cancelLabel="Cancel"
          destructive={false}
          pending={relocate.isPending}
          onConfirm={() => {
            relocate.mutate({ selectionId: pending.selectionId, displayPath: pending.displayPath, confirm: true });
          }}
        >
          {pending.verification.mismatched.length === 0 ? null : (
            <div className="stack" style={{ gap: 4 }}>
              <span className="section-label">Files that differ or are missing</span>
              <ul className="small mono" style={{ margin: 0, paddingLeft: 16 }} aria-label="Files that differ or are missing">
                {pending.verification.mismatched.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          <MutationError error={unverifiedRootOf(relocate.error) === null ? relocate.error : null} projectId={project.id} />
        </ConfirmDialog>
      )}
      {removeOpen ? (
        <ConfirmDialog
          open
          onOpenChange={setRemoveOpen}
          title={`Remove “${project.name}”?`}
          returnFocusFallback={headingRef}
          consequences="The project is archived: it leaves the project switcher and cannot start runs. Its runs, reports, memory and usage ledger stay on this computer, and you can restore it in Settings → Projects."
          confirmLabel="Remove project"
          cancelLabel="Cancel"
          pending={archive.isPending}
          onConfirm={() => {
            archive.mutate();
          }}
        >
          <MutationError error={archive.error} projectId={project.id} />
        </ConfirmDialog>
      ) : null}
    </InlineAlert>
  );
}
