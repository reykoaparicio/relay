import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { appError } from '@relay/contracts';
import type { CapabilityWarning } from '@relay/contracts';
import { createFakeBridge, FAKE_PROJECT_ID, FAKE_WORKFLOW_ID } from '../api/fake-bridge';
import type { FakeBridge } from '../api/fake-bridge';
import { renderApp } from '../features/testing/render-app';

const PATH = `/p/${FAKE_PROJECT_ID}/workflows/${FAKE_WORKFLOW_ID}`;

async function ready() {
  await screen.findByRole('heading', { level: 1, name: 'Workflow editor' });
  return screen.findByRole('list', { name: 'Workflow steps' });
}

describe('WorkflowEditorPage (J10)', () => {
  it('editing: ordered steps, structural controls disabled with the explanation, step detail fields', async () => {
    renderApp(PATH, { scenario: 'awaiting-approval' });
    const steps = await ready();
    expect(within(steps).getAllByRole('button')).toHaveLength(5);
    for (const name of ['Add step', 'Reorder steps', 'Remove step']) {
      const b = screen.getByRole('button', { name });
      expect(b).toHaveAttribute('aria-disabled', 'true');
      expect(b).toHaveAccessibleDescription(/Structural editing arrives in a later release/);
    }
    expect(screen.getAllByText(/New edits affect future runs only/).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { level: 2, name: 'Step 1: Review' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Model profile' })).toHaveValue('Economy');
    expect(screen.getByRole('textbox', { name: 'Expected output schema' })).toHaveAttribute('readonly');
    expect(screen.getByText(/None. Model steps read the selected context/)).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Transport retries' })).toHaveValue(1);
    expect(screen.getByRole('radio', { name: 'Records for all roles' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Only records scoped to Reviewer' })).toBeChecked();
    expect(screen.getByText('Validated', { selector: '.badge' })).toBeInTheDocument();
  });

  it('save draft sends only the changed fields with expectedDraftRevision 0 (no draft yet)', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(PATH, { scenario: 'awaiting-approval' });
    await ready();
    const save = screen.getByRole('button', { name: 'Save draft' });
    expect(save).toBeDisabled();
    const tokens = screen.getByRole('spinbutton', { name: 'Output token maximum' });
    await user.clear(tokens);
    await user.type(tokens, '6000');
    expect(screen.getByText('Draft, unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Step 4: Implement/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model profile' }), 'Balanced');
    const allowance = screen.getByRole('textbox', { name: /Run allowance/ });
    await user.clear(allowance);
    await user.type(allowance, '4.50');
    await user.click(save);
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/workflows.saveDraft')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/workflows.saveDraft')[0]?.input).toEqual({
      workflowId: FAKE_WORKFLOW_ID,
      expectedDraftRevision: 0,
      patch: {
        limits: { budgetMicrousd: 4_500_000 },
        steps: { review: { maxOutputTokens: 6000 }, implement: { profile: 'Balanced' } },
      },
    });
    expect(await screen.findByText('Draft revision 1 saved')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Draft, not validated')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('an existing draft is edited with its draft revision (expectedDraftRevision 1); edited prompts are sent', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(PATH, { scenario: 'workflow-draft' });
    await ready();
    expect(await screen.findByText(/Draft revision 1 · based on v3/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'View and edit prompt' }));
    const prompt = screen.getByRole('textbox', { name: /Reviewer instructions, reviewer.v1/ });
    await user.type(prompt, ' Be brief.');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/workflows.saveDraft')[0]?.input).toMatchObject({
        expectedDraftRevision: 1,
        patch: { prompts: { 'reviewer.v1': expect.stringMatching(/Be brief\.$/) as unknown } },
      });
    });
  });

  it('client bounds: out-of-range values show an error summary and nothing is saved', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(PATH, { scenario: 'awaiting-approval' });
    await ready();
    const retries = screen.getByRole('spinbutton', { name: 'Transport retries' });
    await user.clear(retries);
    await user.type(retries, '9');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent('1 problem prevents saving this draft');
    expect(retries).toHaveAttribute('aria-invalid', 'true');
    expect(bridge.callsTo('relay/v1/workflows.saveDraft')).toHaveLength(0);
  });

  it('validation-errors: Validate → error summary; a link selects the step and focuses the field', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(PATH, { scenario: 'validation-errors' });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent('4 problems prevent draft revision 1 from starting runs');
    expect(summary).toHaveTextContent('Version 3 remains the version used by new runs');
    expect(bridge.callsTo('relay/v1/workflows.validate')[0]?.input).toEqual({ workflowId: FAKE_WORKFLOW_ID, version: 'draft' });
    expect(screen.getByText('4 validation errors')).toBeInTheDocument();
    const implement = screen.getByRole('button', { name: /Step 4: Implement/ });
    expect(implement).toHaveTextContent('2 errors');
    await user.click(within(summary).getByRole('link', { name: /16,000 output tokens exceeds/ }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Step 4: Implement' })).toBeInTheDocument();
    const tokens = screen.getByRole('spinbutton', { name: 'Output token maximum' });
    await waitFor(() => {
      expect(tokens).toHaveFocus();
    });
    expect(tokens).toHaveAttribute('aria-invalid', 'true');
    expect(tokens).toHaveAccessibleDescription(/exceeds the selected model's supported 8,192/);
    await user.click(within(summary).getByRole('link', { name: /an approval step must bind/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Step 3: Approve/ })).toHaveFocus();
    });
    expect(screen.getByRole('button', { name: 'Validate again' })).toBeInTheDocument();
  });

  it('validated: edit → Validate saves then validates → Publish → "v4 validated" with a start-run link', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(PATH, { scenario: 'awaiting-approval' });
    await ready();
    const rev = screen.getByRole('spinbutton', { name: /Revision cycles/ });
    await user.clear(rev);
    await user.type(rev, '3');
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    const publish = await screen.findByRole('button', { name: 'Publish as v4' });
    expect(bridge.callsTo('relay/v1/workflows.saveDraft')[0]?.input).toMatchObject({ patch: { limits: { maxRevisionCycles: 3 } } });
    expect(bridge.callsTo('relay/v1/workflows.validate')[0]?.input).toMatchObject({ version: 'draft' });
    await user.click(publish);
    expect(await screen.findByText(/v4 validated — new runs will snapshot v4; active runs keep their version\./)).toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/workflows.publish')[0]?.input).toEqual({
      workflowId: FAKE_WORKFLOW_ID,
      idempotencyKey: expect.any(String) as unknown,
    });
    expect(screen.getByRole('link', { name: 'Start a run with v4' })).toHaveAttribute('href', `/p/${FAKE_PROJECT_ID}/runs/new`);
    expect(bridge.world.workflows[0]?.latestValidatedVersion).toBe(4);
    await waitFor(() => {
      expect(screen.getByRole('spinbutton', { name: /Revision cycles/ })).toHaveValue(3);
    });
  });

  it('a stale draft revision answers CONFLICT and the edits stay in the form', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(PATH, { scenario: 'awaiting-approval' });
    await ready();
    const tokens = screen.getByRole('spinbutton', { name: 'Output token maximum' });
    await user.clear(tokens);
    await user.type(tokens, '7000');
    bridge.failNext('relay/v1/workflows.saveDraft', appError('CONFLICT'));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('This item changed since it was loaded')).toBeInTheDocument();
    expect(tokens).toHaveValue(7000);
  });

  /** Another session saves draft revision 2 with a different reviewer prompt. */
  function otherSessionSavesDraft(bridge: FakeBridge) {
    bridge.world.workflowVersions = bridge.world.workflowVersions.map((v) =>
      v.version === 'draft'
        ? { ...v, draftRevision: 2, prompts: { ...v.prompts, 'reviewer.v1': { ...v.prompts['reviewer.v1']!, text: 'Changed elsewhere.' } } }
        : v,
    );
  }

  it('B4: a save CONFLICT loads the other session\'s draft, shows what it changed, and re-basing sends only my fields', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(PATH, { scenario: 'workflow-draft' });
    await ready();
    const allowance = screen.getByRole('textbox', { name: /Run allowance/ });
    await user.clear(allowance);
    await user.type(allowance, '4.50');
    otherSessionSavesDraft(bridge);
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/workflows.saveDraft')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/workflows.saveDraft')[0]?.input).toMatchObject({ expectedDraftRevision: 1 });
    expect(await screen.findByText('The draft changed in another session (now draft revision 2)')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Changed in the other session' })).getByText('Review step: prompt')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Changed by you' })).getByText('Run allowance')).toBeInTheDocument();
    expect(allowance).toHaveValue('4.50');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Apply my edits on top of draft revision 2' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/workflows.saveDraft')).toHaveLength(2);
    });
    // Only my field: the other session's prompt is never reverted.
    expect(bridge.callsTo('relay/v1/workflows.saveDraft')[1]?.input).toEqual({
      workflowId: FAKE_WORKFLOW_ID,
      expectedDraftRevision: 2,
      patch: { limits: { budgetMicrousd: 4_500_000 } },
    });
    expect(bridge.world.workflowVersions.find((v) => v.version === 'draft')?.prompts['reviewer.v1']?.text).toBe('Changed elsewhere.');
  });

  it('B4: a refetched newer draft never turns my untouched fields into reverts (save expects my base revision)', async () => {
    const user = userEvent.setup();
    const { bridge, queryClient } = renderApp(PATH, { scenario: 'workflow-draft' });
    await ready();
    const rev = screen.getByRole('spinbutton', { name: /Revision cycles/ });
    await user.clear(rev);
    await user.type(rev, '3');
    otherSessionSavesDraft(bridge);
    await queryClient.invalidateQueries({ queryKey: ['workflow'] });
    expect(await screen.findByText('The draft changed in another session (now draft revision 2)')).toBeInTheDocument();
    expect(rev).toHaveValue(3);
    await user.click(screen.getByRole('button', { name: 'Apply my edits on top of draft revision 2' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/workflows.saveDraft')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/workflows.saveDraft')[0]?.input).toEqual({
      workflowId: FAKE_WORKFLOW_ID,
      expectedDraftRevision: 2,
      patch: { limits: { maxRevisionCycles: 3 } },
    });
  });

  it('B4: Reload after a save CONFLICT refetches the draft (not only the workflow list)', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(PATH, { scenario: 'workflow-draft' });
    await ready();
    const rev = screen.getByRole('spinbutton', { name: /Revision cycles/ });
    await user.clear(rev);
    await user.type(rev, '3');
    bridge.failNext('relay/v1/workflows.saveDraft', appError('CONFLICT'));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('This item changed since it was loaded');
    const before = bridge.callsTo('relay/v1/workflows.get').filter((c) => (c.input as { version?: unknown }).version === 'draft').length;
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/workflows.get').filter((c) => (c.input as { version?: unknown }).version === 'draft').length).toBeGreaterThan(before);
    });
  });

  it('B5: publishing a different draft revision uses a new idempotency key', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(PATH, { scenario: 'awaiting-approval' });
    await ready();
    const rev = screen.getByRole('spinbutton', { name: /Revision cycles/ });
    await user.clear(rev);
    await user.type(rev, '3');
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    bridge.failNext('relay/v1/workflows.publish', appError('RUNNER_UNAVAILABLE'));
    await user.click(await screen.findByRole('button', { name: 'Publish as v4' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/workflows.publish')).toHaveLength(1);
    });
    await user.clear(rev);
    await user.type(rev, '4');
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/workflows.saveDraft')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getByText('Draft revision 2 is valid')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Publish as v4' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/workflows.publish')).toHaveLength(2);
    });
    const keys = bridge.callsTo('relay/v1/workflows.publish').map((c) => (c.input as { idempotencyKey: string }).idempotencyKey);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('B6: Publish is disabled with a reason while the form has unsaved changes', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(PATH, { scenario: 'awaiting-approval' });
    await ready();
    const rev = screen.getByRole('spinbutton', { name: /Revision cycles/ });
    await user.clear(rev);
    await user.type(rev, '3');
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    const publish = await screen.findByRole('button', { name: 'Publish as v4' });
    expect(publish).toBeEnabled();
    await user.clear(rev);
    await user.type(rev, '2');
    expect(publish).toBeDisabled();
    expect(publish).toHaveAccessibleDescription(/Publishing is unavailable while you have unsaved changes/);
    await user.click(publish);
    expect(bridge.callsTo('relay/v1/workflows.publish')).toHaveLength(0);
  });

  it('B7: the published banner carries the validation warnings', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(PATH, { scenario: 'awaiting-approval' });
    await ready();
    bridge.world.workflowWarnings = [
      { stepKey: 'review' as NonNullable<CapabilityWarning['stepKey']>, profileId: null, code: 'output_budget_low', message: 'Review may run out of output tokens.' },
    ];
    const rev = screen.getByRole('spinbutton', { name: /Revision cycles/ });
    await user.clear(rev);
    await user.type(rev, '3');
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    await user.click(await screen.findByRole('button', { name: 'Publish as v4' }));
    const banner = (await screen.findByText(/v4 validated — new runs will snapshot v4/)).closest('.banner') as HTMLElement;
    expect(banner).toHaveTextContent('Review may run out of output tokens.');
    expect(banner).not.toHaveTextContent('No capability warnings');
  });

  it('B14: the run allowance is read-only when limits are locked', async () => {
    const bridge = createFakeBridge('awaiting-approval');
    bridge.world.workflowVersions = bridge.world.workflowVersions.map((v) => ({ ...v, editable: { ...v.editable, limits: false } }));
    renderApp(PATH, { bridge });
    await ready();
    expect(screen.getByRole('textbox', { name: /Run allowance/ })).toHaveAttribute('readonly');
    expect(screen.getByRole('spinbutton', { name: /Revision cycles/ })).toHaveAttribute('readonly');
  });

  it('saveDraft failing (e.g. a future stubbed channel): the generic ErrorView', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(PATH, { scenario: 'awaiting-approval' });
    await ready();
    bridge.world.notImplemented.add('workflows.saveDraft');
    const tokens = screen.getByRole('spinbutton', { name: 'Output token maximum' });
    await user.clear(tokens);
    await user.type(tokens, '7000');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    const alert = (await screen.findByText('This feature is not available in this build yet.')).closest('[role="alert"]') as HTMLElement;
    expect(alert).toHaveTextContent('INTERNAL');
    expect(screen.queryByText(/Not available yet/)).not.toBeInTheDocument();
    expect(tokens).toHaveValue(7000);
  });
});
