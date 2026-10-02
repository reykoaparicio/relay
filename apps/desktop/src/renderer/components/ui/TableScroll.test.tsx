import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TableScroll } from './TableScroll';

function mockWidths(scrollWidth: number, clientWidth: number) {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth);
}

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function Table() {
  return (
    <TableScroll labelledBy="cap">
      <table>
        <caption id="cap">Runs</caption>
        <tbody>
          <tr>
            <td>x</td>
          </tr>
        </tbody>
      </table>
    </TableScroll>
  );
}

describe('TableScroll', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('is a named, focusable scroll region only while the table overflows', () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    mockWidths(900, 600);
    render(<Table />);
    const region = screen.getByRole('region', { name: 'Runs' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveClass('table-wrap', 'is-overflowing');
  });

  it('adds no tab stop or landmark when the table fits', () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    mockWidths(600, 600);
    const { container } = render(<Table />);
    expect(screen.queryByRole('region')).toBeNull();
    expect(container.querySelector('.table-wrap')).not.toHaveAttribute('tabindex');
  });
});
