import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, MessageSquareText, ShieldCheck, X } from 'lucide-react';
import type { ApprovalDecision, ApprovalView, PlanV1 } from '@relay/contracts';
import { RUN_ACTION_LABELS } from '../../../lib/format/actions';
import { APPROVAL_DECISION_LABELS, PROVIDER_LABELS } from '../../../lib/format/labels';
import { Button } from '../Button';
import { ConfirmDialog } from '../Dialog';
import { Field } from '../Field';
import { Hash } from '../Hash';
import { InlineAlert } from '../InlineAlert';
import { Textarea } from '../Textarea';
import { useFocusRescue } from '../useFocusRescue';
import { PlanBody } from './PlanBody';

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
  /**
   * Decisions the user may make right now (default: all three). A decision left out has no button, so
   * e.g. `['approved', 'rejected']` hides "Request revision" once the revision limit is reached.
   */
  readonly allowedDecisions?: readonly ApprovalDecision[];
  /**
   * Shown inside the revision form above its submit button and announced with it (aria-describedby),
   * e.g. "Revision 2 of 3. Re-planning costs about $0.12."
   */
  readonly revisionNote?: ReactNode;
}

const ALL_DECISIONS: readonly ApprovalDecision[] = ['approved', 'revision_requested', 'rejected'];

const NOTE_MAX = 2000;

/** §11.3 bound approval: plan, file scope, providers, and exactly which hashes the approval covers. */
export function ApprovalCard({
  approval,
  plan,
  onDecide,
  pendingDecision = null,
  allowedDecisions = ALL_DECISIONS,
  revisionNote,
}: ApprovalCardProps) {
  const [isRevising, setIsRevising] = useState(false);
  const [note, setNote] = useState('');
  const [confirmReject, setConfirmReject] = useState(false);
  const headingId = useId();
  const revisionNoteId = useId();
  const allows = (d: ApprovalDecision) => allowedDecisions.includes(d);
  const sectionRef = useRef<HTMLElement>(null);
  // Focus lands here when a decision disables or removes the button that had it (never on <body>).
  const headingRef = useRef<HTMLHeadingElement>(null);
  useFocusRescue(sectionRef, headingRef);
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
    <section ref={sectionRef} className="card" aria-labelledby={headingId}>
      <div className="card-header">
        <h2 id={headingId} ref={headingRef} tabIndex={-1}>Proposed plan</h2>
      </div>
      <PlanBody plan={plan} fileScope={approval.fileScope} />
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
          Decision recorded: {APPROVAL_DECISION_LABELS[recorded]}
        </p>
      ) : (
        <>
          <div className="actions">
            {allows('approved') ? (
              <Button
                variant="primary"
                icon={Check}
                pending={pendingDecision === 'approved'}
                disabled={isBusy}
                onClick={() => { decide('approved'); }}
              >
                {RUN_ACTION_LABELS.approve}
              </Button>
            ) : null}
            {allows('revision_requested') ? (
              <Button
                icon={MessageSquareText}
                aria-expanded={isRevising}
                disabled={isBusy}
                onClick={() => { setIsRevising((v) => !v); }}
              >
                {RUN_ACTION_LABELS.request_revision}
              </Button>
            ) : null}
            {allows('rejected') ? (
              <Button
                variant="danger"
                icon={X}
                pending={pendingDecision === 'rejected'}
                disabled={isBusy}
                onClick={() => { setConfirmReject(true); }}
              >
                {RUN_ACTION_LABELS.reject}
              </Button>
            ) : null}
          </div>
          {isRevising && allows('revision_requested') ? (
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
              {revisionNote === undefined ? null : (
                <div id={revisionNoteId} className="subtle">{revisionNote}</div>
              )}
              <div className="actions">
                <Button
                  type="submit"
                  {...(revisionNote === undefined ? {} : { 'aria-describedby': revisionNoteId })}
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
        confirmLabel={RUN_ACTION_LABELS.reject}
        cancelLabel="Keep reviewing"
        pending={pendingDecision === 'rejected'}
        returnFocusFallback={headingRef}
        onConfirm={() => {
          setConfirmReject(false);
          decide('rejected');
        }}
      />
    </section>
  );
}
