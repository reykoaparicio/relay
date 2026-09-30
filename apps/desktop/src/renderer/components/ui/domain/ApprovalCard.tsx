import { useId, useState } from 'react';
import { Check, MessageSquareText, ShieldCheck, X } from 'lucide-react';
import type { ApprovalDecision, ApprovalView, PlanV1 } from '@relay/contracts';
import { PROVIDER_LABELS } from '../../../lib/format/labels';
import { Button } from '../Button';
import { ConfirmDialog } from '../Dialog';
import { Field } from '../Field';
import { Hash } from '../Hash';
import { InlineAlert } from '../InlineAlert';
import { Textarea } from '../Textarea';

/** approvals.decide input minus the idempotency key (02 B5): the hashes the user saw are echoed back. */
export interface ApprovalDecisionInput {
  readonly approvalId: ApprovalView['id'];
  readonly planHash: string;
  readonly contextHash: string;
  readonly decision: ApprovalDecision;
  readonly note?: string;
}

export interface ApprovalCardProps {
  readonly approval: ApprovalView;
  readonly plan: PlanV1;
  readonly onDecide: (input: ApprovalDecisionInput) => void;
  /** The decision currently being submitted; its button shows pending and the others are disabled. */
  readonly pendingDecision?: ApprovalDecision | null;
}

const NOTE_MAX = 2000;

const DECISION_LABEL: Readonly<Record<ApprovalDecision, string>> = {
  approved: 'approved',
  revision_requested: 'revision requested',
  rejected: 'rejected',
};

function sourceRefText(ref: PlanV1['sourceRefs'][number]): string {
  if (ref.startLine === null) return ref.relPath;
  const end = ref.endLine !== null && ref.endLine !== ref.startLine ? `–${String(ref.endLine)}` : '';
  return `${ref.relPath}:${String(ref.startLine)}${end}`;
}

/** §11.3 bound approval: plan, file scope, providers, and exactly which hashes the approval covers. */
export function ApprovalCard({ approval, plan, onDecide, pendingDecision = null }: ApprovalCardProps) {
  const [isRevising, setIsRevising] = useState(false);
  const [note, setNote] = useState('');
  const [confirmReject, setConfirmReject] = useState(false);
  const headingId = useId();
  const recorded = approval.decision;
  const isBusy = pendingDecision !== null;

  const decide = (decision: ApprovalDecision) => {
    const trimmed = note.trim();
    onDecide({
      approvalId: approval.id,
      planHash: approval.planHash,
      contextHash: approval.contextHash,
      decision,
      ...(decision === 'revision_requested' ? { note: trimmed } : {}),
    });
  };

  return (
    <section className="card" aria-labelledby={headingId}>
      <div className="card-header">
        <h2 id={headingId}>Proposed plan</h2>
      </div>
      <p>{plan.goalRestatement}</p>
      <ol className="list">
        {plan.steps.map((s) => (
          <li key={s.n} className="list-item" style={{ cursor: 'default' }}>
            <span className="title">
              <span className="num">{s.n}.</span> {s.action}
            </span>
            <span className="meta">{s.rationale}</span>
          </li>
        ))}
      </ol>
      <div className="stack">
        <h3 className="section-label">Files the plan may change</h3>
        <ul className="chip-list">
          {approval.fileScope.map((f) => (
            <li key={f} className="chip mono">{f}</li>
          ))}
        </ul>
      </div>
      {plan.sourceRefs.length > 0 ? (
        <div className="stack">
          <h3 className="section-label">Sources</h3>
          <ul className="chip-list">
            {plan.sourceRefs.map((r) => (
              <li key={sourceRefText(r)} className="chip mono">{sourceRefText(r)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {plan.risks.length > 0 ? (
        <div className="stack">
          <h3 className="section-label">Risks</h3>
          <ul className="small">
            {plan.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <InlineAlert tone="info" title="What this approval covers">
        <p>
          Covers plan hash <Hash value={approval.planHash} label="plan hash" /> and context snapshot{' '}
          <Hash value={approval.contextHash} label="context hash" /> only. If either changes, you will be asked again.
        </p>
        <p>
          Providers that will receive this context:{' '}
          {approval.providers.length > 0 ? approval.providers.map((p) => PROVIDER_LABELS[p]).join(', ') : 'none'}
        </p>
      </InlineAlert>
      {recorded !== null ? (
        <p className="row">
          <ShieldCheck aria-hidden="true" width={16} height={16} />
          Decision recorded: {DECISION_LABEL[recorded]}
        </p>
      ) : (
        <>
          <div className="actions">
            <Button
              variant="primary"
              icon={Check}
              pending={pendingDecision === 'approved'}
              disabled={isBusy}
              onClick={() => { decide('approved'); }}
            >
              Approve plan
            </Button>
            <Button
              icon={MessageSquareText}
              aria-expanded={isRevising}
              disabled={isBusy}
              onClick={() => { setIsRevising((v) => !v); }}
            >
              Request revision
            </Button>
            <Button
              variant="danger"
              icon={X}
              pending={pendingDecision === 'rejected'}
              disabled={isBusy}
              onClick={() => { setConfirmReject(true); }}
            >
              Reject
            </Button>
          </div>
          {isRevising ? (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (note.trim() !== '') decide('revision_requested');
              }}
            >
              <Field
                label="What should the planner change?"
                hint="Required. The planner re-runs and you will be asked to approve the new plan."
                required
              >
                {(control) => (
                  <Textarea {...control} value={note} onValueChange={setNote} maxLength={NOTE_MAX} rows={4} />
                )}
              </Field>
              <div className="actions">
                <Button
                  type="submit"
                  pending={pendingDecision === 'revision_requested'}
                  disabled={note.trim() === '' || isBusy}
                >
                  Send revision request
                </Button>
              </div>
            </form>
          ) : null}
        </>
      )}
      <ConfirmDialog
        open={confirmReject}
        onOpenChange={setConfirmReject}
        title="Reject this plan?"
        consequences="The run stops without producing a patch. Finished steps and their costs are kept."
        confirmLabel="Reject plan"
        cancelLabel="Keep reviewing"
        pending={pendingDecision === 'rejected'}
        onConfirm={() => {
          setConfirmReject(false);
          decide('rejected');
        }}
      />
    </section>
  );
}
