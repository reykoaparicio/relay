import type { ErrorCode, ExportFailure, ExportPart, ExportWhat } from '@relay/contracts';

/** One exported part as the dialog shows it (E2 #10): written (with its path) or failed (with a plain reason). */
export type ExportPartResult =
  | { readonly what: ExportPart; readonly state: 'written'; readonly displayPath: string }
  | { readonly what: ExportPart; readonly state: 'failed'; readonly code: ErrorCode; readonly reason: string };

/** The `artifacts.export` output fields the dialog reads (older mains omit `written` / `failed`). */
export interface ExportOutput {
  readonly exported: boolean;
  readonly displayPaths: readonly string[];
  readonly written?: ReadonlyArray<{ readonly what: ExportPart; readonly displayPath: string }> | undefined;
  readonly failed?: readonly ExportFailure[] | undefined;
}

const PART_ORDER: readonly ExportPart[] = ['report', 'patch'];

/** File label per part, for "Written" / "Failed" rows. */
export const EXPORT_PART_LABELS: Readonly<Record<ExportPart, string>> = {
  report: 'Report (Markdown)',
  patch: 'Patch (.patch)',
};

const REASON_BY_CODE: Partial<Readonly<Record<ErrorCode, string>>> = {
  ARTIFACT_WRITE_FAILED: 'Relay could not write the file. The folder may be read-only or full.',
  PERMISSION_DENIED: 'Relay is not allowed to write to that folder.',
  NOT_FOUND: 'This file is no longer stored for the run.',
};

/** Plain reason for a failed part: the main's `userMessage`, else a message by code. */
export function exportFailureReason(f: ExportFailure): string {
  const own = f.userMessage?.trim();
  if (own !== undefined && own !== '') return own;
  return REASON_BY_CODE[f.code] ?? 'Relay could not export this file.';
}

/**
 * Per-part rows for an export result, or `null` when the main sent no per-part fields (older mains: the caller
 * falls back to `displayPaths`). `previous` rows for parts not in this result are kept (a retry of one part).
 */
export function exportPartResults(res: ExportOutput, previous: readonly ExportPartResult[] = []): ExportPartResult[] | null {
  if (res.written === undefined && res.failed === undefined) return null;
  const byPart = new Map<ExportPart, ExportPartResult>(previous.map((r) => [r.what, r]));
  for (const w of res.written ?? []) byPart.set(w.what, { what: w.what, state: 'written', displayPath: w.displayPath });
  for (const f of res.failed ?? []) byPart.set(f.what, { what: f.what, state: 'failed', code: f.code, reason: exportFailureReason(f) });
  return PART_ORDER.flatMap((p) => {
    const r = byPart.get(p);
    return r === undefined ? [] : [r];
  });
}

/** What a "Retry" sends: the one failed part, `both` for two, or `null` when nothing failed. */
export function retryWhatOf(rows: readonly ExportPartResult[]): ExportWhat | null {
  const failed = rows.filter((r) => r.state === 'failed').map((r) => r.what);
  if (failed.length === 0) return null;
  if (failed.length === 1) return failed[0] ?? null;
  return 'both';
}
