import { describe, expect, it } from 'vitest';
import { errors, previewResultSchema, runStartInputSchema } from '@relay/contracts';
import {
  acknowledgedFor,
  buildStartInput,
  checkForm,
  defaultFiles,
  deniedSecretsOf,
  FIELD,
  fieldForPath,
  fileCheckboxId,
  fileCheckboxIds,
  formReducer,
  INITIAL_FORM,
  limitDefaults,
  limitTexts,
  MAX_MEMORY_RECORD_IDS,
  problemsFromError,
  unreadableFileOf,
} from './new-run-model';
import type { NewRunForm } from './new-run-model';

function startInput(form: NewRunForm) {
  const d = limitDefaults(undefined);
  const check = checkForm(form, limitTexts(form, d), d, 1);
  return buildStartInput({ form, projectId: 'prj_1', workflow: { id: 'wfl_1', version: 3 }, files: ['a.ts'], rows: [], check, goal: 'Goal' });
}

describe('new-run memory selection (engine: absent = all approved, [] = pinned only, list = pinned + those)', () => {
  it('an untouched picker sends no memoryRecordIds', () => {
    expect(INITIAL_FORM.memoryIds).toBeNull();
    expect(startInput(INITIAL_FORM)).not.toHaveProperty('memoryRecordIds');
  });

  it('the first toggle starts from every non-pinned approved record, then the explicit list is sent', () => {
    const f = formReducer(INITIAL_FORM, { type: 'toggle-memory', id: 'mem_2', checked: false, defaults: ['mem_1', 'mem_2', 'mem_3'] });
    expect(f.memoryIds).toEqual(['mem_1', 'mem_3']);
    expect(startInput(f)?.memoryRecordIds).toEqual(['mem_1', 'mem_3']);
  });

  it('unticking everything sends [] (pinned only), not absent', () => {
    let f = formReducer(INITIAL_FORM, { type: 'toggle-memory', id: 'mem_1', checked: false, defaults: ['mem_1'] });
    expect(startInput(f)?.memoryRecordIds).toEqual([]);
    f = formReducer(f, { type: 'toggle-memory', id: 'mem_1', checked: true, defaults: ['mem_1'] });
    expect(startInput(f)?.memoryRecordIds).toEqual(['mem_1']);
  });
});

describe('new-run memory selection cap (contracts memoryRecordIds max)', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => 'mem_01' + String(i).padStart(24, '0'));
  const base = { projectId: 'prj_01' + '0'.repeat(24), workflowId: 'wfl_01' + '0'.repeat(24), workflowVersion: 1, goal: 'g', input: { kind: 'files' as const, relPaths: ['a.ts'] } };

  it('MAX_MEMORY_RECORD_IDS is the schema maximum', () => {
    const schema = runStartInputSchema.omit({ idempotencyKey: true });
    expect(schema.safeParse({ ...base, memoryRecordIds: ids(MAX_MEMORY_RECORD_IDS) }).success).toBe(true);
    expect(schema.safeParse({ ...base, memoryRecordIds: ids(MAX_MEMORY_RECORD_IDS + 1) }).success).toBe(false);
  });

  it('an explicit selection over the cap is a memory-field problem and produces no input (no preflight, no start)', () => {
    const form = { ...INITIAL_FORM, memoryIds: ids(MAX_MEMORY_RECORD_IDS + 3) };
    const d = limitDefaults(undefined);
    const check = checkForm(form, limitTexts(form, d), d, 1);
    expect(check.fieldErrors[FIELD.memory]).toBe('Choose at most 50 records (53 are ticked). Untick 3 more, or include all approved records.');
    expect(check.problems).toContainEqual({ fieldId: FIELD.memory, message: check.fieldErrors[FIELD.memory] });
    expect(startInput(form)).toBeNull();
    expect(startInput({ ...form, memoryIds: ids(MAX_MEMORY_RECORD_IDS) })?.memoryRecordIds).toHaveLength(MAX_MEMORY_RECORD_IDS);
  });
});

describe('suspected secrets and file anchors (E2 #8, #11)', () => {
  const preview = previewResultSchema.parse({
    included: [
      { relPath: 'src/a.ts', sizeBytes: 10, sha256: null },
      { relPath: 'src/config/keys.ts', sizeBytes: 20, sha256: null, suspectedSecret: true, secretLabel: 'anthropic_key', secretLine: 4 },
      { relPath: 'src/b.ts', sizeBytes: 30, sha256: null },
    ],
    excluded: [],
    totals: { files: 3, bytes: 60, capBytes: 1000, capFiles: 200 },
  });

  it('the default selection leaves suspected secrets out', () => {
    expect(defaultFiles(preview)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(defaultFiles(undefined)).toEqual([]);
  });

  it('set-files keeps acknowledgements a subset of the selection (unticking drops one)', () => {
    let f = formReducer(INITIAL_FORM, { type: 'set-files', files: ['src/a.ts', 'src/config/keys.ts'], acknowledged: ['src/config/keys.ts'] });
    expect(f.acknowledgedSecrets).toEqual(['src/config/keys.ts']);
    f = formReducer(f, { type: 'set-files', files: ['src/a.ts'] });
    expect(f.acknowledgedSecrets).toEqual([]);
  });

  it('runs.start input carries acknowledgedSuspectedSecrets only for selected, confirmed files', () => {
    const d = limitDefaults(undefined);
    const build = (form: NewRunForm, files: readonly string[]) =>
      buildStartInput({ form, projectId: 'prj_1', workflow: { id: 'wfl_1', version: 3 }, files, rows: [], check: checkForm(form, limitTexts(form, d), d, files.length), goal: 'Goal' });
    const acked = { ...INITIAL_FORM, acknowledgedSecrets: ['src/config/keys.ts'] };
    expect(build(acked, ['src/a.ts', 'src/config/keys.ts'])?.input).toEqual({
      kind: 'files',
      relPaths: ['src/a.ts', 'src/config/keys.ts'],
      acknowledgedSuspectedSecrets: ['src/config/keys.ts'],
    });
    expect(build(acked, ['src/a.ts'])?.input).toEqual({ kind: 'files', relPaths: ['src/a.ts'] });
    expect(acknowledgedFor(['x', 'y'], ['y', 'z'])).toEqual(['y']);
  });

  it('input.relPaths.<i> issue paths reach that file\'s checkbox; unknown files fall back to the picker', () => {
    const anchors = { relPaths: ['src/a.ts', 'src/config/keys.ts'], ids: fileCheckboxIds(preview) };
    expect(fileCheckboxId(0)).toBe(FIELD.files);
    expect(fieldForPath('input.relPaths.1', 'files', anchors)).toBe(`${FIELD.files}-1`);
    expect(fieldForPath('input.relPaths.0', 'files', anchors)).toBe(FIELD.files);
    expect(fieldForPath('input.relPaths.9', 'files', anchors)).toBe(FIELD.files);
    expect(fieldForPath('input.relPaths.1', 'diff', anchors)).toBe(FIELD.diff);
  });

  it('a suspected_secret denial becomes one problem per file (label in words, never a value), anchored to it', () => {
    const e = errors.permissionDenied('suspected_secret', {
      details: { relPath: 'src/config/keys.ts', denied: [{ relPath: 'src/config/keys.ts', reason: 'suspected_secret', secretLabel: 'anthropic_key', secretLine: 4 }] },
    });
    expect(deniedSecretsOf(e)).toEqual([{ relPath: 'src/config/keys.ts', secretLabel: 'anthropic_key', secretLine: 4 }]);
    const problems = problemsFromError(e, [], 'files', { anchors: { relPaths: [], ids: fileCheckboxIds(preview) } });
    expect(problems).toEqual([
      {
        fieldId: `${FIELD.files}-1`,
        message: 'src/config/keys.ts looks like it contains a secret (Anthropic API key, line 4). Untick it, or confirm sending it.',
        code: 'suspected_secret',
      },
    ]);
  });

  it('an unreadable file links to its checkbox and carries the page\'s actions', () => {
    const e = errors.permissionDenied('unreadable', { userMessage: 'Relay cannot read src/b.ts.', details: { relPath: 'src/b.ts' } });
    expect(unreadableFileOf(e)).toBe('src/b.ts');
    const [p] = problemsFromError(e, [], 'files', { anchors: { relPaths: [], ids: fileCheckboxIds(preview) }, unreadableAction: (rel) => `act:${rel}` });
    expect(p).toEqual({ fieldId: `${FIELD.files}-2`, message: 'Relay cannot read src/b.ts.', code: 'PERMISSION_DENIED', action: 'act:src/b.ts' });
  });
});
