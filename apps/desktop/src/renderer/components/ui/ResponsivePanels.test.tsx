import { useState } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResponsivePanels } from './ResponsivePanels';

function setWidth(px: number) {
  act(() => {
    window.innerWidth = px;
    window.dispatchEvent(new Event('resize'));
  });
}

const changes: string[] = [];
function Harness({ initial = 'output' }: { readonly initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <ResponsivePanels
      label="Step details"
      value={value}
      onValueChange={(next) => {
        changes.push(next);
        setValue(next);
      }}
      tabs={[
        { id: 'output', label: 'Output', content: <p>Output body</p> },
        { id: 'attempts', label: 'Attempts', content: <p>Attempts body</p> },
      ]}
      secondary={[
        { id: 'ledger', label: 'Budget ledger', content: <p>Ledger body</p> },
        { id: 'context', label: 'Context used', content: <p>Context body</p> },
      ]}
    />
  );
}

afterEach(() => { setWidth(1024); });

describe('ResponsivePanels', () => {
  it('below the breakpoint (1100px) appends secondary panels as keyboard-reachable tabs', async () => {
    setWidth(1100);
    const user = userEvent.setup();
    render(<Harness />);
    const tablist = screen.getByRole('tablist', { name: 'Step details' });
    const names = within(tablist).getAllByRole('tab').map((t) => t.textContent);

    expect(names).toEqual(['Output', 'Attempts', 'Budget ledger', 'Context used']);
    expect(screen.queryByRole('region', { name: 'Budget ledger' })).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'Output' }));
    await user.keyboard('{ArrowRight}{ArrowRight}');

    expect(screen.getByRole('tab', { name: 'Budget ledger' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Budget ledger' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Ledger body')).toBeVisible();
  });

  it('at 1440px renders secondary panels as labelled sections, not tabs', () => {
    setWidth(1440);
    render(<Harness />);
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);

    expect(tabs).toEqual(['Output', 'Attempts']);
    expect(screen.getByRole('region', { name: 'Budget ledger' })).toHaveTextContent('Ledger body');
    expect(screen.getByRole('region', { name: 'Context used' })).toHaveTextContent('Context body');
  });

  it('falls back to the first tab when widening while a secondary tab is selected', () => {
    setWidth(1100);
    render(<Harness initial="ledger" />);

    expect(screen.getByRole('tab', { name: 'Budget ledger' })).toHaveAttribute('aria-selected', 'true');

    setWidth(1440);

    expect(screen.getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true');
    expect(changes.at(-1)).toBe('output');
    expect(screen.getByRole('region', { name: 'Budget ledger' })).toBeInTheDocument();
  });
});
