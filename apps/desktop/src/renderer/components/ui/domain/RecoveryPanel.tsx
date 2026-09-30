import { useId, useState } from 'react';
import type { RunAction, RunDetail } from '@relay/contracts';
import { DESTRUCTIVE_RUN_ACTIONS, RUN_ACTION_LABELS } from '../../../lib/format/actions';
import { stepKeyLabel } from '../../../lib/format/labels';
import { Button } from '../Button';
import { ConfirmDialog } from '../Dialog';
import { Money } from '../Money';
import { StatusBadge } from '../StatusBadge';

export interface RecoveryPanelProps {
  readonly run: RunDetail;
  /** Called with one of `run.availableActions`; the page maps it to an IPC op (02 B5 "Run actions"). */
  readonly onDecide: (action: RunAction) => void;
  readonly pendingAction?: RunAction | null;
}

const CONFIRM_TEXT: Partial<Record<RunAction, string>> = {
  cancel: 'The in-flight request finishes first. Finished steps and their costs are kept.',
  stop: 'The run ends now. Finished steps, artifacts, and costs are kept.',
  reject: 'The run stops without producing a patch. Finished steps are kept.',
};

/** Interrupted / unknown-outcome recovery (§4.4): what finished, what is unresolved, and the allowed choices. */
export function RecoveryPanel({ run, onDecide, pendingAction = null }: RecoveryPanelProps) {
  const headingId = useId();
  const [confirming, setConfirming] = useState<RunAction | null>(null);
  const lastDone = [...run.steps].reverse().find((s) => s.state === 'succeeded');
  // The server decides which actions apply (06 F2); the UI never re-derives the rules.
  const actions = run.availableActions.filter((a) => a !== 'export_report' && a !== 'export_patch');

  return (
    <section className="card" aria-labelledby={headingId}>
      <div className="card-header">
        <h2 id={headingId}>Recovery</h2>
        <StatusBadge kind="run" value={run.status} pauseReason={run.pauseReason} showDetail />
      </div>
      <p>
        Last completed step:{' '}
        <strong>{lastDone ? stepKeyLabel(lastDone.stepKey) : 'none yet'}</strong>
      </p>
      {run.unresolvedAttempts.length > 0 ? (
        <div className="stack">
          <h3 className="section-label">Requests with an unknown outcome</h3>
          <ul className="list">
            {run.unresolvedAttempts.map((a) => (
              <li key={a.id} className="list-item" style={{ cursor: 'default' }}>
                <span className="row">
                  <span className="title">
                    {stepKeyLabel(a.stepKey)} · attempt {a.seq}
                  </span>
                  <StatusBadge kind="attempt" value={a.state} />
                </span>
                <span className="meta">
                  Possible charge (liability kept):{' '}
                  {a.cost ? <Money value={a.cost.microusd} certainty={a.cost.certainty} /> : 'amount not known'}
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
        onConfirm={() => {
          const action = confirming;
          setConfirming(null);
          if (action) onDecide(action);
        }}
      />
    </section>
  );
}
