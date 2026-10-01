import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { appError } from '@relay/contracts';
import { FAKE_PROJECT_ID } from '../api/fake-bridge';
import { sid } from '../api/fake-scenarios/world';
import { renderApp } from '../features/testing/render-app';

const P = `/p/${FAKE_PROJECT_ID}/memory`;
const M = (n: number) => sid('memory', n);

async function detail(title: string) {
  return (await screen.findByRole('heading', { level: 2, name: title })).closest('section') as HTMLElement;
}

describe('MemoryPage (J9)', () => {
  it('approved: tabs with counts, list, and a detail panel with type, scope, status, pinned and revisions', async () => {
    renderApp(P, { scenario: 'awaiting-approval' });
    await screen.findByRole('heading', { level: 1, name: 'Project memory' });
    expect(await screen.findByRole('tab', { name: /Approved \(8\)/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Suggested \(2\)/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Archived \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: '2 suggested memories need review' })).toBeInTheDocument();
    const panel = await detail('Preserve the existing public response format');
    expect(within(panel).getByText('User rule', { selector: 'dd' })).toBeInTheDocument();
    expect(within(panel).getByText('This project only / All workflow roles')).toBeInTheDocument();
    expect(within(panel).getByText(/Revision 1 \/ No expiry/)).toBeInTheDocument();
    expect(within(panel).getByRole('checkbox', { name: /Pinned: always included in runs/ })).toBeChecked();
    expect(within(panel).getByText('None scheduled')).toBeInTheDocument();
    expect(within(panel).getByText(/rev 1/)).toBeInTheDocument();
    expect(within(panel).getByText('No secrets or provider credentials belong in memory.')).toBeInTheDocument();
  });

  it('selecting a record updates ?record=; the pinned toggle sends memory.update with the expected revision', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp(P, { scenario: 'awaiting-approval' });
    await user.click(await screen.findByRole('button', { name: /Validate request bodies with zod/ }));
    expect(router.state.location.search).toContain(`record=${M(2)}`);
    const panel = await detail('Validate request bodies with zod');
    await user.click(within(panel).getByRole('checkbox', { name: /Pinned/ }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.update')[0]?.input).toEqual({ recordId: M(2), expectedRevision: 1, pinned: true });
    });
    await waitFor(() => {
      expect(within(panel).getByRole('checkbox', { name: /Pinned/ })).toBeChecked();
    });
  });

  it('superseded: an archived record links to the record that replaced it', async () => {
    const user = userEvent.setup();
    const { router } = renderApp(`${P}?tab=archived`, { scenario: 'awaiting-approval' });
    const panel = await detail('Validate with express-validator');
    const link = await within(panel).findByRole('link', { name: 'Validate request bodies with zod' });
    expect(within(panel).getByText(/Superseded by/)).toBeInTheDocument();
    await user.click(link);
    await waitFor(() => {
      expect(router.state.location.search).toContain('tab=approved');
    });
    expect(router.state.location.search).toContain(`record=${M(2)}`);
    expect(await detail('Validate request bodies with zod')).toBeInTheDocument();
  });

  it('edit: shows the revision note and sends memory.update with expectedRevision and only the changed fields', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(`${P}?record=${M(3)}`, { scenario: 'awaiting-approval' });
    const panel = await detail('Return 422 for invalid input');
    await user.click(within(panel).getByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Edit: Return 422 for invalid input' })).toBeInTheDocument();
    expect(screen.getByText('Saving creates revision 2; runs that already used revision 1 keep it.')).toBeInTheDocument();
    const content = screen.getByRole('textbox', { name: /Content/ });
    await user.clear(content);
    await user.type(content, 'Validation failures return HTTP 422.');
    await user.click(screen.getByRole('button', { name: 'Save revision 2' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.update')[0]?.input).toEqual({
        recordId: M(3),
        expectedRevision: 1,
        content: 'Validation failures return HTTP 422.',
      });
    });
    expect(await screen.findByText('Saved revision 2')).toBeInTheDocument();
    const after = await detail('Return 422 for invalid input');
    expect(within(after).getByText(/rev 2/)).toBeInTheDocument();
  });

  it('B2 edit conflict: compares saved vs mine field by field; save over sends only my changed fields', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(`${P}?record=${M(3)}`, { scenario: 'awaiting-approval' });
    const panel = await detail('Return 422 for invalid input');
    await user.click(within(panel).getByRole('button', { name: 'Edit' }));
    // Someone else saved revision 2 meanwhile: a new title, the same content.
    bridge.world.memory = bridge.world.memory.map((m) =>
      m.id === M(3)
        ? { ...m, currentRevision: 2, title: 'Invalid input → 422', revisions: [...m.revisions, { ...m.revisions[0]!, revision: 2, title: 'Invalid input → 422' }] }
        : m,
    );
    const content = screen.getByRole('textbox', { name: /Content/ });
    await user.clear(content);
    await user.type(content, 'Mine.');
    await user.click(screen.getByRole('button', { name: 'Save revision 2' }));
    expect(await screen.findByText(/This record changed since you opened it \(now revision 2\)/)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Saved revision compared with your edit' });
    const titleRow = within(table).getByRole('row', { name: /^Title/ });
    expect(titleRow).toHaveTextContent('Invalid input → 422');
    expect(titleRow).toHaveTextContent('Another session');
    const contentRow = within(table).getByRole('row', { name: /^Content/ });
    expect(contentRow).toHaveTextContent('Mine.');
    expect(contentRow).toHaveTextContent('You');
    expect(screen.queryByText('Loading the saved version…')).not.toBeInTheDocument();
    expect(content).toHaveValue('Mine.');
    await user.click(screen.getByRole('button', { name: 'Keep my changes and save over revision 2' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.update')).toHaveLength(2);
    });
    // The other session's title is not reverted: only my content is sent.
    expect(bridge.callsTo('relay/v1/memory.update')[1]?.input).toEqual({ recordId: M(3), expectedRevision: 2, content: 'Mine.' });
    expect(bridge.world.memory.find((m) => m.id === M(3))?.title).toBe('Invalid input → 422');
  });

  it('B1: Approve of a suggestion that conflicts with an approved record routes to Combine (no reload loop)', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(`${P}?tab=suggested`, { scenario: 'memory-conflict' });
    const card = (await screen.findByRole('heading', { level: 3, name: 'Validate with hand-written checks' })).closest('article') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(await within(card).findByText('Conflicts with “Validate request bodies with zod”')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
    expect(within(card).queryByText(/changed since/)).not.toBeInTheDocument();
    expect(bridge.world.memory.find((m) => m.id === M(10))?.status).toBe('suggested');
    await user.click(within(card).getByRole('button', { name: 'Combine with “Validate request bodies with zod”' }));
    const panel = (await screen.findByRole('heading', { level: 2, name: /Combine “Validate with hand-written checks”/ })).closest('section') as HTMLElement;
    expect(within(panel).getByRole('combobox', { name: 'Approved record to combine with' })).toHaveValue(M(2));
  });

  it('B1: Edit then approve with a conflict shows the conflicting title, never "Loading the saved version…"', async () => {
    const user = userEvent.setup();
    renderApp(`${P}?tab=suggested`, { scenario: 'memory-conflict' });
    const card = (await screen.findByRole('heading', { level: 3, name: 'Validate with hand-written checks' })).closest('article') as HTMLElement;
    await waitFor(() => {
      expect(within(card).getByRole('button', { name: 'Edit then approve' })).toBeEnabled();
    });
    await user.click(within(card).getByRole('button', { name: 'Edit then approve' }));
    await user.click(within(card).getByRole('button', { name: 'Approve edited text' }));
    expect(await within(card).findByText('Conflicts with “Validate request bodies with zod”')).toBeInTheDocument();
    expect(within(card).queryByText('Loading the saved version…')).not.toBeInTheDocument();
    expect(within(card).queryByText(/This record changed since you opened it/)).not.toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Combine with “Validate request bodies with zod”' }));
    expect(await screen.findByRole('heading', { level: 2, name: /Combine “Validate with hand-written checks”/ })).toBeInTheDocument();
  });

  it('B10: after adding a rule the dialog reopens empty, and closing after an error starts a new intent', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(P, { scenario: 'awaiting-approval' });
    await screen.findByRole('heading', { level: 1, name: 'Project memory' });
    const open = async () => {
      await user.click(screen.getAllByRole('button', { name: 'Add project rule' })[0]!);
      return screen.findByRole('dialog', { name: 'Add project rule' });
    };
    let dialog = await open();
    await user.type(within(dialog).getByRole('textbox', { name: /Title/ }), 'Use UTC timestamps');
    await user.type(within(dialog).getByRole('textbox', { name: /Rule/ }), 'Store timestamps in UTC.');
    bridge.failNext('relay/v1/memory.create', appError('RUNNER_UNAVAILABLE'));
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.create')).toHaveLength(1);
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    dialog = await open();
    expect(within(dialog).getByRole('textbox', { name: /Title/ })).toHaveValue('');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /Title/ }), 'Use UTC timestamps');
    await user.type(within(dialog).getByRole('textbox', { name: /Rule/ }), 'Store timestamps in UTC.');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.create')).toHaveLength(2);
    });
    const keys = bridge.callsTo('relay/v1/memory.create').map((c) => (c.input as { idempotencyKey: string }).idempotencyKey);
    expect(keys[1]).not.toBe(keys[0]);
    expect(await detail('Use UTC timestamps')).toBeInTheDocument();
    dialog = await open();
    expect(within(dialog).getByRole('textbox', { name: /Title/ })).toHaveValue('');
    expect(within(dialog).getByRole('textbox', { name: /Rule/ })).toHaveValue('');
  });

  async function openCombine(user: ReturnType<typeof userEvent.setup>) {
    const banner = (await screen.findByText('Two records give incompatible instructions')).closest('.banner') as HTMLElement;
    await user.click(within(banner).getByRole('button', { name: 'Resolve conflict' }));
    const panel = (await screen.findByRole('heading', { level: 2, name: 'Resolve conflict' })).closest('section') as HTMLElement;
    await user.click(within(panel).getByRole('radio', { name: 'Combine into a new record' }));
    await user.click(within(panel).getByRole('button', { name: 'Resolve conflict' }));
    return panel;
  }

  it('B11: every validation issue is shown while combining (unmapped paths in a summary)', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(P, { scenario: 'memory-conflict' });
    const panel = await openCombine(user);
    bridge.failNext(
      'relay/v1/memory.resolveConflict',
      appError('VALIDATION_FAILED', {
        details: {
          issues: [
            { path: 'resolution.rewrite.title', message: 'Title is too long.', code: 'too_big' },
            { path: 'resolution.rewrite.scope', message: 'Scope must name a role.', code: 'custom' },
            { path: 'recordIds', message: 'A record was archived meanwhile.', code: 'custom' },
          ],
        },
      }),
    );
    await user.click(within(panel).getByRole('button', { name: 'Apply resolution' }));
    expect(await within(panel).findByText('Scope must name a role.')).toBeInTheDocument();
    expect(within(panel).getByText('A record was archived meanwhile.')).toBeInTheDocument();
    expect(within(panel).getByText('Title is too long.')).toBeInTheDocument();
  });

  it('B12: Combine keeps the pin by default when either record is pinned and sends rewrite.pinned', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(P, { scenario: 'memory-conflict' });
    bridge.world.memory = bridge.world.memory.map((m) => (m.id === M(2) ? { ...m, pinned: true } : m));
    const panel = await openCombine(user);
    const keep = within(panel).getByRole('checkbox', { name: /Keep pinned/ });
    expect(keep).toBeChecked();
    await user.click(within(panel).getByRole('button', { name: 'Apply resolution' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.resolveConflict')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/memory.resolveConflict')[0]?.input).toMatchObject({ resolution: { rewrite: { pinned: true } } });
  });

  it('B12: Combine of two unpinned records sends pinned: false unless the user ticks Keep pinned', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(P, { scenario: 'memory-conflict' });
    const panel = await openCombine(user);
    expect(within(panel).getByRole('checkbox', { name: /Keep pinned/ })).not.toBeChecked();
    await user.click(within(panel).getByRole('button', { name: 'Apply resolution' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.resolveConflict')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/memory.resolveConflict')[0]?.input).toMatchObject({ resolution: { rewrite: { pinned: false } } });
  });

  it('delete-confirm: explains the consequences and deletes with confirm: true', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(`${P}?record=${M(4)}`, { scenario: 'awaiting-approval' });
    const panel = await detail('Keep handlers thin');
    await user.click(within(panel).getByRole('button', { name: 'Delete…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete “Keep handlers thin”?' });
    expect(dialog).toHaveTextContent(/removed from retrieval immediately/);
    expect(dialog).toHaveTextContent(/snapshots of 3 runs keep their copies/);
    expect(within(dialog).getByRole('link', { name: 'Purge project history' })).toHaveAttribute('href', `/settings/data?project=${FAKE_PROJECT_ID}`);
    expect(within(dialog).getByRole('button', { name: 'Archive instead' })).toBeInTheDocument();
    expect(bridge.callsTo('relay/v1/memory.delete')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete record from future runs' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.delete')[0]?.input).toEqual({ recordId: M(4), confirm: true });
    });
    expect(await screen.findByText('Deleted “Keep handlers thin”')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Keep handlers thin/ })).not.toBeInTheDocument();
    });
  });

  it('archive and "archive instead" call memory.archive', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(`${P}?record=${M(5)}`, { scenario: 'awaiting-approval' });
    const panel = await detail('Use the shared error helper');
    await user.click(within(panel).getByRole('button', { name: 'Delete…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete “Use the shared error helper”?' });
    await user.click(within(dialog).getByRole('button', { name: 'Archive instead' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.archive')[0]?.input).toEqual({ recordId: M(5) });
    });
    expect(bridge.callsTo('relay/v1/memory.delete')).toHaveLength(0);
    expect(await screen.findByRole('tab', { name: /Archived \(2\)/ })).toBeInTheDocument();
  });

  it('add project rule: memory.create (idempotent) and the new record is selected', async () => {
    const user = userEvent.setup();
    const { bridge, router } = renderApp(P, { scenario: 'awaiting-approval' });
    await screen.findByRole('heading', { level: 1, name: 'Project memory' });
    await user.click(screen.getAllByRole('button', { name: 'Add project rule' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add project rule' });
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    expect(within(dialog).getByText('Enter a short title.')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /Title/ }), 'Use UTC timestamps');
    await user.type(within(dialog).getByRole('textbox', { name: /Rule/ }), 'Store and return timestamps in UTC.');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Scope' }), 'implementer');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.create')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/memory.create')[0]?.input).toMatchObject({
      projectId: FAKE_PROJECT_ID,
      type: 'user_rule',
      title: 'Use UTC timestamps',
      content: 'Store and return timestamps in UTC.',
      scope: { roles: ['implementer'] },
      idempotencyKey: expect.any(String) as unknown,
    });
    expect(await detail('Use UTC timestamps')).toBeInTheDocument();
    expect(router.state.location.search).toContain('record=');
  });

  it('suggestions: Approve sends the expected revision (and a changed scope); Reject calls memory.reject', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(`${P}?tab=suggested`, { scenario: 'awaiting-approval' });
    const card = (await screen.findByRole('heading', { level: 3, name: 'Log request IDs on every error' })).closest('article') as HTMLElement;
    expect(within(card).getByText('Suggested, not used by runs')).toBeInTheDocument();
    expect(await within(card).findByText('The verifier asked for this in two separate runs.')).toBeInTheDocument();
    await user.selectOptions(within(card).getByRole('combobox', { name: 'Scope' }), 'reviewer');
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.approve')[0]?.input).toEqual({
        suggestionId: M(9),
        expectedRevision: 1,
        scope: { roles: ['reviewer'] },
      });
    });
    const other = (await screen.findByRole('heading', { level: 3, name: 'Validate with hand-written checks' })).closest('article') as HTMLElement;
    await user.click(within(other).getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.reject')[0]?.input).toEqual({ suggestionId: M(10) });
    });
    expect(await screen.findByText('No suggestions to review')).toBeInTheDocument();
  });

  it('suggestions: Edit then approve sends finalContent with the expected revision', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(`${P}?tab=suggested`, { scenario: 'awaiting-approval' });
    const card = (await screen.findByRole('heading', { level: 3, name: 'Log request IDs on every error' })).closest('article') as HTMLElement;
    await waitFor(() => {
      expect(within(card).getByRole('button', { name: 'Edit then approve' })).toBeEnabled();
    });
    await user.click(within(card).getByRole('button', { name: 'Edit then approve' }));
    const content = within(card).getByRole('textbox', { name: /Content/ });
    await user.clear(content);
    await user.type(content, 'Every error response includes the request ID.');
    await user.click(within(card).getByRole('button', { name: 'Approve edited text' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.approve')[0]?.input).toEqual({
        suggestionId: M(9),
        expectedRevision: 1,
        finalContent: 'Every error response includes the request ID.',
      });
    });
  });

  it('Combine on a suggestion → ConflictCompare → memory.resolveConflict([suggestionId, approvedId], rewrite)', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(`${P}?tab=suggested`, { scenario: 'awaiting-approval' });
    const card = (await screen.findByRole('heading', { level: 3, name: 'Validate with hand-written checks' })).closest('article') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Combine with existing…' }));
    const panel = (await screen.findByRole('heading', { level: 2, name: /Combine “Validate with hand-written checks”/ })).closest('section') as HTMLElement;
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Approved record to combine with' }), M(2));
    expect(await within(panel).findByRole('heading', { level: 3, name: 'Validate request bodies with zod' })).toBeInTheDocument();
    await user.click(within(panel).getByRole('radio', { name: 'Combine into a new record' }));
    await user.click(within(panel).getByRole('button', { name: 'Resolve conflict' }));
    const title = within(panel).getByRole('textbox', { name: /Title/ });
    await user.clear(title);
    await user.type(title, 'Validation approach');
    const text = within(panel).getByRole('textbox', { name: /Rewritten text/ });
    await user.clear(text);
    await user.type(text, 'Use the shared zod schemas; small hand-written checks are fine for path params.');
    await user.click(within(panel).getByRole('button', { name: 'Apply resolution' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.resolveConflict')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/memory.resolveConflict')[0]?.input).toMatchObject({
      idempotencyKey: expect.any(String) as unknown,
      recordIds: [M(10), M(2)],
      resolution: {
        rewrite: {
          title: 'Validation approach',
          content: 'Use the shared zod schemas; small hand-written checks are fine for path params.',
          scope: { roles: 'all' },
        },
      },
    });
    expect(await screen.findByText('Conflict resolved')).toBeInTheDocument();
    expect(bridge.world.memory.find((m) => m.id === M(10))?.status).toBe('rejected');
    expect(bridge.world.memory.find((m) => m.id === M(2))?.status).toBe('archived');
  });

  it('conflict: the banner opens ConflictCompare; Keep A resolves with keep', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(P, { scenario: 'memory-conflict' });
    const banner = (await screen.findByText('Two records give incompatible instructions')).closest('.banner') as HTMLElement;
    await user.click(within(banner).getByRole('button', { name: 'Resolve conflict' }));
    const panel = (await screen.findByRole('heading', { level: 2, name: 'Resolve conflict' })).closest('section') as HTMLElement;
    expect(within(panel).getByText('Record A')).toBeInTheDocument();
    expect(within(panel).getByText('Record B')).toBeInTheDocument();
    expect(within(panel).getAllByRole('radio')).toHaveLength(4);
    await user.click(within(panel).getByRole('radio', { name: /Keep A/ }));
    await user.click(within(panel).getByRole('button', { name: 'Resolve conflict' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.resolveConflict')[0]?.input).toMatchObject({
        recordIds: [M(10), M(2)],
        resolution: { keep: M(10) },
      });
    });
  });

  it('conflict: keep both with distinct scopes requires different roles', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(P, { scenario: 'memory-conflict' });
    const banner = (await screen.findByText('Two records give incompatible instructions')).closest('.banner') as HTMLElement;
    await user.click(within(banner).getByRole('button', { name: 'Resolve conflict' }));
    const panel = (await screen.findByRole('heading', { level: 2, name: 'Resolve conflict' })).closest('section') as HTMLElement;
    await user.click(within(panel).getByRole('radio', { name: /Keep both with separate scopes/ }));
    await user.click(within(panel).getByRole('button', { name: 'Resolve conflict' }));
    await user.selectOptions(within(panel).getByRole('combobox', { name: /Scope for B/ }), 'reviewer');
    expect(within(panel).getByText('The two records must not apply to the same role.')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Apply resolution' })).toBeDisabled();
    await user.selectOptions(within(panel).getByRole('combobox', { name: /Scope for B/ }), 'implementer');
    await user.click(within(panel).getByRole('button', { name: 'Apply resolution' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.resolveConflict')[0]?.input).toMatchObject({
        recordIds: [M(10), M(2)],
        resolution: {
          keepBothWithScopes: [
            { recordId: M(10), scope: { roles: ['reviewer'] } },
            { recordId: M(2), scope: { roles: ['implementer'] } },
          ],
        },
      });
    });
  });

  it('stale-source: badge, banner, and "Confirm still accurate" writes reviewAt without changing the text', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(`${P}?record=${M(4)}`, { scenario: 'memory-stale' });
    const panel = await detail('Keep handlers thin');
    expect(within(panel).getByText('Source changed since approval')).toBeInTheDocument();
    expect(within(panel).getAllByText('Source changed').length).toBeGreaterThan(0);
    expect(within(panel).getAllByText('src/routes/users.ts').length).toBeGreaterThan(0);
    expect(within(panel).getByText('Review due')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Keep handlers thin/ })).toHaveTextContent('Stale source');
    await user.click(within(panel).getByRole('button', { name: 'Confirm still accurate' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/memory.update')).toHaveLength(1);
    });
    const input = bridge.callsTo('relay/v1/memory.update')[0]?.input as Record<string, unknown>;
    expect(input).toMatchObject({ recordId: M(4), expectedRevision: 2, reviewAt: expect.any(Number) as unknown });
    expect(input).not.toHaveProperty('content');
    expect(input).not.toHaveProperty('title');
    await waitFor(() => {
      expect(within(panel).queryByText('Source changed since approval')).not.toBeInTheDocument();
    });
    expect(within(panel).queryByRole('button', { name: 'Confirm still accurate' })).not.toBeInTheDocument();
  });

  it('memory not implemented in this build: "Not available yet in this build", no add button', async () => {
    renderApp(P, { scenario: 'backend-stubs' });
    expect(await screen.findByText('Not available yet in this build')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add project rule' })).not.toBeInTheDocument();
  });

  it('a stubbed memory command shows the notice and keeps the record unchanged', async () => {
    const user = userEvent.setup();
    const { bridge } = renderApp(`${P}?record=${M(2)}`, { scenario: 'awaiting-approval' });
    const panel = await detail('Validate request bodies with zod');
    bridge.failNext(
      'relay/v1/memory.archive',
      appError('INTERNAL', { details: { reason: 'not_implemented', channel: 'relay/v1/memory.archive' } }),
    );
    await user.click(within(panel).getByRole('button', { name: 'Archive' }));
    expect(await within(panel).findByText('Not available yet in this build')).toBeInTheDocument();
    expect(within(panel).getByText('The record is unchanged.')).toBeInTheDocument();
  });
});
