import { describe, expect, it } from 'vitest';
import { getOperation, OPERATIONS, RUN_ACTION_OPS, runActionSchema } from '@relay/contracts';
import type { RunAction } from '@relay/contracts';
import { planRunAction, RUN_ACTION_SPECS } from './run-actions';
import type { RunActionRequest } from './run-actions';

const id = (prefix: string, n: number) => `${prefix}_${String(n).padStart(26, '0')}`;
const RUN = id('run', 24);
const APR = id('apr', 1);
const PRJ = id('prj', 1);
const PRF = id('prf', 1);
const STP = id('stp', 1);
const ATT = id('att', 1);
const CHANNELS = new Set<string>(Object.values(OPERATIONS).map((o) => o.channel));

/** One representative request per action. */
const REQUESTS: Record<RunAction, RunActionRequest> = {
  pause: { action: 'pause', runId: RUN },
  cancel: { action: 'cancel', runId: RUN },
  stop: { action: 'stop', runId: RUN },
  resume: { action: 'resume', runId: RUN },
  approve: { action: 'approve', approvalId: APR, planHash: 'a'.repeat(64), contextHash: 'b'.repeat(64) },
  request_revision: { action: 'request_revision', approvalId: APR, planHash: 'a'.repeat(64), contextHash: 'b'.repeat(64), note: 'Smaller scope' },
  reject: { action: 'reject', approvalId: APR, planHash: 'a'.repeat(64), contextHash: 'b'.repeat(64) },
  increase_allowance: { action: 'increase_allowance', runId: RUN, newAllowanceMicrousd: 4_000_000 },
  edit_project_allowance: { action: 'edit_project_allowance', projectId: PRJ, expectedUpdatedAt: 1, monthlyAllowanceMicrousd: 30_000_000 },
  choose_profile: { action: 'choose_profile', runId: RUN, profileId: PRF, step: { id: STP, stepKey: 'implement', state: 'pending' } },
  retry_step: { action: 'retry_step', runId: RUN, stepId: STP },
  raise_limits: { action: 'raise_limits', runId: RUN, maxAttempts: 20 },
  acknowledge_overrun: { action: 'acknowledge_overrun', runId: RUN },
  reconnect_provider: { action: 'reconnect_provider' },
  resnapshot_and_replan: { action: 'resnapshot_and_replan', runId: RUN },
  use_preserved_snapshot: { action: 'use_preserved_snapshot', runId: RUN },
  decide_unknown: { action: 'decide_unknown', runId: RUN, attemptId: ATT, decision: 'mark_failed_keep_liability' },
  review_recovery: { action: 'review_recovery', runId: RUN },
  export_report: { action: 'export_report', runId: RUN },
  export_patch: { action: 'export_patch', runId: RUN },
};

describe('run-actions (10 J2 action → op table)', () => {
  it('is exhaustive over runActionSchema.options', () => {
    expect(Object.keys(RUN_ACTION_SPECS).sort()).toEqual([...runActionSchema.options].sort());
  });

  it('targets only channels present in OPERATIONS, matching contracts RUN_ACTION_OPS', () => {
    for (const action of runActionSchema.options) {
      const { target } = RUN_ACTION_SPECS[action];
      expect(target).toEqual(RUN_ACTION_OPS[action]);
      const channels = target === 'navigate' ? [] : typeof target === 'string' ? [target] : [...target];
      for (const c of channels) expect(CHANNELS.has(c), `${action} → ${c}`).toBe(true);
    }
  });

  it.each(runActionSchema.options)('%s plans a call on its table channel with schema-valid input', (action) => {
    const plan = planRunAction(REQUESTS[action]);
    const target = RUN_ACTION_OPS[action];
    if (plan.kind === 'navigate') {
      expect(target).toBe('navigate');
      expect(plan.to).toBe('/settings/providers');
      return;
    }
    const allowed = typeof target === 'string' ? [target] : [...target];
    expect(allowed).toContain(plan.channel);
    const op = getOperation(plan.channel);
    expect(op?.idempotent).toBe(plan.idempotent);
    const input = plan.idempotent ? { ...plan.input, idempotencyKey: '01J9ZZZZZZZZZZZZZZZZZZZZZZ' } : plan.input;
    const result = op?.input.safeParse(input);
    expect(result?.success, JSON.stringify(result?.error?.issues)).toBe(true);
  });

  it('maps the key rows exactly', () => {
    const call = (a: RunAction) => {
      const p = planRunAction(REQUESTS[a]);
      return p.kind === 'call' ? { channel: p.channel, input: p.input } : p;
    };
    expect(call('stop')).toEqual({ channel: 'relay/v1/runs.cancel', input: { runId: RUN } });
    expect(call('resume')).toEqual({ channel: 'relay/v1/runs.resume', input: { runId: RUN, decision: { kind: 'continue' } } });
    expect(call('acknowledge_overrun')).toEqual({ channel: 'relay/v1/runs.resume', input: { runId: RUN, decision: { kind: 'acknowledge_overrun' } } });
    expect(call('raise_limits')).toEqual({ channel: 'relay/v1/runs.resume', input: { runId: RUN, decision: { kind: 'raise_limits', maxAttempts: 20 } } });
    expect(call('edit_project_allowance')).toEqual({
      channel: 'relay/v1/projects.update',
      input: { projectId: PRJ, expectedUpdatedAt: 1, patch: { monthlyAllowanceMicrousd: 30_000_000 } },
    });
    expect(call('export_patch')).toEqual({ channel: 'relay/v1/artifacts.export', input: { runId: RUN, what: 'patch' } });
    expect(call('request_revision')).toMatchObject({ channel: 'relay/v1/approvals.decide', input: { decision: 'revision_requested', note: 'Smaller scope' } });
  });

  it('choose_profile retries a failed step, otherwise resumes with switch_profile', () => {
    const failed = planRunAction({ action: 'choose_profile', runId: RUN, profileId: 'prf_2', step: { id: 'stp_9', stepKey: 'implement', state: 'failed' } });
    expect(failed).toMatchObject({ channel: 'relay/v1/runs.retryStep', input: { runId: RUN, stepId: 'stp_9', profileId: 'prf_2' } });
    const paused = planRunAction({ action: 'choose_profile', runId: RUN, profileId: 'prf_2', step: { id: 'stp_9', stepKey: 'implement', state: 'ready' } });
    expect(paused).toMatchObject({
      channel: 'relay/v1/runs.resume',
      input: { decision: { kind: 'switch_profile', stepKey: 'implement', profileId: 'prf_2' } },
    });
  });
});
