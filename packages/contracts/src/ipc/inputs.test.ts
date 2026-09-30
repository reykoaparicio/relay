import { describe, expect, it } from 'vitest';
import { fakeId, fakeSha } from '../test-fixtures.js';
import { OPERATIONS } from './catalog.js';
import { INTERNAL_RUNNER_OPS } from './internal.js';

const KEY = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';

describe('op input schemas', () => {
  it('approvals.decide requires a note for revision_requested', () => {
    const input = OPERATIONS['approvals.decide'].input;
    const base = { idempotencyKey: KEY, approvalId: fakeId('approval'), planHash: fakeSha(), contextHash: fakeSha('b') };

    expect(input.safeParse({ ...base, decision: 'approved' }).success).toBe(true);
    expect(input.safeParse({ ...base, decision: 'revision_requested' }).success).toBe(false);
    expect(input.safeParse({ ...base, decision: 'revision_requested', note: '  ' }).success).toBe(false);
    expect(input.safeParse({ ...base, decision: 'revision_requested', note: 'Smaller scope' }).success).toBe(true);
  });

  it('memory.create requires sourceFile for source_reference and caps title/content', () => {
    const input = OPERATIONS['memory.create'].input;
    const base = {
      idempotencyKey: KEY,
      projectId: fakeId('project'),
      title: 'Doc',
      content: 'See file',
      scope: { roles: ['reviewer'] },
    };

    expect(input.safeParse({ ...base, type: 'user_rule' }).success).toBe(true);
    expect(input.safeParse({ ...base, type: 'source_reference' }).success).toBe(false);
    expect(input.safeParse({ ...base, type: 'source_reference', sourceFile: { relPath: 'docs/a.md' } }).success).toBe(true);
    expect(input.safeParse({ ...base, type: 'run_summary' }).success).toBe(false);
    expect(input.safeParse({ ...base, type: 'user_rule', title: 'x'.repeat(121) }).success).toBe(false);
    expect(input.safeParse({ ...base, type: 'user_rule', content: 'x'.repeat(4001) }).success).toBe(false);
  });

  it('memory.resolveConflict checks record ids against the resolution', () => {
    const input = OPERATIONS['memory.resolveConflict'].input;
    const a = fakeId('memory', 1);
    const b = fakeId('memory', 2);
    const scope = { roles: 'all' };
    const base = { idempotencyKey: KEY, recordIds: [a, b] };

    expect(input.safeParse({ ...base, resolution: { keep: a } }).success).toBe(true);
    expect(input.safeParse({ ...base, resolution: { keep: fakeId('memory', 3) } }).success).toBe(false);
    expect(input.safeParse({ ...base, recordIds: [a, a], resolution: { keep: a } }).success).toBe(false);
    expect(
      input.safeParse({ ...base, resolution: { rewrite: { title: 'Combined', content: 'Both', scope } } }).success,
    ).toBe(true);
    expect(
      input.safeParse({
        ...base,
        resolution: { keepBothWithScopes: [{ recordId: a, scope }, { recordId: b, scope }] },
      }).success,
    ).toBe(true);
    expect(
      input.safeParse({
        ...base,
        resolution: { keepBothWithScopes: [{ recordId: a, scope }, { recordId: a, scope }] },
      }).success,
    ).toBe(false);
  });

  it('pagination defaults and bounds apply', () => {
    const list = OPERATIONS['runs.list'].input.parse({ projectId: fakeId('project') });
    const events = OPERATIONS['runs.events'].input.parse({ runId: fakeId('run'), afterSeq: 0 });

    expect(list).toMatchObject({ limit: 25, sort: 'created_desc' });
    expect(events.limit).toBe(200);
    expect(OPERATIONS['runs.list'].input.safeParse({ projectId: fakeId('project'), limit: 101 }).success).toBe(false);
    expect(OPERATIONS['runs.events'].input.safeParse({ runId: fakeId('run'), afterSeq: 0, limit: 501 }).success).toBe(false);
  });

  it('app.openExternal accepts https only', () => {
    const input = OPERATIONS['app.openExternal'].input;

    expect(input.safeParse({ url: 'https://platform.claude.com/docs' }).success).toBe(true);
    expect(input.safeParse({ url: 'http://example.com' }).success).toBe(false);
    expect(input.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
  });

  it('projects.previewFiles takes a selection or a project, never a path', () => {
    const input = OPERATIONS['projects.previewFiles'].input;

    expect(input.safeParse({ selectionId: fakeId('selection') }).success).toBe(true);
    expect(input.safeParse({ projectId: fakeId('project'), extraExclusions: ['*.log'] }).success).toBe(true);
    expect(input.safeParse({ rootRealpath: '/Users/me/code' }).success).toBe(false);
  });

  it('internal ops require absolute realpaths and well-formed vault files', () => {
    const preview = INTERNAL_RUNNER_OPS['projects.previewRoot'].input;
    const record = INTERNAL_RUNNER_OPS['providers.recordCredentialRef'].input;
    const ledger = INTERNAL_RUNNER_OPS['ledger.exportTo'].input;

    expect(preview.parse({ rootRealpath: '/Users/me/code' })).toMatchObject({ extraExclusions: [] });
    expect(preview.safeParse({ rootRealpath: 'relative/path' }).success).toBe(false);
    expect(preview.safeParse({ rootRealpath: '/a\0b' }).success).toBe(false);
    expect(
      record.safeParse({
        providerId: 'openai',
        storageMode: 'os_protected',
        vaultFile: `secrets/crd_${KEY}.bin`,
        redactedLabel: 'sk-…a1F9',
      }).success,
    ).toBe(true);
    expect(
      record.safeParse({ providerId: 'openai', storageMode: 'session', vaultFile: '../x.bin', redactedLabel: 'x' }).success,
    ).toBe(false);
    expect(
      ledger.safeParse({ projectId: fakeId('project'), month: '2026-09', destinationRealpath: '/tmp/x.csv' }).success,
    ).toBe(true);
    expect(ledger.safeParse({ projectId: fakeId('project'), destinationRealpath: '/tmp/x.csv' }).success).toBe(false);
  });
});
