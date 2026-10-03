import { describe, expect, it } from 'vitest';
import { exportFailureReason, exportPartResults, retryWhatOf } from './export-results';

describe('export-results (E2 #10)', () => {
  it('older mains without written / failed: null (the caller falls back to displayPaths)', () => {
    expect(exportPartResults({ exported: true, displayPaths: ['~/Downloads/report.md'] })).toBeNull();
  });

  it('rows per part in report, patch order; a retry merges into the previous rows', () => {
    const first = exportPartResults({
      exported: true,
      displayPaths: ['~/a/report.md'],
      written: [{ what: 'report', displayPath: '~/a/report.md' }],
      failed: [{ what: 'patch', code: 'ARTIFACT_WRITE_FAILED' }],
    });
    expect(first).toEqual([
      { what: 'report', state: 'written', displayPath: '~/a/report.md' },
      { what: 'patch', state: 'failed', code: 'ARTIFACT_WRITE_FAILED', reason: 'Relay could not write the file. The folder may be read-only or full.' },
    ]);
    expect(retryWhatOf(first ?? [])).toBe('patch');
    const merged = exportPartResults({ exported: true, displayPaths: ['~/a/x.patch'], written: [{ what: 'patch', displayPath: '~/a/x.patch' }], failed: [] }, first ?? []);
    expect(merged?.map((r) => r.state)).toEqual(['written', 'written']);
    expect(retryWhatOf(merged ?? [])).toBeNull();
  });

  it('two failed parts retry as both', () => {
    const rows = exportPartResults({
      exported: true,
      displayPaths: [],
      failed: [
        { what: 'patch', code: 'NOT_FOUND' },
        { what: 'report', code: 'ARTIFACT_WRITE_FAILED' },
      ],
    });
    expect(rows?.map((r) => r.what)).toEqual(['report', 'patch']);
    expect(retryWhatOf(rows ?? [])).toBe('both');
  });

  it('reason: userMessage first, else a plain message by code', () => {
    expect(exportFailureReason({ what: 'patch', code: 'ARTIFACT_WRITE_FAILED', userMessage: 'Disk full.' })).toBe('Disk full.');
    expect(exportFailureReason({ what: 'report', code: 'NOT_FOUND', userMessage: '  ' })).toBe('This file is no longer stored for the run.');
    expect(exportFailureReason({ what: 'report', code: 'RATE_LIMITED' })).toBe('Relay could not export this file.');
  });
});
