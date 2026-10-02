import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { appError } from '@relay/contracts';
import type { MemoryRecordDetail } from '@relay/contracts';
import { MemoryRouter } from 'react-router';
import { renderWithProviders } from '../../components/ui/test-utils';
import { createFakeBridge } from '../../api/fake-bridge';
import { installBridge } from '../../api/bridge';
import { AppErrorException } from '../../api/client';
import { MemoryEditForm } from './MemoryEditForm';

async function record(): Promise<MemoryRecordDetail> {
  const bridge = createFakeBridge('memory-conflict');
  installBridge(bridge);
  const rec = bridge.world.memory.find((m) => m.status === 'approved');
  if (rec === undefined) throw new Error('no approved record');
  const r = await bridge.invoke('relay/v1/memory.get', { recordId: rec.id });
  if (!r.ok) throw new Error('memory.get failed');
  return r.data;
}

describe('MemoryEditForm', () => {
  it('rebase: an untouched form adopts a newer revision; an edited one keeps its edits and saves over the newer revision', async () => {
    const r1 = await record();
    const r2: MemoryRecordDetail = { ...r1, currentRevision: r1.currentRevision + 1, content: 'SERVER CONTENT v2' };
    const r3: MemoryRecordDetail = { ...r2, currentRevision: r2.currentRevision + 1, title: 'SERVER TITLE v3' };
    const onSubmit = vi.fn();
    const props = { mode: 'edit' as const, pending: false, onSubmit, onCancel: () => undefined };
    const user = userEvent.setup();
    const view = renderWithProviders(<MemoryRouter><MemoryEditForm record={r1} error={null} {...props} /></MemoryRouter>);
    view.rerender(<MemoryRouter><MemoryEditForm record={r2} error={null} {...props} /></MemoryRouter>);
    expect(screen.getByLabelText(/Content/)).toHaveValue('SERVER CONTENT v2');
    const title = screen.getByLabelText(/Title/);
    await user.clear(title);
    await user.type(title, 'MINE');
    view.rerender(<MemoryRouter><MemoryEditForm record={r3} error={null} {...props} /></MemoryRouter>);
    expect(screen.getByLabelText(/Title/)).toHaveValue('MINE');
    // A plain save expects the base (r2): the server answers CONFLICT.
    await user.click(screen.getByRole('button', { name: /^Save/ }));
    expect(onSubmit).toHaveBeenLastCalledWith({ expectedRevision: r2.currentRevision, title: 'MINE' });
    const conflict = new AppErrorException(appError('CONFLICT', { details: { currentRevision: r3.currentRevision } }));
    view.rerender(<MemoryRouter><MemoryEditForm record={r3} error={conflict} {...props} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: /Keep my changes and save over/ }));
    expect(onSubmit).toHaveBeenLastCalledWith({ expectedRevision: r3.currentRevision, title: 'MINE' });
    await waitFor(() => {
      expect(screen.getByLabelText(/Content/)).toHaveValue('SERVER CONTENT v2');
    });
  });

  it('a partly typed review date blocks the save with the date copy instead of clearing the date', async () => {
    const r1 = await record();
    const rec: MemoryRecordDetail = { ...r1, reviewAt: new Date(2026, 11, 31, 12).getTime() as MemoryRecordDetail['reviewAt'] };
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <MemoryRouter>
        <MemoryEditForm record={rec} error={null} mode="edit" pending={false} onSubmit={onSubmit} onCancel={() => undefined} />
      </MemoryRouter>,
    );
    const review = screen.getByLabelText(/Review date/);
    expect(review).toHaveValue('2026-12-31');
    // Chromium: the user deleted the day segment; the element now reports '' with validity.badInput.
    Object.defineProperty(review, 'validity', { configurable: true, value: { badInput: true } });
    fireEvent.change(review, { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: /^Save/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(review).toHaveAccessibleDescription(/Enter a date like 2026-12-31, or leave it empty\./);
  });
});
