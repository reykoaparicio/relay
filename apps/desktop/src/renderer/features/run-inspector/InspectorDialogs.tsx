// The run inspector's dialogs (10 J8, SPLIT-01): the cancel / stop confirmation, the five action dialogs, and the
// confirmation of a per-attempt unknown-outcome decision. `useInspectorDialogs` owns which one is open; the page
// opens them from `trigger` and renders `<InspectorDialogs>` once.
import { useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { assertNever } from '@relay/contracts';
import type { ProfileWithWarnings, ProjectDetail, RunAction, RunDetail, StepView } from '@relay/contracts';
import { ConfirmDialog } from '../../components/ui';
import { formatMoney, RUN_ACTION_LABELS, UNKNOWN_OUTCOME_DECISION_HINTS, UNKNOWN_OUTCOME_DECISION_LABELS } from '../../lib/format';
import type { UnknownOutcomeDecision } from '../../lib/format';
import { stepTitle } from './inspector-model';
import type { RunActionRequest } from './run-actions';
import {
  ChooseProfileDialog,
  DecideUnknownDialog,
  IncreaseAllowanceDialog,
  ProjectAllowanceDialog,
  RaiseLimitsDialog,
} from './RunActionDialogs';

export type DialogKind = 'allowance' | 'project_allowance' | 'profile' | 'limits' | 'unknown';
export type ConfirmKind = 'cancel' | 'stop';

/** A per-attempt unknown-outcome decision from the RecoveryPanel, waiting for confirmation. */
export interface UnknownChoice {
  readonly attemptId: string;
  readonly decision: UnknownOutcomeDecision;
}

/** FR-11: cancellation of the in-flight request is best effort; charges may be unknown. */
const CONFIRM_COPY: Readonly<Record<ConfirmKind, { title: string; consequences: string }>> = {
  cancel: {
    title: 'Cancel this run?',
    consequences:
      'No new steps will start. Stopping the in-flight request is best effort: the provider may still finish it, and its charge may stay unknown. Finished steps, artifacts, and costs are kept.',
  },
  stop: {
    title: 'Stop this run?',
    consequences:
      'The run ends as cancelled. Finished steps, artifacts, and costs are kept; any possible charge stays recorded as unknown liability.',
  },
};

/**
 * Confirmation copy of a per-attempt unknown-outcome decision (§4.4: a retry may incur another charge), stating the
 * cost impact with the attempt's possible charge when it is known.
 */
function unknownDecisionCopy(decision: UnknownOutcomeDecision, run: RunDetail, attemptId: string): { title: string; consequences: string; confirmLabel: string } {
  const attempt = run.unresolvedAttempts.find((a) => a.id === attemptId);
  const amount = attempt?.cost === null || attempt?.cost === undefined ? null : formatMoney(attempt.cost.microusd);
  const held = amount === null ? 'The possible charge' : `The possible charge of ${amount}`;
  switch (decision) {
    case 'retry_acknowledging_charge':
      return {
        title: 'Retry this request?',
        consequences: `The retry may incur another charge: the provider may already have processed the earlier request. ${held} stays as unknown liability until it is resolved, and the retry reserves budget for a new request. Run allowance remaining now: ${formatMoney(run.cost.remaining)}.`,
        confirmLabel: UNKNOWN_OUTCOME_DECISION_LABELS[decision],
      };
    case 'mark_failed_keep_liability':
      return {
        title: 'Mark this request as failed?',
        consequences: `The step is marked failed. ${held} stays recorded as unknown liability; nothing is retried.`,
        confirmLabel: UNKNOWN_OUTCOME_DECISION_LABELS[decision],
      };
    case 'accept_estimated_charge':
      return {
        title: amount === null ? 'Accept the estimated charge?' : `Accept ${amount} as the charge?`,
        consequences:
          amount === null
            ? UNKNOWN_OUTCOME_DECISION_HINTS[decision]
            : `${amount} (estimated) is recorded as the charge for this request: it moves from unknown liability to settled usage, so the run total does not change. Nothing is retried.`,
        confirmLabel: amount === null ? UNKNOWN_OUTCOME_DECISION_LABELS[decision] : `Accept ${amount} as the charge`,
      };
    default:
      return assertNever(decision);
  }
}

export interface InspectorDialogState {
  readonly dialog: DialogKind | null;
  readonly confirm: ConfirmKind | null;
  readonly unknownChoice: UnknownChoice | null;
  readonly openDialog: (kind: DialogKind | null) => void;
  readonly askConfirm: (kind: ConfirmKind | null) => void;
  readonly chooseUnknown: (choice: UnknownChoice | null) => void;
}

/** Which inspector dialog is open (at most one of each kind). */
export function useInspectorDialogs(): InspectorDialogState {
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
  const [unknownChoice, setUnknownChoice] = useState<UnknownChoice | null>(null);
  return useMemo(
    () => ({ dialog, confirm, unknownChoice, openDialog: setDialog, askConfirm: setConfirm, chooseUnknown: setUnknownChoice }),
    [dialog, confirm, unknownChoice],
  );
}

export interface InspectorDialogsProps {
  readonly state: InspectorDialogState;
  readonly run: RunDetail;
  readonly projectId: string;
  readonly project: ProjectDetail | undefined;
  /** The step a profile choice applies to (the blocked step). */
  readonly blocked: StepView | undefined;
  readonly permittedProfiles: readonly ProfileWithWarnings[];
  readonly allowedProviderIds: readonly string[] | undefined;
  readonly pending: RunAction | null;
  /** The action error, shown in the open dialog. */
  readonly error: unknown;
  /** Where focus lands when a dialog's opener is gone or disabled (B5). */
  readonly returnFocusFallback: RefObject<HTMLElement | null>;
  /** Runs a request (the confirmations close first). */
  readonly dispatch: (req: RunActionRequest) => Promise<boolean>;
  /** Runs a dialog's request and closes the dialog on success. */
  readonly submitDialog: (req: RunActionRequest) => Promise<void>;
}

export function InspectorDialogs({
  state,
  run,
  projectId,
  project,
  blocked,
  permittedProfiles,
  allowedProviderIds,
  pending,
  error,
  returnFocusFallback,
  dispatch,
  submitDialog,
}: InspectorDialogsProps) {
  const { dialog, confirm, unknownChoice } = state;
  const unknownCopy = unknownChoice === null ? null : unknownDecisionCopy(unknownChoice.decision, run, unknownChoice.attemptId);
  const dialogError = dialog === null ? null : error;
  const onOpenChange = (o: boolean) => {
    if (!o) state.openDialog(null);
  };
  return (
    <>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) state.askConfirm(null);
        }}
        title={confirm === null ? '' : CONFIRM_COPY[confirm].title}
        consequences={confirm === null ? '' : CONFIRM_COPY[confirm].consequences}
        confirmLabel={confirm === null ? 'Confirm' : RUN_ACTION_LABELS[confirm]}
        cancelLabel="Keep the run"
        returnFocusFallback={returnFocusFallback}
        pending={confirm !== null && pending === confirm}
        onConfirm={() => {
          const action = confirm;
          state.askConfirm(null);
          if (action !== null) void dispatch({ action, runId: run.id });
        }}
      />
      {dialog === 'allowance' ? (
        <IncreaseAllowanceDialog
          open
          onOpenChange={onOpenChange}
          returnFocusFallback={returnFocusFallback}
          pending={pending === 'increase_allowance'}
          error={dialogError}
          run={run}
          onSubmit={(value) => {
            void submitDialog({ action: 'increase_allowance', runId: run.id, newAllowanceMicrousd: value });
          }}
        />
      ) : null}
      {dialog === 'project_allowance' ? (
        <ProjectAllowanceDialog
          open
          onOpenChange={onOpenChange}
          returnFocusFallback={returnFocusFallback}
          pending={pending === 'edit_project_allowance'}
          error={dialogError}
          project={project}
          onSubmit={(value, expectedUpdatedAt) => {
            void submitDialog({ action: 'edit_project_allowance', projectId, expectedUpdatedAt, monthlyAllowanceMicrousd: value });
          }}
        />
      ) : null}
      {dialog === 'profile' ? (
        <ChooseProfileDialog
          open
          onOpenChange={onOpenChange}
          returnFocusFallback={returnFocusFallback}
          pending={pending === 'choose_profile'}
          error={dialogError}
          step={blocked}
          profiles={permittedProfiles}
          profileOptions={run.profileOptions}
          allowedProviderIds={allowedProviderIds}
          stepName={blocked === undefined ? undefined : stepTitle(blocked, run.stepMeta)}
          {...(allowedProviderIds?.length === 0
            ? { emptyMessage: 'This project allows no provider, so no profile can be used. Allow a provider in Settings → Projects.' }
            : {})}
          onSubmit={(profileId) => {
            if (blocked !== undefined) {
              void submitDialog({
                action: 'choose_profile',
                runId: run.id,
                profileId,
                step: { id: blocked.id, stepKey: blocked.stepKey, state: blocked.state },
              });
            }
          }}
        />
      ) : null}
      {dialog === 'limits' ? (
        <RaiseLimitsDialog
          open
          onOpenChange={onOpenChange}
          returnFocusFallback={returnFocusFallback}
          pending={pending === 'raise_limits'}
          error={dialogError}
          run={run}
          onSubmit={(limits) => {
            void submitDialog({ action: 'raise_limits', runId: run.id, ...limits });
          }}
        />
      ) : null}
      {dialog === 'unknown' ? (
        <DecideUnknownDialog
          open
          onOpenChange={onOpenChange}
          returnFocusFallback={returnFocusFallback}
          pending={pending === 'decide_unknown'}
          error={dialogError}
          run={run}
          onSubmit={(attemptId, decision) => {
            void submitDialog({ action: 'decide_unknown', runId: run.id, attemptId, decision });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={unknownChoice !== null}
        onOpenChange={(open) => {
          if (!open) state.chooseUnknown(null);
        }}
        title={unknownCopy?.title ?? ''}
        consequences={unknownCopy?.consequences ?? ''}
        confirmLabel={unknownCopy?.confirmLabel ?? 'Confirm'}
        cancelLabel="Not now"
        destructive={false}
        returnFocusFallback={returnFocusFallback}
        pending={unknownChoice !== null && pending === 'decide_unknown'}
        onConfirm={() => {
          const choice = unknownChoice;
          state.chooseUnknown(null);
          if (choice !== null) {
            void dispatch({ action: 'decide_unknown', runId: run.id, attemptId: choice.attemptId, decision: choice.decision });
          }
        }}
      />
    </>
  );
}
