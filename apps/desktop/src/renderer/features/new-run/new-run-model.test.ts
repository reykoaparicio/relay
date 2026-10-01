import { describe, expect, it } from 'vitest';
import { buildStartInput, checkForm, formReducer, INITIAL_FORM, limitDefaults, limitTexts } from './new-run-model';
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
