import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { appError } from '@relay/contracts';
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

/** The page header's "Export run…" (the Artifacts card has the same entry point, named the same). */
function headerExport(): HTMLElement {
  const first = screen.getAllByRole('button', { name: 'Export run…' })[0];
  if (first === undefined) throw new Error('no Export run… button');
  return first;
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
    await userEvent.click(headerExport());
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
    await userEvent.click(headerExport());
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

  it('export-partial: both → report written, patch failed (a warning, not an error); Retry re-exports only the patch', async () => {
    const { bridge, run } = open('export-partial');
    await ready();
    await userEvent.click(headerExport());
    const first = await screen.findByRole('dialog', { name: 'Export the run' });
    await userEvent.click(within(first).getByRole('radio', { name: /Both/ }));
    await userEvent.click(within(first).getByRole('button', { name: 'Export 2 files' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export partly saved' });
    expect(screen.queryByRole('dialog', { name: 'Export failed' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(dialog).getByText('One file was not saved')).toBeInTheDocument();
    const rows = within(dialog).getAllByTestId('export-part');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Report (Markdown): Written to ~/Downloads/report.md');
    expect(rows[1]).toHaveTextContent('Patch (.patch): Failed. Relay could not write patch.diff. The folder may be read-only or full.');
    expect(describeViolations(await axe(document.body))).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry failed file' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/artifacts.export')).toHaveLength(2);
    });
    expect(bridge.callsTo('relay/v1/artifacts.export')[1]?.input).toEqual({ runId: run.id, what: 'patch' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(await screen.findByText('Export saved')).toBeInTheDocument();
    expect(screen.getByText('~/Downloads/report.md, ~/Downloads/patch.diff')).toBeInTheDocument();
  });

  it('export-partial: a failed report part (patch written) retries only the report', async () => {
    const { bridge } = open('export-partial');
    await ready();
    bridge.world.exportFailParts = ['report'];
    await userEvent.click(headerExport());
    const first = await screen.findByRole('dialog', { name: 'Export the run' });
    await userEvent.click(within(first).getByRole('radio', { name: /Both/ }));
    await userEvent.click(within(first).getByRole('button', { name: 'Export 2 files' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export partly saved' });
    expect(within(dialog).getAllByTestId('export-part')[0]).toHaveTextContent('Report (Markdown): Failed.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry failed file' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/artifacts.export')[1]?.input).toMatchObject({ what: 'report' });
    });
  });

  it('export-partial with a part that is no longer stored (NOT_FOUND): final wording, no retry for it', async () => {
    const { bridge } = open('export-partial');
    await ready();
    bridge.world.exportFailParts = [];
    bridge.world.exportMissingParts = ['patch'];
    await userEvent.click(headerExport());
    const first = await screen.findByRole('dialog', { name: 'Export the run' });
    await userEvent.click(within(first).getByRole('radio', { name: /Both/ }));
    await userEvent.click(within(first).getByRole('button', { name: 'Export 2 files' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export partly saved' });
    const rows = within(dialog).getAllByTestId('export-part');
    expect(rows[0]).toHaveTextContent('Report (Markdown): Written to ~/Downloads/report.md');
    expect(rows[1]).toHaveTextContent('Patch (.patch): Failed. This file is no longer stored, so it cannot be exported.');
    expect(within(dialog).getByText('Run is intact. The files that failed cannot be exported again.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Export saved')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(bridge.callsTo('relay/v1/artifacts.export')).toHaveLength(1);
  });

  it('a mix: the write failure is retried, the missing part is not', async () => {
    const { bridge } = open('export-partial');
    await ready();
    bridge.world.exportFailParts = ['report'];
    bridge.world.exportMissingParts = ['patch'];
    await userEvent.click(headerExport());
    const first = await screen.findByRole('dialog', { name: 'Export the run' });
    await userEvent.click(within(first).getByRole('radio', { name: /Both/ }));
    await userEvent.click(within(first).getByRole('button', { name: 'Export 2 files' }));
    // Nothing was written: the whole export fails, with per-part details.
    const dialog = await screen.findByRole('dialog', { name: /Export (failed|partly saved)/ });
    await userEvent.click(within(dialog).getByRole('button', { name: /Retry/ }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/artifacts.export')).toHaveLength(2);
    });
    expect(bridge.callsTo('relay/v1/artifacts.export')[1]?.input).toMatchObject({ what: 'report' });
  });

  it('a whole export failing with NOT_FOUND offers no retry', async () => {
    const { bridge } = open('export-partial');
    await ready();
    bridge.world.exportFailParts = [];
    bridge.world.exportMissingParts = ['report'];
    await userEvent.click(headerExport());
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export failed' });
    expect(within(dialog).getByTestId('export-part')).toHaveTextContent('Report (Markdown): Failed. This file is no longer stored, so it cannot be exported.');
    expect(within(dialog).getByText('Run is intact. Trying again would fail the same way.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
  });

  it('export success names where the files were saved; a cancelled save dialog closes quietly', async () => {
    const { bridge } = open('completed');
    await ready();
    await userEvent.click(headerExport());
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));
    expect(await screen.findByText('Export saved')).toBeInTheDocument();
    expect(screen.getByText('~/Downloads/report.md')).toBeInTheDocument();
    bridge.world.dialogCancels.add('artifacts.export');
    await userEvent.click(headerExport());
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/artifacts.export')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('artifacts.export failing as a stubbed channel: the dialog shows the generic failure', async () => {
    const { bridge } = open('completed');
    await ready();
    bridge.world.notImplemented.add('artifacts.export');
    await userEvent.click(headerExport());
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export failed' });
    expect(within(dialog).getByText('This feature is not available in this build yet.')).toBeInTheDocument();
    expect(within(dialog).getByText('Run is intact; retry export only.')).toBeInTheDocument();
    expect(within(dialog).getByText('INTERNAL')).toBeInTheDocument();
  });

  it('a patch-less run cannot export a patch', async () => {
    open('cancelled');
    await ready();
    await userEvent.click(headerExport());
    const dialog = await screen.findByRole('dialog', { name: 'Export the run' });
    expect(within(dialog).getByRole('radio', { name: /Patch/ })).toBeDisabled();
    expect(within(dialog).getByRole('radio', { name: /Both/ })).toBeDisabled();
  });

  it('artifacts.get failing (e.g. a future stubbed channel): the generic ErrorView with a retry, no fallback summary', async () => {
    const bridge = createFakeBridge('completed');
    bridge.world.notImplemented.add('artifacts.get');
    const run = bridge.world.runs[0];
    renderApp(`${P}/runs/${run?.id ?? ''}/report`, { bridge });
    const alert = (await screen.findByText('This feature is not available in this build yet.')).closest('.banner') as HTMLElement;
    expect(alert).toHaveTextContent('INTERNAL');
    expect(screen.queryByText(/Not available yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Summary' })).not.toBeInTheDocument();
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
    // Keep the report's own record consistent with the run (report.v1 `revisions.incompleteCause`).
    const stored = run.reportArtifactId === null ? undefined : bridge.world.artifacts.get(run.reportArtifactId);
    if (stored?.content.kind === 'json') {
      const value = stored.content.value as { revisions?: { incompleteCause: unknown } };
      if (value.revisions !== undefined) value.revisions = { ...value.revisions, incompleteCause: details?.incompleteCause ?? null };
    }
    renderApp(`${P}/runs/${run.id}/report`, { bridge });
    await ready();
    const alert = screen.getAllByText(lead).find((el) => el.tagName === 'STRONG');
    expect(alert).toBeDefined();
    expect(screen.getByText(note)).toBeInTheDocument();
    if (details?.incompleteCause !== 'revision_limit') expect(screen.queryByText(/revision limit reached/i)).not.toBeInTheDocument();
  });

  it('approvals and revisions from report.v1: decision, decided time, plain-text note, invalidated badge', async () => {
    open('incomplete-report');
    await ready();
    const approvals = screen.getByRole('region', { name: 'Approvals' });
    const items = within(approvals).getAllByTestId('report-approval');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Approve plan: revision requested');
    expect(within(items[0] as HTMLElement).getByText('invalidated: plan changed')).toBeInTheDocument();
    // The note is the user's text, shown as plain text (never parsed as markup).
    expect(within(items[0] as HTMLElement).getByText('Note: Keep the 422 body shape <b>unchanged</b>.')).toBeInTheDocument();
    expect(approvals.querySelector('b')).toBeNull();
    expect(within(items[0] as HTMLElement).getByText(/^Decided/).querySelector('time')).toHaveAttribute('datetime');
    expect(items[1]).toHaveTextContent('Approve plan: approved');
    expect(within(items[1] as HTMLElement).queryByText(/^invalidated:/)).not.toBeInTheDocument();

    const revisions = screen.getByRole('region', { name: 'Revisions' });
    expect(within(revisions).getByText('Revision cycles')).toBeInTheDocument();
    expect(within(revisions).getByText('2 of 2')).toBeInTheDocument();
    expect(within(revisions).getByText('Plan revisions')).toBeInTheDocument();
    expect(within(revisions).getByText('1')).toBeInTheDocument();
    expect(within(revisions).getByText('Revision limit reached: the reviewer still requested changes.')).toBeInTheDocument();
  });

  it('a completed run lists its approval as approved and no incomplete cause', async () => {
    open('completed');
    await ready();
    const approvals = screen.getByRole('region', { name: 'Approvals' });
    expect(within(approvals).getByTestId('report-approval')).toHaveTextContent('Approve plan: approved');
    const revisions = screen.getByRole('region', { name: 'Revisions' });
    expect(within(revisions).getByText('0 of 2')).toBeInTheDocument();
    expect(within(revisions).queryByText('Why the run is incomplete')).not.toBeInTheDocument();
  });

  it('an undecided approval says "not decided" with the time it was opened', async () => {
    const bridge = createFakeBridge('cancelled');
    const run = bridge.world.runs[0];
    if (run?.reportArtifactId == null) throw new Error('no report');
    const stored = bridge.world.artifacts.get(run.reportArtifactId);
    if (stored?.content.kind !== 'json') throw new Error('no report json');
    const value = stored.content.value as { approvals: Array<Record<string, unknown>> };
    value.approvals = value.approvals.map((a) => ({ ...a, decision: null, decidedAt: null }));
    renderApp(`${P}/runs/${run.id}/report`, { bridge });
    await ready();
    const item = within(screen.getByRole('region', { name: 'Approvals' })).getByTestId('report-approval');
    expect(item).toHaveTextContent('Approve plan: not decided');
    expect(item).toHaveTextContent(/Opened .+; no decision recorded/);
  });

  it('an older report without approvals or revisions says so in both sections', async () => {
    open('report-legacy');
    await ready();
    expect(within(screen.getByRole('region', { name: 'Approvals' })).getByText('Not recorded in this report.')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Revisions' })).getByText('Not recorded in this report.')).toBeInTheDocument();
  });

  it('a run without a report yet links back to the inspector', async () => {
    open('running-streaming');
    expect(await screen.findByRole('heading', { name: 'No report yet' })).toBeInTheDocument();
  });
});
