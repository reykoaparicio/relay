import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { planV1Schema } from '@relay/contracts';
import type { ApprovalDecision } from '@relay/contracts';
import { approval, plan } from '../test-fixtures';
import { axe, describeViolations, renderWithProviders } from '../test-utils';
import { ApprovalCard } from './ApprovalCard';

describe('ApprovalCard', () => {
  it('renders a PlanV1 fixture that parses with the contracts schema', () => {
    const fixture = plan();

    render(<ApprovalCard approval={approval()} plan={fixture} onDecide={vi.fn()} />);

    expect(planV1Schema.safeParse(fixture).success).toBe(true);
    expect(screen.getByText('Add a schema for the create-user payload')).toBeVisible();
    expect(screen.getByText(fixture.goalRestatement)).toBeVisible();
  });

  it('shows the approver unresolved questions, test suggestions and the findings each step addresses', () => {
    const fixture = { ...plan(), unresolvedQuestions: ['Should 422 include the field path?'] };

    render(<ApprovalCard approval={approval()} plan={fixture} onDecide={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Open questions' })).toBeVisible();
    expect(screen.getByText('Should 422 include the field path?')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Suggested tests (proposed, not executed)' })).toBeVisible();
    expect(screen.getByText('Post an empty body and expect 422')).toBeVisible();
    expect(screen.getByText(/addresses F1/)).toBeVisible();
  });

  it('shows the plan and context hashes the approval covers, with copyable full values', () => {
    const a = approval();

    render(<ApprovalCard approval={a} plan={plan()} onDecide={vi.fn()} />);

    expect(screen.getByText(/Covers plan hash/)).toBeVisible();
    expect(screen.getByTitle(a.planHash)).toHaveTextContent('6f4a…b18c');
    expect(screen.getByTitle(a.contextHash)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy full plan hash' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy full context hash' })).toBeInTheDocument();
  });

  it('requires a note before a revision can be requested', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    const a = approval();
    render(<ApprovalCard approval={a} plan={plan()} onDecide={onDecide} />);

    await user.click(screen.getByRole('button', { name: 'Request revision' }));
    const send = screen.getByRole('button', { name: 'Send revision request' });

    expect(send).toBeDisabled();

    await user.type(screen.getByLabelText(/What should the planner change/), '   ');
    expect(send).toBeDisabled();

    await user.type(screen.getByLabelText(/What should the planner change/), 'Keep status 422');
    expect(send).toBeEnabled();

    await user.click(send);
    expect(onDecide).toHaveBeenCalledWith({
      approvalId: a.id,
      planHash: a.planHash,
      contextHash: a.contextHash,
      decision: 'revision_requested',
      note: 'Keep status 422',
    });
  });

  it('echoes the hashes the user saw when approving', async () => {
    const onDecide = vi.fn();
    const a = approval();
    render(<ApprovalCard approval={a} plan={plan()} onDecide={onDecide} />);

    await userEvent.click(screen.getByRole('button', { name: 'Approve plan' }));

    expect(onDecide).toHaveBeenCalledWith({ approvalId: a.id, planHash: a.planHash, contextHash: a.contextHash, decision: 'approved' });
  });

  it('confirms before rejecting (destructive)', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(<ApprovalCard approval={approval()} plan={plan()} onDecide={onDecide} />);

    await user.click(screen.getByRole('button', { name: 'Reject plan' }));

    expect(onDecide).not.toHaveBeenCalled();
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reject plan' }));
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ decision: 'rejected' }));
  });

  it('shows the pending state on the submitted decision and disables the others', () => {
    render(<ApprovalCard approval={approval()} plan={plan()} onDecide={vi.fn()} pendingDecision="approved" />);

    expect(screen.getByRole('button', { name: 'Approve plan' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Reject plan' })).toBeDisabled();
  });

  it('keeps focus in the card (not <body>) after confirming a reject that disables the opener @a11y', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [pending, setPending] = useState<ApprovalDecision | null>(null);
      return <ApprovalCard approval={approval()} plan={plan()} onDecide={(d) => { setPending(d.decision); }} pendingDecision={pending} />;
    }
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Reject plan' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reject plan' }));

    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    await waitFor(() => { expect(document.activeElement).not.toBe(document.body); });
    expect(screen.getByRole('heading', { name: 'Proposed plan' })).toHaveFocus();
  });

  it('moves focus to the heading when the decision turns pending only after focus returned', async () => {
    const user = userEvent.setup();
    let setPendingLater: (d: ApprovalDecision) => void = () => undefined;
    function Harness() {
      const [pending, setPending] = useState<ApprovalDecision | null>(null);
      setPendingLater = setPending;
      return <ApprovalCard approval={approval()} plan={plan()} onDecide={vi.fn()} pendingDecision={pending} />;
    }
    render(<Harness />);
    const reject = screen.getByRole('button', { name: 'Reject plan' });
    await user.click(reject);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reject plan' }));
    await waitFor(() => { expect(reject).toHaveFocus(); });

    act(() => { setPendingLater('rejected'); });

    expect(screen.getByRole('heading', { name: 'Proposed plan' })).toHaveFocus();
  });

  it('hides the decisions that are not allowed', () => {
    render(<ApprovalCard approval={approval()} plan={plan()} onDecide={vi.fn()} allowedDecisions={['approved', 'rejected']} />);

    expect(screen.getByRole('button', { name: 'Approve plan' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reject plan' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Request revision' })).toBeNull();
  });

  it('can offer revision only (no approve or reject buttons)', () => {
    render(<ApprovalCard approval={approval()} plan={plan()} onDecide={vi.fn()} allowedDecisions={['revision_requested']} />);

    expect(screen.getByRole('button', { name: 'Request revision' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject plan' })).toBeNull();
  });

  it('shows the revision note in the revision form and ties it to the submit button', async () => {
    const user = userEvent.setup();
    render(
      <ApprovalCard
        approval={approval()}
        plan={plan()}
        onDecide={vi.fn()}
        revisionNote="Revision 2 of 3. Re-planning costs about $0.12."
      />,
    );

    expect(screen.queryByText(/Revision 2 of 3/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Request revision' }));

    const note = screen.getByText('Revision 2 of 3. Re-planning costs about $0.12.');
    expect(note).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send revision request' })).toHaveAccessibleDescription(
      'Revision 2 of 3. Re-planning costs about $0.12.',
    );
  });

  it('has no axe violations with the revision form and note open @a11y', async () => {
    const user = userEvent.setup();
    const { baseElement } = renderWithProviders(
      <main>
        <ApprovalCard approval={approval()} plan={plan()} onDecide={vi.fn()} revisionNote="Revision 2 of 3." allowedDecisions={['approved', 'revision_requested']} />
      </main>,
    );
    await user.click(screen.getByRole('button', { name: 'Request revision' }));

    expect(describeViolations(await axe(baseElement))).toEqual([]);
  });
});
