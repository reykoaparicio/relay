import { useId, useRef, useState } from 'react';
import { UNKNOWN_OUTCOME_DECISIONS } from '@relay/contracts';
import type { RunAction, RunDetail } from '@relay/contracts';
import {
  DESTRUCTIVE_RUN_ACTIONS,
  RUN_ACTION_LABELS,
  UNKNOWN_OUTCOME_DECISION_HINTS,
  UNKNOWN_OUTCOME_DECISION_LABELS,
} from '../../../lib/format/actions';
import type { UnknownOutcomeDecision } from '../../../lib/format/actions';
import { stepName } from '../../../lib/format/labels';
import { formatMoney } from '../../../lib/format/money';
import { statusPresentation } from '../../../lib/format/status-presentation';
import { Button } from '../Button';
import { ConfirmDialog } from '../Dialog';
import { Money } from '../Money';
import { StatusBadge } from '../StatusBadge';
import { useFocusRescue } from '../useFocusRescue';

/** The attempt-level choice behind a `decide_unknown` (→ `runs.decideUnknown { attemptId, decision }`). */
export interface RecoveryDecisionDetail {
  readonly attemptId?: string;
  readonly decision?: UnknownOutcomeDecision;
}

export interface RecoveryPanelProps {
  readonly run: RunDetail;
  /**
   * Called with one of `run.availableActions`; the page maps it to an IPC op (02 B5 "Run actions").
   * A per-attempt row button calls `onDecide('decide_unknown', { attemptId, decision })`; every other
   * button calls it with the action only (so a `(action) => void` handler keeps working).
   */
  readonly onDecide: (action: RunAction, detail?: RecoveryDecisionDetail) => void;
  /** The action in flight: its button shows pending and all other buttons are disabled. */
  readonly pendingAction?: RunAction | null;
  /**
   * Opt-in per-attempt decisions: while `decide_unknown` is available, each unresolved attempt row gets
   * one button per listed decision (pass contracts `UNKNOWN_OUTCOME_DECISIONS` for all three; "accept
   * the estimated charge" only appears on attempts that have an amount) and the single "Decide on
   * unknown charge" button is dropped. Default `[]` keeps that single button (existing callers).
   */
  readonly attemptDecisions?: readonly UnknownOutcomeDecision[];
}

const NO_ATTEMPT_DECISIONS: readonly UnknownOutcomeDecision[] = [];

interface AttemptChoice {
  readonly attemptId: string;
  readonly decision: UnknownOutcomeDecision;
}

const CONFIRM_TEXT: Partial<Record<RunAction, string>> = {
  cancel: 'The in-flight request finishes first. Finished steps and their costs are kept.',
  stop: 'The run ends now. Finished steps, artifacts, and costs are kept.',
  reject: 'The run stops without producing a patch. Finished steps are kept.',
};

/** Interrupted / unknown-outcome recovery (§4.4): what finished, what is unresolved, and the allowed choices. */
export function RecoveryPanel({
  run,
  onDecide,
  pendingAction = null,
  attemptDecisions = NO_ATTEMPT_DECISIONS,
}: RecoveryPanelProps) {
  const headingId = useId();
  const rowIdPrefix = useId();
  const sectionRef = useRef<HTMLElement>(null);
  // Focus lands here when a chosen action disables or removes the button that had it (never on <body>).
  const headingRef = useRef<HTMLHeadingElement>(null);
  useFocusRescue(sectionRef, headingRef);
  const [confirming, setConfirming] = useState<RunAction | null>(null);
  // The row button that started the in-flight `decide_unknown` (shows its spinner while pending).
  const [lastChoice, setLastChoice] = useState<AttemptChoice | null>(null);
  const lastDone = [...run.steps].reverse().find((s) => s.state === 'succeeded');
  // The server decides which actions apply (06 F2); the UI never re-derives the rules.
  const perAttempt =
    attemptDecisions.length > 0 && run.availableActions.includes('decide_unknown') && run.unresolvedAttempts.length > 0;
  const actions = run.availableActions.filter(
    (a) => a !== 'export_report' && a !== 'export_patch' && !(perAttempt && a === 'decide_unknown'),
  );
  const offered = UNKNOWN_OUTCOME_DECISIONS.filter((d) => attemptDecisions.includes(d));
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
      {run.unresolvedAttempts.length > 0 ? (
        <div className="stack">
          <h3 className="section-label">Requests with an unknown outcome</h3>
          <ul className="list">
            {run.unresolvedAttempts.map((a) => {
              const titleId = `${rowIdPrefix}-${a.id}`;
              return (
                <li key={a.id} className="list-item static">
                  <span className="row">
                    <span className="title" id={titleId}>
                      {stepName(a.stepKey, run.stepMeta)} · attempt {a.seq}
                    </span>
                    <StatusBadge kind="attempt" value={a.state} />
                  </span>
                  <span className="meta">
                    Possible charge (liability kept):{' '}
                    {a.cost ? <Money value={a.cost.microusd} certainty={a.cost.certainty} /> : 'amount not known'}
                  </span>
                  {perAttempt ? (
                    <div className="actions" role="group" aria-labelledby={titleId}>
                      {offered
                        .filter((d) => d !== 'accept_estimated_charge' || a.cost !== null)
                        .map((decision) => (
                          <Button
                            key={decision}
                            size="sm"
                            aria-describedby={titleId}
                            pending={
                              pendingAction === 'decide_unknown' &&
                              lastChoice?.attemptId === a.id &&
                              lastChoice.decision === decision
                            }
                            disabled={pendingAction !== null}
                            onClick={() => {
                              setLastChoice({ attemptId: a.id, decision });
                              onDecide('decide_unknown', { attemptId: a.id, decision });
                            }}
                          >
                            {decision === 'accept_estimated_charge' && a.cost !== null
                              ? `Accept ${formatMoney(a.cost.microusd)} as the charge`
                              : UNKNOWN_OUTCOME_DECISION_LABELS[decision]}
                          </Button>
                        ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {perAttempt ? (
            <ul className="subtle">
              {offered.map((d) => (
                <li key={d}>
                  <strong>{UNKNOWN_OUTCOME_DECISION_LABELS[d]}:</strong> {UNKNOWN_OUTCOME_DECISION_HINTS[d]}
                </li>
              ))}
            </ul>
          ) : null}
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
