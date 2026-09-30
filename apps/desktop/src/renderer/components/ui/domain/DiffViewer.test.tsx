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

  it('treats "---"/"+++" inside a hunk as a deleted "-- comment" and an added "++i;", not file headers', () => {
    const diff = [
      'diff --git a/src/a.c b/src/a.c',
      'index 1111111..2222222 100644',
      '--- a/src/a.c',
      '+++ b/src/a.c',
      '@@ -1,3 +1,3 @@',
      ' int i = 0;',
      '--- comment',
      '+++i;',
      ' return i;',
    ].join('\n');

    const lines = parseUnifiedDiff(diff);

    expect(lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add', 'context']);
    expect(lines[6]).toEqual({ kind: 'del', glyph: '−', text: '-- comment' });
    expect(lines[7]).toEqual({ kind: 'add', glyph: '+', text: '++i;' });
  });

  it('recognizes the next file header after a hunk ends (multi-file diff without "diff" lines)', () => {
    const diff = [
      '--- a/one.ts', '+++ b/one.ts', '@@ -1 +1 @@', '-a', '+b',
      '--- a/two.ts', '+++ b/two.ts', '@@ -1,2 +1,1 @@', '--- x', ' keep',
    ].join('\n');

    const kinds = parseUnifiedDiff(diff).map((l) => l.kind);

    expect(kinds).toEqual(['meta', 'meta', 'hunk', 'del', 'add', 'meta', 'meta', 'hunk', 'del', 'context']);
  });

  it('counts a deleted "-- comment" and an added "++i;" in the file header totals', () => {
    const diff = ['--- a/a.c', '+++ b/a.c', '@@ -1,2 +1,2 @@', '--- comment', '-x', '+++i;', '+y', '\\ No newline at end of file'].join('\n');

    render(<DiffViewer files={[{ relPath: 'a.c', changeType: 'modify', unifiedDiff: diff }]} />);

    expect(screen.getByRole('heading', { name: /a\.c/ })).toHaveTextContent('+2 / −2 lines');
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

  // Structure only; diff line contrast in both themes is proven in styles/contrast.test.ts.
  it('has no axe structure violations @a11y', async () => {
    const { baseElement } = renderWithProviders(
      <main><DiffViewer files={[{ relPath: 'src/a.ts', changeType: 'modify', unifiedDiff: DIFF }]} /></main>,
    );

    expect(describeViolations(await axe(baseElement))).toEqual([]);
  });
});
