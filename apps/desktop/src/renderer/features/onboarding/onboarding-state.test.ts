import { describe, expect, it } from 'vitest';
import { INITIAL_ONBOARDING, onboardingReducer, selectionExpired } from './onboarding-state';
import type { DirectorySelection } from '@relay/contracts';
import type { OnboardingState } from './onboarding-state';

const SAMPLE = { id: 'prj_sample', name: 'Sample API', isSample: true };
const OWN = { id: 'prj_own', name: 'my-api', isSample: false };

describe('onboardingReducer (B8)', () => {
  it('drops the saved rule when the project changes (sample ↔ own folder)', () => {
    const withRule: OnboardingState = {
      ...INITIAL_ONBOARDING,
      project: SAMPLE,
      savedRule: { id: 'mem_1', revision: 1 },
      ruleText: 'Keep handlers thin.',
    };
    const toOwn = onboardingReducer(withRule, { type: 'patch', patch: { project: null } });
    expect(toOwn.savedRule).toBeNull();
    expect(toOwn.ruleText).toBe('Keep handlers thin.');
    const created = onboardingReducer(
      { ...toOwn, savedRule: { id: 'mem_2', revision: 1 } },
      { type: 'patch', patch: { project: OWN } },
    );
    expect(created.savedRule).toBeNull();
    const back = onboardingReducer({ ...withRule, project: OWN }, { type: 'patch', patch: { project: SAMPLE } });
    expect(back.savedRule).toBeNull();
  });

  it('keeps the saved rule for other patches and for the same project', () => {
    const withRule: OnboardingState = { ...INITIAL_ONBOARDING, project: SAMPLE, savedRule: { id: 'mem_1', revision: 1 } };
    expect(onboardingReducer(withRule, { type: 'patch', patch: { goal: 'x' } }).savedRule).not.toBeNull();
    expect(onboardingReducer(withRule, { type: 'patch', patch: { project: { ...SAMPLE } } }).savedRule).not.toBeNull();
  });
});

describe('selection expiry (B10)', () => {
  it('a selection is unusable from its expiresAt on; clear-selection drops it', () => {
    const selection = { selectionId: 'sel_1', displayPath: '~/code/my-api', expiresAt: 1_000 } as DirectorySelection;
    expect(selectionExpired(selection, 999)).toBe(false);
    expect(selectionExpired(selection, 1_000)).toBe(true);
    const s = onboardingReducer({ ...INITIAL_ONBOARDING, selection }, { type: 'clear-selection' });
    expect(s.selection).toBeNull();
  });
});
