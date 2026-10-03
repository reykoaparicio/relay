import { describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../api/fake-bridge';
import { buildPatch, changedFields, followSavedPrompts, initialForm, issueTarget, nextInstructionVersion, promptVersioning, rebaseForm, WF_FIELD } from './workflow-form';

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
    expect(changed).toEqual(['Review input step: prompt']);
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

describe('workflow-form step names and instruction versions (E2 #10)', () => {
  it('names: trimmed, sent per step kind; unchanged after trim is no change; >60 and clearing a saved name are errors', () => {
    const base = view();
    const approval = base.spec.steps.find((st) => st.kind === 'approval');
    if (approval === undefined) throw new Error('no approval step');
    const form = initialForm(base);
    expect(buildPatch(base, { ...form, names: { ...form.names, review: '  Check  ', [approval.id]: 'Sign off' } }).patch).toEqual({
      steps: { review: { name: 'Check' }, [approval.id]: { name: 'Sign off' } },
    });
    expect(buildPatch(base, { ...form, names: { ...form.names, review: '   ' } }).patch).toBeNull();
    const long = buildPatch(base, { ...form, names: { ...form.names, review: 'x'.repeat(61) } });
    expect(long.errors[WF_FIELD.name('review')]).toBe('Use at most 60 characters.');
    const named = { ...base, spec: { ...base.spec, steps: base.spec.steps.map((st) => (st.id === 'review' ? { ...st, name: 'Check' } : st)) } };
    const cleared = buildPatch(named, { ...initialForm(named), names: { ...initialForm(named).names, review: '' } });
    expect(cleared.patch).toBeNull();
    expect(cleared.errors[WF_FIELD.name('review')]).toMatch(/cannot be cleared/);
    expect(issueTarget(base, `steps.${approval.id}.name`)).toEqual({ fieldId: WF_FIELD.name(approval.id), stepKey: approval.id });
  });

  it('nextInstructionVersion: next number of the same stem not already taken', () => {
    expect(nextInstructionVersion('reviewer.v1', ['reviewer.v1', 'planner.v4'])).toBe('reviewer.v2');
    expect(nextInstructionVersion('reviewer.v1', ['reviewer.v1', 'reviewer.v3'])).toBe('reviewer.v4');
  });

  it('promptVersioning: published → next version; draft-only → in place; unknown while loading', () => {
    const base = view();
    expect(promptVersioning(base, 'reviewer.v1', new Set(['reviewer.v1']))).toEqual({ kind: 'published', current: 'reviewer.v1', next: 'reviewer.v2' });
    expect(promptVersioning(base, 'reviewer.v1', new Set())).toEqual({ kind: 'draft_only', current: 'reviewer.v1' });
    expect(promptVersioning(base, 'reviewer.v1', null).kind).toBe('unknown');
  });

  it('followSavedPrompts: the form text moves to the renamed key of the saved draft', () => {
    const base = view();
    const form = { ...initialForm(base), prompts: { ...initialForm(base).prompts, 'reviewer.v1': 'New text' } };
    const saved = {
      ...base,
      spec: { ...base.spec, steps: base.spec.steps.map((st) => (st.kind === 'model' && st.instructionVersion === 'reviewer.v1' ? { ...st, instructionVersion: 'reviewer.v2' } : st)) },
      prompts: Object.fromEntries(
        Object.entries(base.prompts).map(([k, p]) => (k === 'reviewer.v1' ? ['reviewer.v2', { ...p, instructionVersion: 'reviewer.v2', text: 'New text' }] : [k, p])),
      ),
    };
    const next = followSavedPrompts(base, saved, form);
    expect(next.prompts['reviewer.v2']).toBe('New text');
    expect(next.prompts).not.toHaveProperty('reviewer.v1');
    expect(buildPatch(saved, next).patch).toBeNull();
  });
});
