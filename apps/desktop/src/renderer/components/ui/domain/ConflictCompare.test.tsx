import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { memoryRecord } from '../test-fixtures';
import { ConflictCompare } from './ConflictCompare';
import type { ConflictResolution } from './ConflictCompare';

function Harness({ onSubmit }: { readonly onSubmit: (r: ConflictResolution) => void }) {
  const [value, setValue] = useState<ConflictResolution | null>(null);
  return (
    <ConflictCompare
      a={memoryRecord(1)}
      b={memoryRecord(2)}
      value={value}
      onValueChange={setValue}
      onSubmit={onSubmit}
      slots={{ combine: <label>Rewritten text<input /></label> }}
    />
  );
}

describe('ConflictCompare', () => {
  it('shows only the chosen option slot and submits the choice with one button', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const submit = screen.getByRole('button', { name: 'Resolve conflict' });

    expect(submit).toBeDisabled();
    expect(screen.queryByRole('group', { name: 'Combined record' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Combine into a new record' }));
    expect(screen.getByRole('group', { name: 'Combined record' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Rewritten text' }), 'Both rules{Enter}');

    expect(onSubmit).toHaveBeenCalledWith('combine');
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
