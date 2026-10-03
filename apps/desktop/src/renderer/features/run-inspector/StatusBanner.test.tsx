import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { RunDetail, RunEvent } from '@relay/contracts';
import { appError, attempt, runDetail, step } from '../../components/ui/test-fixtures';
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

describe('StatusBanner uncertain request facts (E1)', () => {
  it('cancelled with an uncertain request: the request id is copyable and the step uses its display name', () => {
    renderBanner(
      runDetail({
        status: 'cancelled',
        pauseReason: null,
        uncertainAttempts: [
          attempt(1, { stepKey: 'implement', state: 'unknown', cost: { microusd: 620_000, certainty: 'estimated' }, providerRequestId: 'req_xyz', mayNotHaveBeenCharged: false }),
        ],
        availableActions: ['export_report'],
        stepMeta: [{ stepKey: 'implement', name: 'Write the fix', instructionVersion: 'implementer.v1' }],
      }),
    );
    const list = screen.getByRole('list', { name: 'Requests that may not have completed' });
    expect(within(list).getByText(/Write the fix · attempt 1: counted as/)).toHaveTextContent('~$0.62 (estimated)');
    expect(within(list).getByText('req_xyz')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Copy provider request id of Write the fix · attempt 1' })).toBeInTheDocument();
    expect(screen.getByTestId('status-banner')).not.toHaveTextContent(/unknown/i);
  });

  it('a request without an id says so', () => {
    renderBanner(
      runDetail({
        status: 'paused',
        pauseReason: 'unknown_outcome',
        uncertainAttempts: [attempt(1, { state: 'unknown', cost: null, providerRequestId: null })],
        availableActions: ['retry_step', 'stop'],
      }),
    );
    const list = screen.getByRole('list', { name: 'Requests that may not have completed' });
    expect(within(list).getByText('No request id was recorded')).toBeInTheDocument();
    expect(within(list).getByText(/no amount recorded/)).toBeInTheDocument();
  });
});

describe('StatusBanner decision 1: a request that may not have completed', () => {
  const uncertain = (may: boolean) =>
    attempt(2, { stepKey: 'implement', state: 'unknown', cost: { microusd: 30_000, certainty: 'estimated' }, mayNotHaveBeenCharged: may, providerRequestId: null });

  it('unknown_outcome pause: plain explanation with the estimate and the note, Retry step and Stop only', () => {
    renderBanner(
      runDetail({ status: 'paused', pauseReason: 'unknown_outcome', uncertainAttempts: [uncertain(true)], availableActions: ['retry_step', 'stop', 'export_report'] }),
    );
    const banner = screen.getByTestId('status-banner');
    expect(screen.getByTestId('uncertain-outcome')).toHaveTextContent(
      'The last request may or may not have completed. Relay counted ~$0.03 (estimated) toward the budget, may not have been charged. Retry the step (this may charge again) or stop.',
    );
    expect(within(banner).getAllByRole('button').filter((b) => !/Copy/.test(b.textContent)).map((b) => b.textContent)).toEqual(['Retry step', 'Stop run']);
    expect(banner).not.toHaveTextContent(/unknown/i);
    expect(within(banner).queryByRole('button', { name: /decide/i })).toBeNull();
  });

  it('leaves out the note when the request reached the provider', () => {
    renderBanner(runDetail({ status: 'paused', pauseReason: 'unknown_outcome', uncertainAttempts: [uncertain(false)], availableActions: ['retry_step', 'stop'] }));
    expect(screen.getByTestId('uncertain-outcome')).toHaveTextContent('Relay counted ~$0.03 (estimated) toward the budget. Retry the step');
    expect(screen.getByTestId('uncertain-outcome')).not.toHaveTextContent('may not have been charged');
  });

  it('paused(unknown_outcome) with no step left to retry offers Resume and says so', () => {
    renderBanner(runDetail({ status: 'paused', pauseReason: 'unknown_outcome', uncertainAttempts: [uncertain(false)], availableActions: ['resume', 'stop'] }));
    expect(screen.getByTestId('uncertain-outcome')).toHaveTextContent('Resume continues the run');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
  });

  it('interrupted with an uncertain request uses the same wording', () => {
    renderBanner(runDetail({ status: 'interrupted', uncertainAttempts: [uncertain(true)], availableActions: ['review_recovery', 'stop'] }));
    expect(screen.getByTestId('uncertain-outcome')).toHaveTextContent(
      'The last request may or may not have completed. Relay counted ~$0.03 (estimated) toward the budget, may not have been charged.',
    );
    expect(screen.getByTestId('status-banner')).not.toHaveTextContent(/unknown/i);
  });
});

describe('StatusBanner decision 2: pause', () => {
  it('a user pause names the step it resumes from and offers Resume', () => {
    renderBanner(
      runDetail({
        status: 'paused',
        pauseReason: 'user',
        uncertainAttempts: [],
        steps: [step(1), step(2, { stepKey: 'plan', state: 'ready' })],
        availableActions: ['resume', 'stop', 'export_report'],
      }),
    );
    expect(screen.getByText('Paused by you — resumes from Plan a fix; nothing is lost')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
  });

  it('says "Pausing after the current request…" while the pause waits for the in-flight request', () => {
    renderWithProviders(
      <MemoryRouter>
        <StatusBanner
          run={runDetail({ status: 'running', pauseReason: null, uncertainAttempts: [], availableActions: ['pause', 'cancel', 'export_report'] })}
          projectId="prj_1"
          events={[]}
          onAction={() => undefined}
          onRecoveryAction={() => undefined}
          pending={null}
          busy={false}
          pausing
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Pausing after the current request…')).toBeInTheDocument();
  });

  it('shows nothing for a running run that is not pausing', () => {
    renderBanner(runDetail({ status: 'running', pauseReason: null, uncertainAttempts: [], availableActions: ['pause', 'cancel'] }));
    expect(screen.queryByTestId('status-banner')).toBeNull();
  });
});

