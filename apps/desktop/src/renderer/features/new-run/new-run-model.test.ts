import { describe, expect, it } from 'vitest';
import { runStartInputSchema } from '@relay/contracts';
import { buildStartInput, checkForm, FIELD, formReducer, INITIAL_FORM, limitDefaults, limitTexts, MAX_MEMORY_RECORD_IDS } from './new-run-model';
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
