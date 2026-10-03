import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { RunDetail, RunEvent } from '@relay/contracts';
import { appError, attempt, runDetail } from '../../components/ui/test-fixtures';
import { renderWithProviders } from '../../components/ui/test-utils';
import { hashMapDetail } from './inspector-model';
import { StatusBanner } from './StatusBanner';
import { createFakeBridge, FAKE_PROJECT_ID } from '../../api/fake-bridge';
import { renderApp } from '../testing/render-app';

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

describe('StatusBanner: one cause-and-action banner (audit #3, #14, #15)', () => {
  it('overrun: reserved + over = actual at one precision, the actual labelled by its certainty', async () => {
    const bridge = createFakeBridge('budget-overrun');
    const run = bridge.world.runs[0];
    if (run === undefined) throw new Error('no run');
    renderApp(`/p/${FAKE_PROJECT_ID}/runs/${run.id}`, { bridge });
    const banner = await screen.findByTestId('status-banner', {}, { timeout: 3000 });
    const value = (term: string) => within(banner).getByText(term).nextElementSibling?.textContent;
    expect(value('Reserved')).toBe('$0.62');
    expect(value('Over the reservation')).toBe('$0.09');
    // The fake settles the attempt as provider-reported: the label follows the ledger, never a fixed "Reported".
    expect(await within(banner).findByText('Reported by provider')).toBeInTheDocument();
    expect(value('Reported by provider')).toBe('$0.71');
    // No nested status badge inside the banner (the page header shows it once).
    expect(within(banner).queryByText('Paused: cost exceeded reservation')).not.toBeInTheDocument();
  });

  it('overrun by 30 µUSD on $0.50: the amounts gain decimals instead of reading "$0.50 … $0.50 reserved" and "$0.00" over', () => {
    const run = runDetail({ status: 'paused', pauseReason: 'budget_overrun', unresolvedAttempts: [], availableActions: ['acknowledge_overrun', 'stop'] });
    const events = [{ seq: 1, at: 1, type: 'ledger.overrun', payload: { attemptId: 'att_1', stepRunId: null, N: 500_000, X: 500_030 } }] as unknown as RunEvent[];
    renderWithProviders(
      <MemoryRouter>
        <StatusBanner run={run} projectId="prj_1" events={events} onAction={() => undefined} onRecoveryAction={() => undefined} pending={null} busy={false} />
      </MemoryRouter>,
    );
    const banner = screen.getByTestId('status-banner');
    expect(banner).toHaveTextContent('The last call cost $0.50003, more than the $0.50000 reserved');
    const value = (term: string) => within(banner).getByText(term).nextElementSibling?.textContent;
    expect(value('Reserved')).toBe('$0.50000');
    expect(value('Over the reservation')).toBe('$0.00003');
  });

  it('output-invalid: a plain summary leads, the field list and error code are collapsed under the actions', async () => {
    const bridge = createFakeBridge('output-invalid');
    const run = bridge.world.runs[0];
    if (run === undefined) throw new Error('no run');
    renderApp(`/p/${FAKE_PROJECT_ID}/runs/${run.id}`, { bridge });
    const banner = await screen.findByTestId('status-banner', {}, { timeout: 3000 });
    expect(within(banner).getByText(/returned output in the wrong format/)).toBeInTheDocument();
    const details = within(banner).getByText('Technical details').closest('details');
    expect(details).not.toHaveAttribute('open');
    const fields = within(banner).queryByText(/^What did not match/)?.closest('details');
    if (fields !== null && fields !== undefined) expect(fields).not.toHaveAttribute('open');
    // The actions come before the collapsed detail.
    const retry = within(banner).getByRole('button', { name: 'Retry step' });
    expect(retry.compareDocumentPosition(details as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('StatusBanner step names (stepMeta)', () => {
  const META = [{ stepKey: 'plan', name: 'Draft the change plan', instructionVersion: null }];
  it('auth_required before start: "Needed by" uses the workflow step name', () => {
    renderBanner(
      runDetail({
        status: 'paused',
        pauseReason: 'auth_required',
        startedAt: null,
        stepMeta: META,
        unresolvedAttempts: [],
        availableActions: ['resume', 'stop'],
        statusDetail: appError({ code: 'AUTH_REQUIRED', userMessage: 'No key.', nextAction: 'reconnect_provider', alternatives: [], details: { providerId: 'openai', stepKey: 'plan' } }),
      }),
    );
    expect(screen.getByText('Needed by: Draft the change plan')).toBeInTheDocument();
  });

  it('setup_blocked: "Step" uses the workflow step name', () => {
    renderBanner(
      runDetail({
        status: 'paused',
        pauseReason: 'setup_blocked',
        stepMeta: META,
        unresolvedAttempts: [],
        availableActions: ['stop'],
        statusDetail: appError({ code: 'VALIDATION_FAILED', userMessage: 'Setup failed.', nextAction: 'choose_profile', alternatives: [], details: { stepKey: 'plan' } }),
      }),
    );
    expect(screen.getByText('Step: Draft the change plan')).toBeInTheDocument();
  });
});

describe('StatusBanner unknown request facts (E1)', () => {
  it('cancelled with an unknown request: the request id is copyable and the step uses its display name', () => {
    renderBanner(
      runDetail({
        status: 'cancelled',
        pauseReason: null,
        unresolvedAttempts: [attempt(1, { stepKey: 'implement', state: 'unknown', cost: { microusd: 620_000, certainty: 'unknown' }, providerRequestId: 'req_xyz' })],
        availableActions: ['decide_unknown'],
        stepMeta: [{ stepKey: 'implement', name: 'Write the fix', instructionVersion: 'implementer.v1' }],
      }),
    );
    const list = screen.getByRole('list', { name: 'Requests with an unknown outcome' });
    expect(within(list).getByText(/Write the fix · attempt 1: liability/)).toBeInTheDocument();
    expect(within(list).getByText('req_xyz')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Copy provider request id of Write the fix · attempt 1' })).toBeInTheDocument();
  });

  it('a request without an id says so', () => {
    renderBanner(
      runDetail({
        status: 'paused',
        pauseReason: 'unknown_outcome',
        unresolvedAttempts: [attempt(1, { state: 'unknown', cost: null, providerRequestId: null })],
        availableActions: ['decide_unknown', 'stop'],
      }),
    );
    const list = screen.getByRole('list', { name: 'Requests with an unknown outcome' });
    expect(within(list).getByText('No request id was recorded')).toBeInTheDocument();
    expect(within(list).getByText(/liability amount not known/)).toBeInTheDocument();
  });
});
