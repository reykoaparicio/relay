import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { LazyDiffViewer } from './LazyDiffViewer';

const DIFF = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-const b = 2;', '+const b = 3;'].join('\n');

describe('LazyDiffViewer', () => {
  it('is aria-busy while the diff chunk loads and not busy once it has rendered', async () => {
    const { container } = render(<LazyDiffViewer files={[{ relPath: 'src/a.ts', changeType: 'modify', unifiedDiff: DIFF }]} />);
    const region = container.firstElementChild;

    expect(region).toHaveAttribute('aria-busy', 'true');

    expect(await screen.findByRole('heading', { name: /src\/a\.ts/ })).toBeVisible();
    await waitFor(() => { expect(region).toHaveAttribute('aria-busy', 'false'); });
  });
});
