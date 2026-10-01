import { describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../api/fake-bridge';
import { buildPatch, changedFields, initialForm, rebaseForm } from './workflow-form';

const view = () => {
  const w = createFakeBridge('awaiting-approval').world;
  const v = w.workflowVersions.find((x) => x.version === 3);
  if (v === undefined) throw new Error('no v3');
  return v;
};

describe('workflow-form base diff and re-base (B4)', () => {
  it('buildPatch diffs against the base: a newer saved prompt is never reverted by an untouched field', () => {
    const base = view();
    const mine = { ...initialForm(base), revisions: '3' };
    const theirs = { ...base, prompts: { ...base.prompts, 'reviewer.v1': { ...base.prompts['reviewer.v1']!, text: 'Changed elsewhere.' } } };
    // Against the base: only my field.
    expect(buildPatch(base, mine).patch).toEqual({ limits: { maxRevisionCycles: 3 } });
    // Diffing against the newer version instead would send my stale prompt (the bug).
    expect(buildPatch(theirs, mine).patch).toHaveProperty('prompts');
    const changed = changedFields(base, initialForm(theirs), initialForm(base)).map((f) => f.label);
    expect(changed).toEqual(['Review step: prompt']);
    const rebased = rebaseForm(initialForm(base), mine, initialForm(theirs));
    expect(rebased.prompts['reviewer.v1']).toBe('Changed elsewhere.');
    expect(rebased.revisions).toBe('3');
    expect(buildPatch(theirs, rebased).patch).toEqual({ limits: { maxRevisionCycles: 3 } });
  });

  it('a field changed on both sides keeps mine', () => {
    const base = view();
    const mine = { ...initialForm(base), allowance: '9.00' };
    const theirs = { ...initialForm(base), allowance: '7.00' };
    expect(rebaseForm(initialForm(base), mine, theirs).allowance).toBe('9.00');
  });
});
