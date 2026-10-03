// 06 F17: `renderReportMarkdown` byte stability (the exported report file). A fixed report.v1 value renders to exactly
// this text; approvals and revision cycles are part of it, and free text (goal, notes, limitations, profile names)
// cannot open Markdown structure of its own.
import { describe, expect, it } from 'vitest';
import { reportV1Schema } from '@relay/contracts';
import type { ReportV1 } from '@relay/contracts';
import { renderReportMarkdown } from './report.js';

const FIXED_REPORT = {
  schemaId: 'report.v1',
  runId: 'run_01J9ZZZZZZZZZZZZZZZZZZZZZ0',
  projectId: 'prj_01J9ZZZZZZZZZZZZZZZZZZZZZ0',
  goal: 'Fix the defects in the handlers.\n# not a heading',
  status: 'incomplete',
  verdict: 'revise',
  workflow: { id: 'wfl_01J9ZZZZZZZZZZZZZZZZZZZZZ0', version: 1, contentHash: 'a'.repeat(64) },
  steps: [
    { stepKey: 'review', revisionIndex: 0, retryIndex: 0, state: 'succeeded', profileName: 'Economy', providerId: 'anthropic', modelId: 'claude-haiku-4-5',
      cost: { settledMicrousd: 12_345, certainty: 'calculated', unknownMicrousd: 0 } },
    { stepKey: 'approve', revisionIndex: 1, retryIndex: 0, state: 'succeeded', profileName: null, providerId: null, modelId: null,
      cost: { settledMicrousd: 0, certainty: 'calculated', unknownMicrousd: 0 } },
    { stepKey: 'implement', revisionIndex: 2, retryIndex: 1, state: 'failed', profileName: 'Capable | big', providerId: 'anthropic', modelId: 'claude-opus-5-5',
      cost: { settledMicrousd: 1_000_000, certainty: 'estimated', unknownMicrousd: 250_000 } },
  ],
  totals: { allowance: 3_000_000, settledReported: 0, settledCalculated: 12_345, settledEstimated: 1_000_000, reserved: 0, unknown: 250_000,
    remaining: 1_737_655, overrun: false },
  unknownLiabilities: [{ attemptId: 'att_01J9ZZZZZZZZZZZZZZZZZZZZZ0', stepKey: 'implement', liabilityMicrousd: 250_000, state: 'abandoned' }],
  artifacts: { findings: 'art_01J9ZZZZZZZZZZZZZZZZZZZZZ0', plan: 'art_01J9ZZZZZZZZZZZZZZZZZZZZZ1', patch: null, review: 'art_01J9ZZZZZZZZZZZZZZZZZZZZZ2' },
  limitations: ['The patch was not applied.', 'Tests were not run.\nTwo lines.'],
  snapshotUsed: true,
  generatedAt: Date.UTC(2026, 9, 1, 12, 0, 0),
  approvals: [
    { approvalId: 'apr_01J9ZZZZZZZZZZZZZZZZZZZZZ0', stepKey: 'approve', planArtifactId: 'art_01J9ZZZZZZZZZZZZZZZZZZZZZ1', planHash: 'b'.repeat(64),
      decision: 'revision_requested', decidedAt: Date.UTC(2026, 9, 1, 11, 0, 0), note: 'Keep | fields.\nNo renames.', invalidatedReason: null, createdAt: Date.UTC(2026, 9, 1, 10, 0, 0) },
    { approvalId: 'apr_01J9ZZZZZZZZZZZZZZZZZZZZZ1', stepKey: 'approve', planArtifactId: 'art_01J9ZZZZZZZZZZZZZZZZZZZZZ3', planHash: 'c'.repeat(64),
      decision: 'approved', decidedAt: Date.UTC(2026, 9, 1, 11, 30, 0), note: null, invalidatedReason: 'scope_changed', createdAt: Date.UTC(2026, 9, 1, 11, 10, 0) },
  ],
  revisions: { cycles: 2, maxCycles: 2, planRevisions: 1, incompleteCause: 'revision_limit' },
  stepMeta: [{ stepKey: 'review', name: 'Find defects', instructionVersion: 'reviewer.v2' }, { stepKey: 'approve', name: null, instructionVersion: null }],
} as unknown as ReportV1;

const EXPECTED = [
  '# Relay run report — run_01J9ZZZZZZZZZZZZZZZZZZZZZ0',
  '',
  '- Status: incomplete',
  '- Verdict: revise',
  '- Workflow: wfl_01J9ZZZZZZZZZZZZZZZZZZZZZ0 v1 (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)',
  '- Project: prj_01J9ZZZZZZZZZZZZZZZZZZZZZ0',
  '- Generated: 2026-10-01T12:00:00.000Z',
  '- Input: the preserved snapshot was used after the project changed',
  '',
  '## Goal',
  '',
  '> Fix the defects in the handlers.',
  '> # not a heading',
  '',
  '## Steps',
  '',
  '| Step | Revision | Retry | State | Profile | Model | Instructions | Settled (USD) | Certainty | Unknown (USD) |',
  '|---|---|---|---|---|---|---|---|---|---|',
  '| Find defects (review) | 0 | 0 | succeeded | Economy | anthropic/claude-haiku-4-5 | reviewer.v2 | 0.012345 | calculated | 0.000000 |',
  '| approve | 1 | 0 | succeeded | — | — | — | 0.000000 | calculated | 0.000000 |',
  '| implement | 2 | 1 | failed | Capable \\| big | anthropic/claude-opus-5-5 | — | 1.000000 | estimated | 0.250000 |',
  '',
  '## Cost (tracked by Relay)',
  '',
  '- Run allowance: $3.000000',
  '- Settled, provider-reported: $0.000000',
  '- Settled, calculated from usage: $0.012345',
  '- Settled, estimated: $1.000000',
  '- Still reserved: $0.000000',
  '- Unknown charges: $0.250000',
  '- Remaining: $1.737655',
  '',
  '## Approvals',
  '',
  '| Step | Approval | Plan hash | Decision | Decided | Invalidated | Note |',
  '|---|---|---|---|---|---|---|',
  '| approve | apr_01J9ZZZZZZZZZZZZZZZZZZZZZ0 | bbbbbbbbbbbb | revision requested | 2026-10-01T11:00:00.000Z | — | Keep \\| fields. No renames. |',
  '| approve | apr_01J9ZZZZZZZZZZZZZZZZZZZZZ1 | cccccccccccc | approved | 2026-10-01T11:30:00.000Z | scope_changed | — |',
  '',
  '## Revisions',
  '',
  '- Quality revision cycles: 2 of 2',
  '- Plan revisions (requested changes or re-plans): 1',
  '- Ended incomplete because the revision limit was reached',
  '',
  '## Unknown charges',
  '',
  '- implement attempt att_01J9ZZZZZZZZZZZZZZZZZZZZZ0 (abandoned): up to $0.250000 may have been charged',
  '',
  '## Artifacts',
  '',
  '- findings: art_01J9ZZZZZZZZZZZZZZZZZZZZZ0',
  '- plan: art_01J9ZZZZZZZZZZZZZZZZZZZZZ1',
  '- patch: none',
  '- review: art_01J9ZZZZZZZZZZZZZZZZZZZZZ2',
  '',
  '## Limitations',
  '',
  '- The patch was not applied.',
  '- Tests were not run. Two lines.',
  '- Original project files were not modified.',
  '',
].join('\n');

describe('renderReportMarkdown (F17 snapshot)', () => {
  it('renders the fixed report byte-for-byte (approvals table, revision cycles, escaped cells, quoted goal)', () => {
    expect(reportV1Schema.parse(FIXED_REPORT)).toEqual(FIXED_REPORT);
    expect(renderReportMarkdown(FIXED_REPORT)).toBe(EXPECTED);
  });

  it('a report without approval/revision fields (generated before wave 4) still renders, saying they were not recorded', () => {
    const old: Record<string, unknown> = { ...FIXED_REPORT };
    delete old['approvals'];
    delete old['revisions'];
    const md = renderReportMarkdown(reportV1Schema.parse(old));

    expect(md).toContain('## Approvals\n\nNot recorded in this report.\n');
    expect(md).toContain('## Revisions\n\nNot recorded in this report.\n');
  });

  it('a run that never asked for approval says so, and a completed run states no incomplete cause', () => {
    const md = renderReportMarkdown({ ...FIXED_REPORT, status: 'completed', approvals: [], revisions: { cycles: 0, maxCycles: 2, planRevisions: 0, incompleteCause: null } });

    expect(md).toContain('## Approvals\n\nNo approval was requested.\n');
    expect(md).toContain('- Quality revision cycles: 0 of 2\n- Plan revisions (requested changes or re-plans): 0\n\n## Unknown charges');
  });
});
