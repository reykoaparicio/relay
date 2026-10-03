import { useId, useRef, useState } from 'react';
import type { RunAction, RunDetail } from '@relay/contracts';
import { DESTRUCTIVE_RUN_ACTIONS, RUN_ACTION_LABELS } from '../../../lib/format/actions';
import { stepName } from '../../../lib/format/labels';
import { statusPresentation } from '../../../lib/format/status-presentation';
import { mayNotHaveBeenCharged, uncertainAttemptsOf } from '../../../lib/format/uncertain';
import { Button } from '../Button';
import { ConfirmDialog } from '../Dialog';
import { Money } from '../Money';
import { StatusBadge } from '../StatusBadge';
import { useFocusRescue } from '../useFocusRescue';

export interface RecoveryPanelProps {
  readonly run: RunDetail;
  /** Called with one of `run.availableActions`; the page maps it to an IPC op (02 B5 "Run actions"). */
  readonly onDecide: (action: RunAction) => void;
  /** The action in flight: its button shows pending and all other buttons are disabled. */
  readonly pendingAction?: RunAction | null;
  /**
   * List the requests that may not have completed, with the estimate counted for each (default). The run inspector's
   * banner already lists them with their request facts, so it turns this off.
   */
  readonly showRequests?: boolean;
}

const CONFIRM_TEXT: Partial<Record<RunAction, string>> = {
  cancel: 'The in-flight request finishes first. Finished steps and their costs are kept.',
  stop: 'The run ends now. Finished steps, artifacts, and costs are kept.',
  reject: 'The run stops without producing a patch. Finished steps are kept.',
};

/** Actions the panel never renders: exports live in the page header; a charge is never "decided" (it is estimated). */
const NOT_IN_PANEL: ReadonlySet<RunAction> = new Set<RunAction>(['export_report', 'export_patch', 'decide_unknown', 'pause']);

/**
 * Interrupted run / a request that may not have completed (§4.4): the last completed step, the estimate Relay counted
 * for each uncertain request, and the allowed choices (from `availableActions`).
 */
export function RecoveryPanel({ run, onDecide, pendingAction = null, showRequests = true }: RecoveryPanelProps) {
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  // Focus lands here when a chosen action disables or removes the button that had it (never on <body>).
  const headingRef = useRef<HTMLHeadingElement>(null);
  useFocusRescue(sectionRef, headingRef);
  const [confirming, setConfirming] = useState<RunAction | null>(null);
  const lastDone = [...run.steps].reverse().find((s) => s.state === 'succeeded');
  const uncertain = uncertainAttemptsOf(run);
  // The server decides which actions apply (06 F2); the UI never re-derives the rules.
  const actions = run.availableActions.filter((a) => !NOT_IN_PANEL.has(a));
  // The status detail sits on its own full-width line under the heading row, so on narrow cards it
  // wraps below "Recovery" instead of being squeezed beside it (no text is truncated).
  const statusDetail = statusPresentation('run', run.status, run.pauseReason).detail;

  return (
    <section ref={sectionRef} className="card" aria-labelledby={headingId}>
      <div className="recovery-header">
        <div className="card-header">
          <h2 id={headingId} ref={headingRef} tabIndex={-1}>Recovery</h2>
          <StatusBadge kind="run" value={run.status} pauseReason={run.pauseReason} />
        </div>
        {statusDetail === undefined ? null : <p className="status-detail">{statusDetail}</p>}
      </div>
      <p>
        Last completed step:{' '}
        <strong>{lastDone ? stepName(lastDone.stepKey, run.stepMeta) : 'none yet'}</strong>
      </p>
      {showRequests && uncertain.length > 0 ? (
        <div className="stack">
          <h3 className="section-label">Requests that may not have completed</h3>
          <ul className="list">
            {uncertain.map((a) => (
              <li key={a.id} className="list-item static">
                <span className="row">
                  <span className="title">
                    {stepName(a.stepKey, run.stepMeta)} · attempt {a.seq}
                  </span>
                </span>
                <span className="meta">
                  Counted toward the budget:{' '}
                  {a.cost === null ? (
                    'no amount recorded'
                  ) : (
                    <Money value={a.cost.microusd} certainty="estimated" mayNotHaveBeenCharged={mayNotHaveBeenCharged(a)} />
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {actions.length > 0 ? (
        <div className="actions">
          {actions.map((action, i) => {
            const isDestructive = DESTRUCTIVE_RUN_ACTIONS.has(action);
            return (
              <Button
                key={action}
                variant={isDestructive ? 'danger' : i === 0 ? 'primary' : 'secondary'}
                pending={pendingAction === action}
                disabled={pendingAction !== null && pendingAction !== action}
                onClick={() => {
                  if (isDestructive) setConfirming(action);
                  else onDecide(action);
                }}
              >
                {RUN_ACTION_LABELS[action]}
              </Button>
            );
          })}
        </div>
      ) : (
        <p className="subtle">No actions are available for this run right now.</p>
      )}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => { if (!open) setConfirming(null); }}
        title={confirming ? `${RUN_ACTION_LABELS[confirming]}?` : ''}
        consequences={confirming ? (CONFIRM_TEXT[confirming] ?? '') : ''}
        confirmLabel={confirming ? RUN_ACTION_LABELS[confirming] : 'Confirm'}
        returnFocusFallback={headingRef}
        onConfirm={() => {
          const action = confirming;
          setConfirming(null);
          if (action) onDecide(action);
        }}
      />
    </section>
  );
}
