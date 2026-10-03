// Decision 3: per-step output limits on New run (model, validation, clamping, draft persistence).
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_OUTPUT_TOKENS_CEILING, outputTokenOverridesSchema } from '@relay/contracts';
import type { CatalogModel, ProfileWithWarnings, RunPreflight, StepKey } from '@relay/contracts';
import {
  buildStartInput,
  checkForm,
  checkOutputOverrides,
  FIELD,
  fieldForPath,
  formReducer,
  INITIAL_FORM,
  limitDefaults,
  limitTexts,
} from './new-run-model';
import type { NewRunForm } from './new-run-model';
import { loadNewRunDraft, resetNewRunDrafts, saveNewRunDraft } from './new-run-draft';
import type { ModelStepRow } from '../run-setup/model-steps';
import {
  checkOutputTokens,
  clampOutputText,
  isOutputOverridden,
  outputRangeText,
  stepOutputLimits,
} from '../run-setup/output-limits';
import type { StepOutputLimit } from '../run-setup/output-limits';

const ROWS: ModelStepRow[] = [
  { stepKey: 'review', role: 'reviewer', specProfile: 'economy', defaultProfileId: 'prf_economy', maxOutputTokens: 8000 },
  { stepKey: 'plan', role: 'planner', specProfile: 'balanced', defaultProfileId: 'prf_balanced', maxOutputTokens: undefined },
];

function profile(id: string, providerId: 'anthropic' | 'openai', modelId: string, maxOutputTokens: number): ProfileWithWarnings {
  return { profile: { id, name: id, providerId, modelId, params: { maxOutputTokens } }, warnings: [] } as unknown as ProfileWithWarnings;
}
const PROFILES = [
  profile('prf_economy', 'anthropic', 'claude-haiku-4-5', 8000),
  profile('prf_balanced', 'openai', 'gpt-5-mini', 12_000),
];
const CATALOG = [
  { providerId: 'anthropic', modelId: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', capabilities: { maxOutputTokens: 64_000 } },
  { providerId: 'openai', modelId: 'gpt-5-mini', displayName: 'GPT-5 mini', capabilities: { maxOutputTokens: 128_000 } },
] as unknown as CatalogModel[];

const LIMITS: Record<string, StepOutputLimit> = {
  review: { defaultTokens: 8000, min: 256, max: 64_000, modelName: 'Claude Haiku 4.5' },
  plan: { defaultTokens: 12_000, min: 256, max: 128_000, modelName: 'GPT-5 mini' },
};

function startInput(form: NewRunForm) {
  const d = limitDefaults(undefined);
  const check = checkForm(form, limitTexts(form, d), d, 1, LIMITS);
  return {
    check,
    input: buildStartInput({ form, projectId: 'prj_1', workflow: { id: 'wfl_1', version: 3 }, files: ['a.ts'], rows: ROWS, check, goal: 'Goal' }),
  };
}

describe('stepOutputLimits', () => {
  it('derives defaults locally (step setting, else the profile) and the range from the catalog', () => {
    const limits = stepOutputLimits({ rows: ROWS, selection: {}, profiles: PROFILES, catalog: CATALOG, stepLimits: undefined });
    expect(limits).toEqual(LIMITS);
    expect(Object.keys(limits)).toEqual(['review', 'plan']);
  });

  it('prefers the preflight stepLimits, and falls back to the contracts ceiling without a catalog', () => {
    const stepLimits: RunPreflight['stepLimits'] = [
      { stepKey: 'review' as StepKey, defaultMaxOutputTokens: 9000, minMaxOutputTokens: 256, modelMaxOutputTokens: 32_000 },
    ];
    const limits = stepOutputLimits({ rows: ROWS, selection: {}, profiles: PROFILES, catalog: undefined, stepLimits });
    expect(limits['review']).toMatchObject({ defaultTokens: 9000, min: 256, max: 32_000 });
    expect(limits['plan']).toMatchObject({ defaultTokens: 12_000, min: 256, max: MAX_OUTPUT_TOKENS_CEILING, modelName: 'gpt-5-mini' });
  });

  it('formats the range hint with grouping', () => {
    expect(outputRangeText(LIMITS['review'] as StepOutputLimit)).toBe('256–64,000');
  });
});

describe('output override validation', () => {
  const review = LIMITS['review'] as StepOutputLimit;
  it('accepts a whole number in range and words every error', () => {
    expect(checkOutputTokens(' 4000 ', review)).toEqual({ value: 4000 });
    expect(checkOutputTokens('12.5', review)).toEqual({ error: 'Enter a whole number from 256 to 64,000.' });
    expect(checkOutputTokens('', review)).toEqual({ error: 'Enter a whole number from 256 to 64,000.' });
    expect(checkOutputTokens('100', review)).toEqual({ error: 'Must be at least 256.' });
    expect(checkOutputTokens('70000', review)).toEqual({ error: 'Must be at most 64,000, the most Claude Haiku 4.5 can return.' });
  });

  it('an invalid value is a field error and a problem, ordered before the run limits, and blocks the start input', () => {
    const form = formReducer(INITIAL_FORM, { type: 'set-output-tokens', stepKey: 'review', text: '70000' });
    const { check, input } = startInput({ ...form, allowanceText: 'x' });
    expect(check.fieldErrors[FIELD.maxOutput('review')]).toBe('Must be at most 64,000, the most Claude Haiku 4.5 can return.');
    expect(check.problems.map((p) => p.fieldId)).toEqual([FIELD.maxOutput('review'), FIELD.allowance]);
    expect(input).toBeNull();
  });

  it('maps server issue paths outputTokenOverrides.<step> to that step input', () => {
    expect(fieldForPath('outputTokenOverrides.plan')).toBe('new-run-max-output-plan');
    expect(FIELD.maxOutput('plan')).toBe('new-run-max-output-plan');
  });
});

describe('outputTokenOverrides in the start input', () => {
  it('is omitted while untouched, and when the value typed equals the default', () => {
    expect(startInput(INITIAL_FORM).input).not.toHaveProperty('outputTokenOverrides');
    const same = formReducer(INITIAL_FORM, { type: 'set-output-tokens', stepKey: 'review', text: '8000' });
    expect(isOutputOverridden('8000', LIMITS['review'])).toBe(false);
    expect(startInput(same).input).not.toHaveProperty('outputTokenOverrides');
  });

  it('carries only the changed steps, and parses with the contract', () => {
    const form = formReducer(INITIAL_FORM, { type: 'set-output-tokens', stepKey: 'plan', text: '20000' });
    const { input } = startInput(form);
    expect(input?.outputTokenOverrides).toEqual({ plan: 20_000 });
    expect(outputTokenOverridesSchema.parse(input?.outputTokenOverrides)).toEqual({ plan: 20_000 });
  });

  it('checkOutputOverrides ignores steps that are not model steps of the workflow', () => {
    expect(checkOutputOverrides({ gone: '999' }, LIMITS)).toEqual({ overrides: undefined, errors: {} });
  });

  it('reset one step, and reset all', () => {
    let form = formReducer(INITIAL_FORM, { type: 'set-output-tokens', stepKey: 'plan', text: '20000' });
    form = formReducer(form, { type: 'set-output-tokens', stepKey: 'review', text: '4000' });
    form = formReducer(form, { type: 'reset-output-tokens', stepKey: 'plan' });
    expect(form.outputTokenTexts).toEqual({ review: '4000' });
    form = formReducer(form, { type: 'reset-output-tokens' });
    expect(form.outputTokenTexts).toEqual({});
  });
});

describe('switching a step profile', () => {
  it('lowers an override above the new model maximum, with a note', () => {
    expect(clampOutputText('100000', 64_000, 'Claude Haiku 4.5')).toEqual({
      text: '64000',
      note: 'Lowered to 64,000, the most Claude Haiku 4.5 can return.',
    });
    let form = formReducer(INITIAL_FORM, { type: 'set-output-tokens', stepKey: 'plan', text: '100000' });
    form = formReducer(form, {
      type: 'select-profile',
      stepKey: 'plan',
      profileId: 'prf_economy',
      outputMax: { max: 64_000, modelName: 'Claude Haiku 4.5' },
    });
    expect(form.profileSelection).toEqual({ plan: 'prf_economy' });
    expect(form.outputTokenTexts).toEqual({ plan: '64000' });
    expect(form.outputTokenNotes).toEqual({ plan: 'Lowered to 64,000, the most Claude Haiku 4.5 can return.' });
    // Typing again drops the note.
    form = formReducer(form, { type: 'set-output-tokens', stepKey: 'plan', text: '5000' });
    expect(form.outputTokenNotes).toEqual({});
  });

  it('L-2: switching back to a larger model restores the typed value and clears the stale "Lowered to…" note', () => {
    let form = formReducer(INITIAL_FORM, { type: 'select-profile', stepKey: 'review', profileId: 'prf_capable', outputMax: { max: 128_000, modelName: 'Claude Opus 5.5' } });
    form = formReducer(form, { type: 'set-output-tokens', stepKey: 'review', text: '100000' });
    form = formReducer(form, { type: 'select-profile', stepKey: 'review', profileId: 'prf_economy', outputMax: { max: 64_000, modelName: 'Claude Haiku 4.5' } });
    expect([form.outputTokenTexts['review'], form.outputTokenNotes['review']]).toEqual(['64000', 'Lowered to 64,000, the most Claude Haiku 4.5 can return.']);

    form = formReducer(form, { type: 'select-profile', stepKey: 'review', profileId: 'prf_capable', outputMax: { max: 128_000, modelName: 'Claude Opus 5.5' } });

    expect(form.outputTokenTexts['review']).toBe('100000');
    expect(form.outputTokenNotes['review']).toBeUndefined();
    // A model in between that still cannot return it lowers it again, naming THAT model.
    form = formReducer(form, { type: 'select-profile', stepKey: 'review', profileId: 'prf_balanced', outputMax: { max: 80_000, modelName: 'Claude Sonnet 5.5' } });
    expect([form.outputTokenTexts['review'], form.outputTokenNotes['review']]).toEqual(['80000', 'Lowered to 80,000, the most Claude Sonnet 5.5 can return.']);
    // Typing forgets the earlier value: a later larger model keeps what was typed last.
    form = formReducer(form, { type: 'set-output-tokens', stepKey: 'review', text: '50000' });
    form = formReducer(form, { type: 'select-profile', stepKey: 'review', profileId: 'prf_capable', outputMax: { max: 128_000, modelName: 'Claude Opus 5.5' } });
    expect([form.outputTokenTexts['review'], form.outputTokenNotes['review']]).toEqual(['50000', undefined]);
  });

  it('keeps an override that fits the new model, and leaves untouched steps alone', () => {
    let form = formReducer(INITIAL_FORM, { type: 'set-output-tokens', stepKey: 'plan', text: '30000' });
    form = formReducer(form, { type: 'select-profile', stepKey: 'plan', profileId: 'prf_economy', outputMax: { max: 64_000, modelName: 'x' } });
    expect(form.outputTokenTexts).toEqual({ plan: '30000' });
    expect(form.outputTokenNotes).toEqual({});
    form = formReducer(form, { type: 'select-profile', stepKey: 'review', profileId: 'prf_economy', outputMax: { max: 1000, modelName: 'x' } });
    expect(form.outputTokenTexts).toEqual({ plan: '30000' });
    expect(clampOutputText('abc', 1000, 'x')).toEqual({ text: 'abc', note: null });
  });
});

describe('New run draft', () => {
  afterEach(() => {
    resetNewRunDrafts();
  });

  it('persists the overrides, and an untouched form (by value, e.g. after Reset all) removes the draft', () => {
    const form = formReducer(INITIAL_FORM, { type: 'set-output-tokens', stepKey: 'plan', text: '20000' });
    saveNewRunDraft('prj_1', form);
    expect(loadNewRunDraft('prj_1')?.outputTokenTexts).toEqual({ plan: '20000' });
    const reset = formReducer(form, { type: 'reset-output-tokens' });
    expect(reset.outputTokenTexts).not.toBe(INITIAL_FORM.outputTokenTexts);
    saveNewRunDraft('prj_1', reset);
    expect(loadNewRunDraft('prj_1')).toBeUndefined();
  });
});
