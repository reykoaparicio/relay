import { describe, expect, it } from 'vitest';
import { errors } from '@relay/contracts';
import type { RunPreflight } from '@relay/contracts';
import { AppErrorException } from '../../api/client';
import { createFakeBridge, FAKE_PROJECT_ID, FAKE_WORKFLOW_ID } from '../../api/fake-bridge';
import { WORKFLOW_VERSION } from '../../api/fake-scenarios/world';
import { canonicalJson } from '../../hooks/useIdempotentMutation';
import { buildStartInput, checkForm, deriveNewRunState, FIELD, INITIAL_FORM, limitDefaults, limitTexts } from './new-run-model';
import type { NewRunForm, NewRunStateInput, PreflightSnapshot } from './new-run-model';

const WF = { id: FAKE_WORKFLOW_ID, version: WORKFLOW_VERSION };

/** A real preflight answer from the fake bridge for `form` (the shapes the page receives). */
async function preflightFor(form: NewRunForm, budgetMicrousd?: number): Promise<RunPreflight> {
  const bridge = createFakeBridge('awaiting-approval');
  const d = limitDefaults(undefined);
  const check = checkForm(form, limitTexts(form, d), d, 1);
  const input = buildStartInput({ form, projectId: FAKE_PROJECT_ID, workflow: WF, files: ['src/a.ts'], rows: [], check, goal: 'Fix it' });
  if (input === null) throw new Error('no input');
  const res = await bridge.invoke('relay/v1/runs.preflight', {
    ...input,
    ...(budgetMicrousd === undefined ? {} : { limitOverrides: { budgetMicrousd } }),
  });
  if (!res.ok) throw new Error('preflight failed');
  return res.data;
}

function stateInput(form: NewRunForm, preflight: PreflightSnapshot, overrides: Partial<NewRunStateInput> = {}): NewRunStateInput {
  const d = limitDefaults(undefined);
  const check = checkForm(form, limitTexts(form, d), d, 1);
  const goal = form.goal.trim();
  const draft = buildStartInput({ form, projectId: FAKE_PROJECT_ID, workflow: WF, files: ['src/a.ts'], rows: [], check, goal: goal === '' ? 'Draft goal' : goal });
  const submit = buildStartInput({ form, projectId: FAKE_PROJECT_ID, workflow: WF, files: ['src/a.ts'], rows: [], check, goal });
  const draftKey = draft === null ? null : canonicalJson(draft);
  return {
    form,
    rows: [],
    check,
    profiles: [],
    goal,
    draftKey,
    settledKey: draftKey ?? '',
    submitKey: submit === null ? null : canonicalJson(submit),
    preflight,
    startError: null,
    failedKey: null,
    ...overrides,
  };
}

const settled = (data: RunPreflight | undefined, error: unknown = null): PreflightSnapshot => ({
  data,
  error,
  isFetching: false,
  isPlaceholderData: false,
  isSuccess: data !== undefined && error === null,
});

const WITH_GOAL: NewRunForm = { ...INITIAL_FORM, goal: 'Fix it' };

describe('deriveNewRunState', () => {
  it('a clean, settled preflight of exactly the submitted input is ready and enables Start', async () => {
    const pf = await preflightFor(WITH_GOAL);

    const s = deriveNewRunState(stateInput(WITH_GOAL, settled(pf)));

    expect(s.checked).toBe(true);
    expect(s.status).toBe('ready');
    expect(s.startDisabled).toBe(false);
    expect(s.startDisabledReason).toBeNull();
    expect(s.problems).toEqual([]);
  });

  it('while the debounced check has not caught up, it is checking and Start is disabled', async () => {
    const pf = await preflightFor(WITH_GOAL);

    const s = deriveNewRunState(stateInput(WITH_GOAL, settled(pf), { settledKey: 'an older input' }));

    expect(s.checking).toBe(true);
    expect(s.status).toBe('checking');
    expect(s.startDisabled).toBe(true);
    expect(s.startDisabledReason).toBe('Checking…');
  });

  it('a refused first reservation blocks Start with the budget, without restating budget_run as a problem', async () => {
    const pf = await preflightFor(WITH_GOAL, 1);

    const s = deriveNewRunState(stateInput(WITH_GOAL, settled(pf)));

    expect(pf.budget.allowed).toBe(false);
    expect(s.budget).not.toBeNull();
    expect(s.status).toBe('budget');
    expect(s.problems.some((p) => p.code === 'budget_run')).toBe(false);
    expect(s.startDisabled).toBe(true);
    expect(s.startDisabledReason).toMatch(/^Blocked by the run allowance/);
  });

  it('a runner failure of the check is a system error, not a form problem', () => {
    const e = new AppErrorException(errors.runnerUnavailable());

    const s = deriveNewRunState(stateInput(WITH_GOAL, settled(undefined, e)));

    expect(s.preflightSystemError).toBe(e);
    expect(s.problems).toEqual([]);
    expect(s.status).toBe('system_error');
    expect(s.startDisabledReason).toBe('The run check failed. Retry it in Input summary.');
  });

  it('client problems are listed first and anchored to their fields; unknown anchors are dropped', async () => {
    const form: NewRunForm = { ...INITIAL_FORM, goal: '', submitted: true, attemptsText: '0' };
    const pf = await preflightFor(WITH_GOAL);

    const s = deriveNewRunState(stateInput(form, settled({ ...pf, issues: [{ path: 'profileOverrides.ghost', code: 'unknown_profile', message: 'No such profile.' }] })));

    expect(s.problems.map((p) => p.fieldId)).toEqual([FIELD.goal, FIELD.attempts, null]);
    expect(s.fieldErrors[FIELD.attempts]).toBeDefined();
    expect(s.status).toBe('problems');
  });

  it('a start error applies only to the input it failed for', async () => {
    const pf = await preflightFor(WITH_GOAL);
    const e = new AppErrorException(errors.runnerUnavailable());
    const base = stateInput(WITH_GOAL, settled(pf));

    const same = deriveNewRunState({ ...base, startError: e, failedKey: base.submitKey });
    const changed = deriveNewRunState({ ...base, startError: e, failedKey: 'another input' });

    expect(same.otherStartError).toBe(e);
    expect(changed.otherStartError).toBeNull();
  });
});
