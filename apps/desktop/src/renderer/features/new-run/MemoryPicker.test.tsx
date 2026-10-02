import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import userEvent from '@testing-library/user-event';
import { memoryRecord } from '../../components/ui/test-fixtures';
import { MemoryPicker } from './MemoryPicker';
import { MAX_MEMORY_RECORD_IDS } from './new-run-model';

const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

const records = Array.from({ length: MAX_MEMORY_RECORD_IDS + 2 }, (_, i) => memoryRecord(i + 1, { pinned: false, title: `Rule ${String(i + 1)}` }));

describe('MemoryPicker cap', () => {
  it('at the cap, unticked records cannot be added; the copy says why; "Include all" resets the selection', async () => {
    const onToggle = vi.fn();
    const onIncludeAll = vi.fn();
    const checked = records.slice(0, MAX_MEMORY_RECORD_IDS).map((m) => m.id);
    render(<MemoryPicker records={records} error={null} onRetry={vi.fn()} checked={checked} onToggle={onToggle} onIncludeAll={onIncludeAll} />);
    const extra = screen.getByRole('checkbox', { name: `Rule ${String(MAX_MEMORY_RECORD_IDS + 1)}` });
    expect(extra).toBeDisabled();
    expect(extra).toHaveAccessibleDescription(/At most 50 records can be chosen one by one/);
    // Ticked ones stay enabled (untick one to choose another).
    expect(screen.getByRole('checkbox', { name: 'Rule 1' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Include all approved records' }));
    expect(onIncludeAll).toHaveBeenCalledTimes(1);
  });

  it('below the cap every record can be ticked', () => {
    const checked = records.slice(0, 3).map((m) => m.id);
    render(<MemoryPicker records={records} error={null} onRetry={vi.fn()} checked={checked} onToggle={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: 'Rule 10' })).toBeEnabled();
    expect(screen.queryByText(/At most 50 records/)).not.toBeInTheDocument();
  });
});
