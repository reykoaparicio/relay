// The run inspector's dialogs (10 J8, SPLIT-01): the cancel / stop confirmation and the action dialogs.
// `useInspectorDialogs` owns which one is open; the page opens them from `trigger` and renders `<InspectorDialogs>` once.
import { useMemo, useState } from 'react';
import type { RefObject } from 'react';
import type { ProfileWithWarnings, ProjectDetail, RunAction, RunDetail, StepView } from '@relay/contracts';
import { ConfirmDialog } from '../../components/ui';
import { RUN_ACTION_LABELS } from '../../lib/format';
import { stepTitle } from './inspector-model';
import type { RunActionRequest } from './run-actions';
import {
  ChooseProfileDialog,
  IncreaseAllowanceDialog,
  ProjectAllowanceDialog,
  RaiseLimitsDialog,
} from './RunActionDialogs';

export type DialogKind = 'allowance' | 'project_allowance' | 'profile' | 'limits';
export type ConfirmKind = 'cancel' | 'stop';

/** FR-11: cancellation of the in-flight request is best effort; a cost the provider does not report is estimated. */
const CONFIRM_COPY: Readonly<Record<ConfirmKind, { title: string; consequences: string }>> = {
  cancel: {
    title: 'Cancel this run?',
    consequences:
      'No new steps will start. Stopping the in-flight request is best effort: the provider may still finish it; if its exact cost is not reported, Relay counts an estimate. Finished steps, artifacts, and costs are kept.',
  },
  stop: {
    title: 'Stop this run?',
    consequences: 'The run ends as cancelled. Finished steps, artifacts, and costs (estimates included) are kept.',
  },
};

export interface InspectorDialogState {
  readonly dialog: DialogKind | null;
  readonly confirm: ConfirmKind | null;
  readonly openDialog: (kind: DialogKind | null) => void;
  readonly askConfirm: (kind: ConfirmKind | null) => void;
}

/** Which inspector dialog is open (at most one of each kind). */
export function useInspectorDialogs(): InspectorDialogState {
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
  return useMemo(() => ({ dialog, confirm, openDialog: setDialog, askConfirm: setConfirm }), [dialog, confirm]);
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
  const { dialog, confirm } = state;
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
    </>
  );
}
