import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, describeViolations, renderWithProviders } from '../test-utils';
import { DiffViewer, DIFF_VIRTUALIZE_THRESHOLD } from './DiffViewer';
import { parseUnifiedDiff } from './diff-lines';

const DIFF = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;'].join('\n');

describe('DiffViewer', () => {
  it('parses unified diff lines into typed kinds with gutter glyphs', () => {
    const kinds = parseUnifiedDiff(DIFF).map((l) => `${l.kind}:${l.glyph}`);

    expect(kinds).toEqual(['meta: ', 'meta: ', 'hunk:@', 'context: ', 'del:−', 'add:+']);
  });

  it('shows +/− glyphs and screen-reader words, not color alone', () => {
    const { container } = render(<DiffViewer files={[{ relPath: 'src/a.ts', changeType: 'modify', unifiedDiff: DIFF }]} />);

    expect(container.querySelector('.diff-add .glyph')).toHaveTextContent('+');
    expect(container.querySelector('.diff-del .glyph')).toHaveTextContent('−');
    expect(screen.getByText('Added:')).toHaveClass('sr-only');
    expect(screen.getByRole('heading', { name: /src\/a\.ts/ })).toHaveTextContent('Modified');
  });

  it('virtualizes files longer than the threshold (renders fewer rows than lines)', () => {
    const big = Array.from({ length: DIFF_VIRTUALIZE_THRESHOLD + 100 }, (_, i) => `+line ${String(i)}`).join('\n');

    const { container } = render(<DiffViewer files={[{ relPath: 'big.ts', changeType: 'add', unifiedDiff: big }]} />);

    expect(container.querySelectorAll('.diff-line').length).toBeLessThan(DIFF_VIRTUALIZE_THRESHOLD);
  });

  it.each(['dark', 'light'] as const)('has no axe violations in the %s theme @a11y', async (theme) => {
    const { baseElement } = renderWithProviders(
      <main><DiffViewer files={[{ relPath: 'src/a.ts', changeType: 'modify', unifiedDiff: DIFF }]} /></main>,
      { theme },
    );

    expect(describeViolations(await axe(baseElement))).toEqual([]);
  });
});
