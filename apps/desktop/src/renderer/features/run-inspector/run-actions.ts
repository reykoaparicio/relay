// Run-action dispatch (10 J2): the single place that turns a `RunAction` from `RunDetail.availableActions` into a
// UI control and an IPC call, following the 02 action→op table (`RUN_ACTION_OPS`). Exhaustive over RUN_ACTIONS:
// adding an action to contracts is a compile error here.
import { RUN_ACTION_OPS } from '@relay/contracts';
import type { Channel, InputOf, RunAction, RunActionTarget, StepState } from '@relay/contracts';
import type { UNKNOWN_OUTCOME_DECISIONS } from '@relay/contracts';
import type { IdemChannel, IntentInput } from '../../hooks/useIdempotentMutation';
import { paths } from '../shell/paths';

/** How an action is presented (10 J2 table). */
export type RunActionControl =
  | 'header_button'
  | 'confirm_dialog'
  | 'approval_card'
  | 'allowance_dialog'
  | 'project_allowance_dialog'
  | 'profile_dialog'
  | 'button'
  | 'limits_dialog'
  | 'overrun_banner_button'
  | 'link'
  | 'recovery_panel';

export interface RunActionSpec {
  readonly control: RunActionControl;
  /** The IPC channel(s), or navigation (from contracts `RUN_ACTION_OPS`). */
  readonly target: RunActionTarget;
}

export const RUN_ACTION_SPECS = {
  pause: { control: 'header_button', target: RUN_ACTION_OPS.pause },
  cancel: { control: 'confirm_dialog', target: RUN_ACTION_OPS.cancel },
  stop: { control: 'confirm_dialog', target: RUN_ACTION_OPS.stop },
  resume: { control: 'button', target: RUN_ACTION_OPS.resume },
  approve: { control: 'approval_card', target: RUN_ACTION_OPS.approve },
  request_revision: { control: 'approval_card', target: RUN_ACTION_OPS.request_revision },
  reject: { control: 'approval_card', target: RUN_ACTION_OPS.reject },
  increase_allowance: { control: 'allowance_dialog', target: RUN_ACTION_OPS.increase_allowance },
  edit_project_allowance: { control: 'project_allowance_dialog', target: RUN_ACTION_OPS.edit_project_allowance },
  choose_profile: { control: 'profile_dialog', target: RUN_ACTION_OPS.choose_profile },
  retry_step: { control: 'button', target: RUN_ACTION_OPS.retry_step },
  raise_limits: { control: 'limits_dialog', target: RUN_ACTION_OPS.raise_limits },
  acknowledge_overrun: { control: 'overrun_banner_button', target: RUN_ACTION_OPS.acknowledge_overrun },
  reconnect_provider: { control: 'link', target: RUN_ACTION_OPS.reconnect_provider },
  resnapshot_and_replan: { control: 'button', target: RUN_ACTION_OPS.resnapshot_and_replan },
  use_preserved_snapshot: { control: 'button', target: RUN_ACTION_OPS.use_preserved_snapshot },
  decide_unknown: { control: 'recovery_panel', target: RUN_ACTION_OPS.decide_unknown },
  review_recovery: { control: 'recovery_panel', target: RUN_ACTION_OPS.review_recovery },
  export_report: { control: 'header_button', target: RUN_ACTION_OPS.export_report },
  export_patch: { control: 'header_button', target: RUN_ACTION_OPS.export_patch },
} as const satisfies Record<RunAction, RunActionSpec>;

export type UnknownOutcomeDecision = (typeof UNKNOWN_OUTCOME_DECISIONS)[number];

/** Parameters the UI collects for each action (dialogs, approval card, recovery panel). */
export type RunActionRequest =
  | { readonly action: 'pause' | 'cancel' | 'stop'; readonly runId: string }
  | { readonly action: 'resume' | 'review_recovery' | 'acknowledge_overrun'; readonly runId: string }
  | { readonly action: 'resnapshot_and_replan' | 'use_preserved_snapshot'; readonly runId: string }
  | {
      readonly action: 'approve' | 'request_revision' | 'reject';
      readonly approvalId: string;
      /** The hashes the user was shown (a mismatch → APPROVAL_STALE, §11.3). */
      readonly planHash: string;
      readonly contextHash: string;
      readonly note?: string;
    }
  | { readonly action: 'increase_allowance'; readonly runId: string; readonly newAllowanceMicrousd: number }
  | {
      readonly action: 'edit_project_allowance';
      readonly projectId: string;
      readonly expectedUpdatedAt: number;
      readonly monthlyAllowanceMicrousd: number | null;
    }
  | {
      readonly action: 'choose_profile';
      readonly runId: string;
      readonly profileId: string;
      readonly step: { readonly id: string; readonly stepKey: string; readonly state: StepState };
    }
  | { readonly action: 'retry_step'; readonly runId: string; readonly stepId: string }
  | {
      readonly action: 'raise_limits';
      readonly runId: string;
      readonly maxAttempts?: number;
      readonly executionTimeoutSeconds?: number;
    }
  | { readonly action: 'reconnect_provider' }
  | {
      readonly action: 'decide_unknown';
      readonly runId: string;
      readonly attemptId: string;
      readonly decision: UnknownOutcomeDecision;
    }
  | { readonly action: 'export_report' | 'export_patch'; readonly runId: string };

type CallPlan<C extends Channel> = C extends IdemChannel
  ? { readonly kind: 'call'; readonly channel: C; readonly idempotent: true; readonly input: IntentInput<C> }
  : { readonly kind: 'call'; readonly channel: C; readonly idempotent: false; readonly input: InputOf<C> };

/** What executing a request means: one IPC call (idempotent ones get their key from the caller), or navigation. */
export type PlannedRunAction = { readonly kind: 'navigate'; readonly to: string } | { [C in Channel]: CallPlan<C> }[Channel];

function idem<C extends IdemChannel>(channel: C, input: IntentInput<C>): PlannedRunAction {
  return { kind: 'call', channel, idempotent: true, input } as unknown as PlannedRunAction;
}

function plain<C extends Exclude<Channel, IdemChannel>>(channel: C, input: InputOf<C>): PlannedRunAction {
  return { kind: 'call', channel, idempotent: false, input } as unknown as PlannedRunAction;
}

const APPROVAL_DECISION = { approve: 'approved', request_revision: 'revision_requested', reject: 'rejected' } as const;

/** Maps a request to its IPC call per the 02 action→op table. */
export function planRunAction(req: RunActionRequest): PlannedRunAction {
  switch (req.action) {
    case 'pause':
      return plain(RUN_ACTION_OPS.pause, { runId: req.runId });
    case 'cancel':
    case 'stop':
      return plain(RUN_ACTION_OPS[req.action], { runId: req.runId });
    case 'resume':
    case 'review_recovery':
      return idem(RUN_ACTION_OPS[req.action], { runId: req.runId, decision: { kind: 'continue' } });
    case 'acknowledge_overrun':
      return idem(RUN_ACTION_OPS.acknowledge_overrun, { runId: req.runId, decision: { kind: 'acknowledge_overrun' } });
    case 'resnapshot_and_replan':
    case 'use_preserved_snapshot':
      return idem(RUN_ACTION_OPS[req.action], { runId: req.runId, decision: { kind: req.action } });
    case 'approve':
    case 'request_revision':
    case 'reject':
      return idem(RUN_ACTION_OPS[req.action], {
        approvalId: req.approvalId,
        planHash: req.planHash,
        contextHash: req.contextHash,
        decision: APPROVAL_DECISION[req.action],
        ...(req.note === undefined ? {} : { note: req.note }),
      });
    case 'increase_allowance':
      return idem(RUN_ACTION_OPS.increase_allowance, { runId: req.runId, newAllowanceMicrousd: req.newAllowanceMicrousd });
    case 'edit_project_allowance':
      return plain(RUN_ACTION_OPS.edit_project_allowance, {
        projectId: req.projectId,
        expectedUpdatedAt: req.expectedUpdatedAt,
        patch: { monthlyAllowanceMicrousd: req.monthlyAllowanceMicrousd },
      });
    case 'choose_profile': {
      const [retryStep, resume] = RUN_ACTION_OPS.choose_profile;
      // A failed step is retried with the new profile; other pauses (budget, setup) switch the profile and resume.
      return req.step.state === 'failed'
        ? idem(retryStep, { runId: req.runId, stepId: req.step.id, profileId: req.profileId })
        : idem(resume, { runId: req.runId, decision: { kind: 'switch_profile', stepKey: req.step.stepKey, profileId: req.profileId } });
    }
    case 'retry_step':
      return idem(RUN_ACTION_OPS.retry_step, { runId: req.runId, stepId: req.stepId });
    case 'raise_limits':
      return idem(RUN_ACTION_OPS.raise_limits, {
        runId: req.runId,
        decision: {
          kind: 'raise_limits',
          ...(req.maxAttempts === undefined ? {} : { maxAttempts: req.maxAttempts }),
          ...(req.executionTimeoutSeconds === undefined ? {} : { executionTimeoutSeconds: req.executionTimeoutSeconds }),
        },
      });
    case 'reconnect_provider':
      return { kind: 'navigate', to: paths.settings('providers') };
    case 'decide_unknown':
      return idem(RUN_ACTION_OPS.decide_unknown, { runId: req.runId, attemptId: req.attemptId, decision: req.decision });
    case 'export_report':
    case 'export_patch':
      return plain(RUN_ACTION_OPS[req.action], { runId: req.runId, what: req.action === 'export_report' ? 'report' : 'patch' });
  }
}
