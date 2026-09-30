import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { capabilityWarning, catalogModel } from '../test-fixtures';
import { CatalogTable } from './CatalogTable';

const CAPABILITY_HEADERS = ['Structured output', 'Streaming', 'Tools', 'Request lookup', 'Token counting'];

function columnIndex(table: HTMLElement, header: string): number {
  return within(table).getAllByRole('columnheader').findIndex((th) => th.textContent === header);
}

describe('CatalogTable', () => {
  const entry = catalogModel();

  it('shows visible Yes/No text in every capability cell', () => {
    render(<CatalogTable entries={[entry]} catalogVersion="2026-09-30" />);
    const table = screen.getByRole('table');
    const cells = within(table).getAllByRole('row')[1]!.querySelectorAll('th, td');

    for (const header of CAPABILITY_HEADERS) {
      const text = cells[columnIndex(table, header)]?.textContent;
      expect(text === 'Yes' || text === 'No').toBe(true);
    }
    expect(cells[columnIndex(table, 'Tools')]).toHaveTextContent('No');
    expect(cells[columnIndex(table, 'Structured output')]).toHaveTextContent('Yes');
  });

  it('formats prices per MTok with Money', () => {
    render(<CatalogTable entries={[entry]} catalogVersion="2026-09-30" />);
    const row = within(screen.getByRole('table')).getAllByRole('row')[1]!;

    expect(row).toHaveTextContent('$5.00');
    expect(row).toHaveTextContent('$25.00');
    expect(row).toHaveTextContent('$0.50');
    expect(row).toHaveTextContent('$6.25');
  });

  it('renders the source URL as text with a copy button and no external link', () => {
    const { container } = render(<CatalogTable entries={[entry]} catalogVersion="2026-09-30" />);

    expect(screen.getByText('https://example.com/pricing')).toBeVisible();
    expect(screen.getByRole('button', { name: /Copy source URL/ })).toBeInTheDocument();
    expect(container.querySelector('a[href^="http"]')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the catalog version and effective date', () => {
    const { container } = render(<CatalogTable entries={[entry]} catalogVersion="2026-09-30" />);

    expect(screen.getAllByText(/2026-09-30/).length).toBeGreaterThan(0);
    expect(container.querySelector('time[datetime="2026-09-01"]')).toHaveTextContent('2026-09-01');
  });

  it('renders per-profile capability warnings as text', () => {
    const warning = capabilityWarning();

    render(<CatalogTable entries={[entry]} catalogVersion="2026-09-30" profileChecks={{ [entry.modelId]: [warning] }} />);

    expect(screen.getByRole('columnheader', { name: 'Profile checks' })).toBeInTheDocument();
    expect(screen.getByText(warning.message)).toBeVisible();
  });
});
