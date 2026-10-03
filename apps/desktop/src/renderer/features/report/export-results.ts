import { exportFailureSchema } from '@relay/contracts';
import type { AppError, ErrorCode, ExportFailure, ExportPart, ExportWhat } from '@relay/contracts';

/** One exported part as the dialog shows it (E2 #10): written (with its path) or failed (with a plain reason). */
export type ExportPartResult =
  | { readonly what: ExportPart; readonly state: 'written'; readonly displayPath: string }
  | {
      readonly what: ExportPart;
      readonly state: 'failed';
      readonly code: ErrorCode;
      readonly reason: string;
      /** A retry can succeed (a write failure); false when it never can (the artifact is gone). */
      readonly retryable: boolean;
    };

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
};

/**
 * Failures a retry can fix: writing the file (the save dialog runs again, so another folder can be chosen). Anything
 * else — above all NOT_FOUND, an artifact that is no longer stored — fails the same way every time.
 */
const RETRYABLE_EXPORT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['ARTIFACT_WRITE_FAILED', 'PERMISSION_DENIED']);

/** True when retrying an export that failed with `code` can succeed. */
export function isRetryableExportFailure(code: ErrorCode): boolean {
  return RETRYABLE_EXPORT_CODES.has(code);
}

/** Final wording of a part whose artifact is gone (NOT_FOUND): no retry is offered. */
export const EXPORT_NOT_FOUND_TEXT = 'This file is no longer stored, so it cannot be exported.';

/** Plain reason for a failed part: final wording for NOT_FOUND, else the main's `userMessage`, else by code. */
export function exportFailureReason(f: ExportFailure): string {
  if (f.code === 'NOT_FOUND') return EXPORT_NOT_FOUND_TEXT;
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
  for (const f of res.failed ?? [])
    byPart.set(f.what, { what: f.what, state: 'failed', code: f.code, reason: exportFailureReason(f), retryable: isRetryableExportFailure(f.code) });
  return PART_ORDER.flatMap((p) => {
    const r = byPart.get(p);
    return r === undefined ? [] : [r];
  });
}

/**
 * Per-part rows of an export that failed as a whole (nothing written: `details.failed`, engine `exportArtifacts`), or
 * null when the error carries none.
 */
export function exportErrorParts(error: AppError | null): ExportPartResult[] | null {
  const failed = exportFailureSchema.array().safeParse(error?.details?.['failed']);
  if (!failed.success || failed.data.length === 0) return null;
  return exportPartResults({ exported: false, displayPaths: [], written: [], failed: failed.data });
}

/** True when retrying an export that failed as a whole can succeed (never for NOT_FOUND: the artifact is gone). */
export function exportErrorRetryable(error: AppError): boolean {
  const parts = exportErrorParts(error);
  if (parts !== null) return retryWhatOf(parts) !== null;
  return error.code !== 'NOT_FOUND';
}

/** True when any part failed (retryable or not): the dialog stays open with the per-part rows. */
export function anyExportFailed(rows: readonly ExportPartResult[]): boolean {
  return rows.some((r) => r.state === 'failed');
}

/** What a "Retry" sends: the one retryable failed part, `both` for two, or `null` when nothing can be retried. */
export function retryWhatOf(rows: readonly ExportPartResult[]): ExportWhat | null {
  const failed = rows.filter((r) => r.state === 'failed' && r.retryable).map((r) => r.what);
  if (failed.length === 0) return null;
  if (failed.length === 1) return failed[0] ?? null;
  return 'both';
}
