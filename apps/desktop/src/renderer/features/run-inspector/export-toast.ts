// The run inspector's export result toast (E2 #10): `artifacts.export` may save some parts and fail others.
import type { OutputOf } from '@relay/contracts';

type ExportResult = OutputOf<'relay/v1/artifacts.export'>;

const EXPORT_PART_LABELS: Readonly<Record<NonNullable<ExportResult['failed']>[number]['what'], string>> = {
  report: 'Report',
  patch: 'Patch',
};

/**
 * The toast of an export result (E2 #10): saved parts as a success; any failed part as a warning naming the part and
 * why (a partial success is a warning, never an error); null when the user cancelled the save dialog.
 */
export function exportToast(
  res: ExportResult,
): { readonly title: string; readonly body: string; readonly tone: 'success' | 'warning' } | null {
  const failed = res.failed ?? [];
  const saved = res.written === undefined ? res.displayPaths : res.written.map((w) => w.displayPath);
  if (failed.length === 0)
    return res.exported ? { title: 'Export saved', body: saved.join(', '), tone: 'success' } : null;
  const reasons = failed.map(
    (f) =>
      `${EXPORT_PART_LABELS[f.what]} not saved: ${f.userMessage ?? `the file could not be written (error code ${f.code})`}`,
  );
  return {
    title: saved.length > 0 ? 'Export partly saved' : 'Export not saved',
    body: [...(saved.length > 0 ? [`Saved: ${saved.join(', ')}.`] : []), ...reasons].join(' '),
    tone: 'warning',
  };
}
