import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { RunDetail } from '@relay/contracts';
import { appError, runDetail } from '../../components/ui/test-fixtures';
import { renderWithProviders } from '../../components/ui/test-utils';
import { hashMapDetail } from './inspector-model';
import { StatusBanner } from './StatusBanner';

const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
const C = 'c3'.repeat(32);

function staleRun(details: Record<string, unknown>): RunDetail {
  return runDetail({
    status: 'paused',
    pauseReason: 'approval_stale',
    unresolvedAttempts: [],
    availableActions: ['resnapshot_and_replan', 'use_preserved_snapshot', 'stop'],
    statusDetail: appError({
      code: 'PROJECT_CHANGED',
      userMessage: 'Project files changed.',
      nextAction: 'resnapshot_and_replan',
      alternatives: [],
      details,
    }),
  });
}

function renderBanner(run: RunDetail) {
  return renderWithProviders(
    <MemoryRouter>
      <StatusBanner
        run={run}
        projectId="prj_1"
        events={[]}
        onAction={() => undefined}
        onRecoveryAction={() => undefined}
        pending={null}
        busy={false}
      />
    </MemoryRouter>,
  );
}

describe('hashMapDetail', () => {
  it('reads a { relPath: sha256 } map and drops malformed entries', () => {
    const err = appError({ details: { before: { 'a.ts': A, 'b.ts': null, 'c.ts': 3, '': A } } });
    expect([...hashMapDetail(err, 'before')]).toEqual([
      ['a.ts', A],
      ['b.ts', null],
    ]);
  });

  it('is empty for a non-map detail', () => {
    expect(hashMapDetail(appError({ details: { before: A } }), 'before').size).toBe(0);
    expect(hashMapDetail(appError({ details: { before: [A] } }), 'before').size).toBe(0);
    expect(hashMapDetail(appError(), 'before').size).toBe(0);
  });
});

describe('StatusBanner approval_stale (PROJECT_CHANGED)', () => {
  it('shows the before → after hash per changed path, with full values copyable', () => {
    renderBanner(
      staleRun({
        changedPaths: ['src/a.ts', 'src/b.ts'],
        before: { 'src/a.ts': A, 'src/b.ts': B },
        after: { 'src/a.ts': C, 'src/b.ts': null },
      }),
    );
    const items = screen.getAllByRole('listitem');
    const a = items.find((li) => li.textContent.includes('src/a.ts'));
    const b = items.find((li) => li.textContent.includes('src/b.ts'));
    if (a === undefined || b === undefined) throw new Error('missing list items');
    expect(a.textContent).toMatch(/\(hash a1a1…a1a1.*→.*c3c3…c3c3\)/);
    expect(within(a).getByRole('button', { name: 'Copy full previous hash of src/a.ts' })).toBeInTheDocument();
    expect(within(a).getByRole('button', { name: 'Copy full current hash of src/a.ts' })).toBeInTheDocument();
    expect(within(a).getByText('a1a1…a1a1')).toHaveAttribute('title', A);
    expect(b.textContent).toMatch(/\(hash b2b2…b2b2.*→ file missing or unreadable\)/);
  });

  it('lists the changed paths without hashes when the maps are absent or malformed', () => {
    renderBanner(staleRun({ changedPaths: ['src/a.ts'], before: A, after: B }));
    const li = screen.getByRole('listitem');
    expect(li).toHaveTextContent('src/a.ts changed since the context snapshot');
    expect(li.textContent).not.toContain('hash');
  });
});
