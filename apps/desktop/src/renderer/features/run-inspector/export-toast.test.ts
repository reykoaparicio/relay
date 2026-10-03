import { describe, expect, it } from 'vitest';
import { exportToast } from './export-toast';

describe('exportToast (E2 #10 per-part export results)', () => {
  it('every part saved: a success toast with the paths', () => {
    expect(
      exportToast({
        exported: true,
        displayPaths: ['~/a.md'],
        written: [{ what: 'report', displayPath: '~/a.md' }],
        failed: [],
      }),
    ).toEqual({
      title: 'Export saved',
      body: '~/a.md',
      tone: 'success',
    });
  });

  it('an older main without written/failed: the display paths, as before', () => {
    expect(exportToast({ exported: true, displayPaths: ['~/a.md'] })?.tone).toBe('success');
  });

  it('the save dialog was cancelled: no toast', () => {
    expect(exportToast({ exported: false, displayPaths: [], written: [], failed: [] })).toBeNull();
  });

  it('a partial export: a warning naming the saved path and why the other part failed', () => {
    const t = exportToast({
      exported: true,
      displayPaths: ['~/report.md'],
      written: [{ what: 'report', displayPath: '~/report.md' }],
      failed: [{ what: 'patch', code: 'ARTIFACT_WRITE_FAILED', userMessage: 'The folder is read-only.' }],
    });
    expect(t).toEqual({
      title: 'Export partly saved',
      body: 'Saved: ~/report.md. Patch not saved: The folder is read-only.',
      tone: 'warning',
    });
  });

  it('a failed part without a message names the error code', () => {
    const t = exportToast({
      exported: false,
      displayPaths: [],
      failed: [{ what: 'report', code: 'NOT_FOUND' }],
    });
    expect(t?.title).toBe('Export not saved');
    expect(t?.body).toBe('Report not saved: the file could not be written (error code NOT_FOUND)');
    expect(t?.tone).toBe('warning');
  });
});
