// The run export dialog's state (E2 #10), shared by the report page and the run inspector: which part the dialog opened
// on, the per-part "Written" / "Failed" rows of a partial export, and the success toast.
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ExportWhat } from '@relay/contracts';
import { useToast } from '../../components/ui';
import { useArtifactExport } from '../run-inspector/useRunExports';
import { anyExportFailed, exportPartResults } from './export-results';
import type { ExportPartResult } from './export-results';
import { ExportDialog } from './ReportSections';

export interface ExportDialogControl {
  readonly open: (what: ExportWhat) => void;
  /** The dialog element (null while closed). */
  readonly dialog: ReactNode;
}

export interface UseExportDialogOptions {
  readonly runId: string;
  readonly hasPatch: boolean;
  /**
   * Shown in the dialog while the run is still in progress (an interim export): "The run is still in progress; the
   * export includes results finished so far (N of M steps)".
   */
  readonly progressNote?: string | undefined;
  /** The success toast title (default "Export saved"). */
  readonly savedTitle?: string;
}

/** "The run is still in progress; the export includes results finished so far (2 of 6 steps)". */
export function interimExportNote(progress: { readonly done: number; readonly total: number }): string {
  return `The run is still in progress; the export includes results finished so far (${String(progress.done)} of ${String(progress.total)} steps).`;
}

/**
 * Export dialog state: a partial export keeps the dialog open with per-part rows (a warning, not an error toast);
 * "Retry" re-exports only the failed parts and merges into the rows. Older mains (no `written` / `failed`) fall back
 * to `displayPaths`.
 */
export function useExportDialog({ runId, hasPatch, progressNote, savedTitle = 'Export saved' }: UseExportDialogOptions): ExportDialogControl {
  const toast = useToast();
  const exporter = useArtifactExport(runId);
  const [openOn, setOpenOn] = useState<ExportWhat | null>(null);
  const [parts, setParts] = useState<readonly ExportPartResult[] | null>(null);

  const close = () => {
    setOpenOn(null);
    setParts(null);
  };
  const doExport = (what: ExportWhat) => {
    exporter.mutate(what, {
      onSuccess: (res) => {
        if (!res.exported) {
          close();
          return;
        }
        const rows = exportPartResults(res, parts ?? []);
        // Any failed part keeps the dialog open: a retryable one offers "Retry", a permanent one is final.
        if (rows !== null && anyExportFailed(rows)) {
          setParts(rows);
          return;
        }
        const savedPaths = rows === null ? res.displayPaths : rows.flatMap((r) => (r.state === 'written' ? [r.displayPath] : []));
        close();
        toast.show({ key: `export:${runId}:${what}`, title: savedTitle, body: savedPaths.join(', '), tone: 'success' });
      },
    });
  };

  return {
    open: (what) => {
      exporter.reset();
      setParts(null);
      setOpenOn(what);
    },
    dialog:
      openOn === null ? null : (
        <ExportDialog
          open
          onOpenChange={(o) => {
            if (!o) close();
          }}
          hasPatch={hasPatch}
          initial={openOn}
          pending={exporter.isPending}
          error={exporter.error}
          parts={parts}
          onExport={doExport}
          {...(progressNote === undefined ? {} : { progressNote })}
        />
      ),
  };
}
