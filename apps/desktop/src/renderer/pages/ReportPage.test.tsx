import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { appError, microusd } from '@relay/contracts';
import { createFakeBridge, FAKE_PROJECT_ID } from '../api/fake-bridge';
import type { FakeScenarioName } from '../api/fake-bridge';
import { axe, describeViolations } from '../components/ui/test-utils';
import { renderApp } from '../features/testing/render-app';

const P = `/p/${FAKE_PROJECT_ID}`;

function open(scenario: FakeScenarioName, query = '') {
  const bridge = createFakeBridge(scenario);
  const run = bridge.world.runs[0];
  if (run === undefined) throw new Error('scenario has no run');
  const result = renderApp(`${P}/runs/${run.id}/report${query}`, { bridge });
  return { ...result, run };
}

async function ready() {
  await screen.findByRole('heading', { level: 1, name: 'Run report' });
  await screen.findByRole('heading', { level: 2, name: 'Summary' });
}

describe('ReportPage', () => {
  it('report: summary, findings, limitations, cost, and the not-modified banner from report.v1', async () => {
    open('completed');
    await ready();
    expect(screen.getByText('Original project files were not modified.')).toBeInTheDocument();
    expect(screen.getByText('Accepted by the workflow reviewer')).toBeInTheDocument();
    expect(screen.getByText(/not that the code is guaranteed correct/)).toBeInTheDocument();
    expect(await screen.findByText('Create-user payload is not validated')).toBeInTheDocument();
    expect(screen.getByText('Relay proposed a patch. It was not applied to your project.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Total tracked cost' })).toBeInTheDocument();
    expect(screen.getByText(/Tracked by Relay; your provider invoice may differ/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Patch' })).toBeInTheDocument();
    // No terminal-status lead for a completed run.
    expect(screen.queryByText(/Steps that did not finish/)).not.toBeInTheDocument();
  });

  it('patch: the patch tab shows the diff and the files in the patch', async () => {
    open('completed', '?tab=patch');
    expect(await screen.findByRole('heading', { name: 'Proposed patch' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /src\/routes\/users\.ts/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy patch' })).toBeInTheDocument();
  });

  it.each([
    ['incomplete', 'Revision limit reached (2 of 2)', true],
    ['cancelled', 'Cancelled: the run was stopped before it finished', false],
    ['failed', 'Failed: the run stopped because of an internal error', false],
  ] as const)('incomplete-report (%s): leads with the status, lists unfinished steps; patch tab only with a patch', async (scenario, lead, hasPatch) => {
    open(scenario);
    await ready();
    expect(screen.getAllByText(lead).length).toBeGreaterThan(0);
    expect(screen.getByText('Useful artifacts are still listed below and can be exported.')).toBeInTheDocument();
    expect(screen.getByText('Original project files were not modified.')).toBeInTheDocument();
    if (scenario !== 'incomplete') expect(screen.getByText('Steps that did not finish:')).toBeInTheDocument();
    if (hasPatch) expect(screen.getByRole('tab', { name: 'Patch' })).toBeInTheDocument();
    else expect(screen.queryByRole('tab', { name: 'Patch' })).not.toBeInTheDocument();
  });

  it('export-dialog: choosing both calls artifacts.export({ what: both })', async () => {
    const { bridge, run } = open('completed');
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Export…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export the run' });
    expect(describeViolations(await axe(document.body))).toEqual([]);
    await userEvent.click(within(dialog).getByRole('radio', { name: /Both/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Export 2 files' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/artifacts.export')).toHaveLength(1);
    });
    expect(bridge.callsTo('relay/v1/artifacts.export')[0]?.input).toEqual({ runId: run.id, what: 'both' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('export-failed: shows "Run is intact; retry export only" and retries the export', async () => {
    const { bridge } = open('export-failed');
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export failed' });
    expect(within(dialog).getByText('Run is intact; retry export only.')).toBeInTheDocument();
    expect(describeViolations(await axe(document.body))).toEqual([]);
    expect(within(dialog).getByText('ARTIFACT_WRITE_FAILED')).toBeInTheDocument();
    bridge.world.exportFails = false;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry export' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/artifacts.export')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('a patch-less run cannot export a patch', async () => {
    open('cancelled');
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Export…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export the run' });
    expect(within(dialog).getByRole('radio', { name: /Patch/ })).toBeDisabled();
    expect(within(dialog).getByRole('radio', { name: /Both/ })).toBeDisabled();
  });

  it('artifacts.get not implemented: shows the notice and a summary from the run', async () => {
    const bridge = createFakeBridge('completed');
    bridge.world.notImplemented.add('artifacts.get');
    const run = bridge.world.runs[0];
    renderApp(`${P}/runs/${run?.id ?? ''}/report`, { bridge });
    expect(await screen.findByText('Not available yet in this build')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByText('Original project files were not modified.')).toBeInTheDocument();
  });

  it.each([
    [{ limit: 'revisions', incompleteCause: 'verifier_incomplete' }, 'The workflow reviewer marked the result incomplete', /reviewer marked the result incomplete\. It is not a failure/],
    [{ limit: 'revisions', incompleteCause: 'revision_limit', revisionCycle: 1, maxRevisionCycles: 3 }, 'Revision limit reached (1 of 3)', /revision limit was reached/],
    [null, 'Incomplete', /ended before its reviewer accepted a patch/],
  ] as const)('B4: the incomplete lead and verdict follow statusDetail.incompleteCause (%o)', async (details, lead, note) => {
    const bridge = createFakeBridge('incomplete-report');
    const run = bridge.world.runs[0];
    if (run === undefined) throw new Error('no run');
    bridge.world.runs[0] = {
      ...run,
      statusDetail: details === null ? null : { ...appError('LIMIT_REACHED'), details },
    };
    renderApp(`${P}/runs/${run.id}/report`, { bridge });
    await ready();
    const alert = screen.getAllByText(lead).find((el) => el.tagName === 'STRONG');
    expect(alert).toBeDefined();
    expect(screen.getByText(note)).toBeInTheDocument();
    if (details?.incompleteCause !== 'revision_limit') expect(screen.queryByText(/revision limit reached/i)).not.toBeInTheDocument();
  });

  it('B6: the run fallback summary shows the certainty breakdown, unknown liability, and limitations', async () => {
    const bridge = createFakeBridge('cancelled');
    bridge.world.notImplemented.add('artifacts.get');
    const run = bridge.world.runs[0];
    if (run === undefined) throw new Error('no run');
    bridge.world.runs[0] = { ...run, cost: { ...run.cost, settledReported: microusd(480_000), settledCalculated: microusd(20_000), settledEstimated: microusd(70_000) } };
    renderApp(`${P}/runs/${run.id}/report`, { bridge });
    const summary = (await screen.findByRole('heading', { name: 'Summary' })).closest('section') as HTMLElement;
    for (const term of ['Reported', 'Calculated', 'Estimated', 'Unknown liability']) {
      expect(within(summary).getByText(term)).toBeInTheDocument();
    }
    expect(within(summary).getByText('$0.62')).toBeInTheDocument(); // run.cost.unknown
    expect(within(summary).getByRole('heading', { name: 'Unresolved charges' })).toBeInTheDocument();
    expect(within(summary).getByText(/Produce patch · attempt 1: up to/)).toBeInTheDocument();
    const limitations = screen.getByRole('heading', { name: 'Limitations' }).closest('section') as HTMLElement;
    expect(within(limitations).getByText(/Part of the tracked cost is estimated/)).toBeInTheDocument();
    expect(within(limitations).getByText(/unknown outcome/)).toBeInTheDocument();
    expect(within(limitations).getByText(/Tracked by Relay; your provider invoice may differ/)).toBeInTheDocument();
  });

  it('a run without a report yet links back to the inspector', async () => {
    open('running-streaming');
    expect(await screen.findByRole('heading', { name: 'No report yet' })).toBeInTheDocument();
  });
});
