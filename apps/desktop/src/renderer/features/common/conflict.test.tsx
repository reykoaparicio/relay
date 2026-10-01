import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { appError } from '@relay/contracts';
import type { AppError } from '@relay/contracts';
import { AppErrorException } from '../../api/client';
import { conflictCopy, isMemoryConflict, isStaleConflict } from './conflict';
import { MutationError } from './MutationError';
import type { MutationErrorProps } from './MutationError';

const conflict = (details?: Readonly<Record<string, unknown>>) =>
  new AppErrorException(appError('CONFLICT', details === undefined ? {} : { details }));

function renderError(props: MutationErrorProps) {
  const router = createMemoryRouter([{ path: '*', element: <MutationError {...props} /> }]);
  return render(<RouterProvider router={router} />);
}

describe('conflictCopy', () => {
  it('a plain revision mismatch is stale (reloading helps)', () => {
    const c = conflictCopy(conflict({ entity: 'memory', currentRevision: 3 }));
    expect(c).toMatchObject({ kind: 'stale', stale: true, currentRevision: 3 });
    expect(c?.message).toMatch(/revision 3/);
    expect(isStaleConflict(conflict({ reason: 'draft_changed' }))).toBe(true);
  });

  it('memory_conflict names the conflicting records and is not stale', () => {
    const e = conflict({ reason: 'memory_conflict', conflictsWith: ['mem_1'] });
    const c = conflictCopy(e, { recordTitle: (id) => (id === 'mem_1' ? 'Use zod' : undefined) });
    expect(c).toMatchObject({ kind: 'memory_conflict', stale: false, conflictsWith: ['mem_1'], title: 'Conflicts with “Use zod”' });
    expect(isMemoryConflict(e)).toBe(true);
    expect(isStaleConflict(e)).toBe(false);
  });

  it('memory_superseded names the successor', () => {
    const c = conflictCopy(conflict({ reason: 'memory_superseded', supersededById: 'mem_2' }), { recordTitle: () => 'New rule' });
    expect(c).toMatchObject({ kind: 'memory_superseded', conflictsWith: ['mem_2'], title: 'Superseded by “New rule”' });
  });

  it('profile_in_use reads workflows ({ id, name, version }) from a rename and workflowIds from a delete', () => {
    const rename = conflictCopy(conflict({ reason: 'profile_in_use', workflows: [{ id: 'wfl_1', name: 'Review', version: 3 }] }));
    expect(rename?.workflows).toEqual([{ id: 'wfl_1', name: 'Review', version: 3 }]);
    expect(rename?.message).toMatch(/Used by “Review”/);
    const del = conflictCopy(conflict({ reason: 'profile_in_use', workflowIds: ['wfl_1'] }), { workflowName: () => 'Review' });
    expect(del?.workflows).toEqual([{ id: 'wfl_1', name: null, version: null }]);
    expect(del?.message).toMatch(/Used by “Review”/);
    expect(del?.stale).toBe(false);
  });

  it('active_run carries the run ids; other reasons get specific copy; non-CONFLICT is null', () => {
    expect(conflictCopy(conflict({ reason: 'active_run', runIds: ['run_1'] }))).toMatchObject({ kind: 'active_run', runIds: ['run_1'], stale: false });
    expect(conflictCopy(conflict({ reason: 'already_decided' }))?.title).toBe('This approval was already decided');
    expect(conflictCopy(new AppErrorException(appError('NOT_FOUND')))).toBeNull();
  });
});

describe('MutationError (CONFLICT)', () => {
  it('never renders a dead Reload: a stale conflict shows Reload only with a handler, and it refetches', async () => {
    const user = userEvent.setup();
    const first = renderError({ error: conflict() });
    expect(screen.getByText('This item changed since it was loaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
    first.unmount();
    let reloads = 0;
    renderError({ error: conflict(), handlers: { reload: () => { reloads += 1; } } });
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reloads).toBe(1);
  });

  it('a non-stale conflict never shows Reload, even with a handler; it links the active run', () => {
    renderError({ error: conflict({ reason: 'active_run', runIds: ['run_00000000000000000000000001'] }), handlers: { reload: () => undefined }, projectId: 'prj_1' });
    expect(screen.getByText('This project has an active run')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/p/prj_1/runs/run_00000000000000000000000001');
  });

  it('a non-CONFLICT error whose next action is reload drops the button without a handler', () => {
    const e: AppError = { ...appError('INTERNAL'), nextAction: 'reload' };
    renderError({ error: new AppErrorException(e) });
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
  });
});
