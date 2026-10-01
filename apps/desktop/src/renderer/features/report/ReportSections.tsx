// Sections of the run report (10 J8 ReportPage, report.html). Everything renders from the engine-generated
// `report.v1` artifact (type from `@relay/contracts` `outputs/report.v1`), never from a local shape.
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { addMicrousd } from '@relay/contracts';
import type { ExportWhat, FindingsV1, ReportV1, RunDetail } from '@relay/contracts';
import { Button, Dialog, DialogFooter, Hash, InlineAlert, KeyValueList, Money, RadioGroup, Skeleton, StatusBadge } from '../../components/ui';
import { PROVIDER_LABELS, statusPresentation } from '../../lib/format';
import { errorTitle, toViewError } from '../../api/errors';
import { FindingsView } from '../outputs/OutputViews';
import { incompleteCauseOf, incompleteTitle, stepTitle } from '../run-inspector/inspector-model';
import type { IncompleteCause } from '../run-inspector/inspector-model';

type ReportStep = ReportV1['steps'][number];

function Section({ title, children, aside }: { readonly title: string; readonly children: ReactNode; readonly aside?: ReactNode }) {
  const id = useId();
  return (
    <section className="card" aria-labelledby={id}>
      <div className="card-header">
        <h2 id={id}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const VERDICT_TEXT: Readonly<Record<ReportV1['status'], { readonly title: string; readonly note: string }>> = {
  completed: {
    title: 'Accepted by the workflow reviewer',
    note: 'Completed means the configured workflow accepted its output, not that the code is guaranteed correct.',
  },
  incomplete: {
    title: 'Incomplete',
    note: 'Incomplete means the workflow ended before its reviewer accepted a patch. It is not a failure of Relay and not a judgment that the patch is wrong.',
  },
  cancelled: { title: 'Cancelled', note: 'The run was stopped before the workflow finished. Finished steps are kept.' },
  failed: { title: 'Failed', note: 'Relay hit an internal error. Artifacts produced before it are kept.' },
};

/** "Economy (Review input), Balanced (Plan a fix, Review patch)". */
function profilesUsed(steps: readonly ReportStep[]): string {
  const by = new Map<string, string[]>();
  for (const s of steps) {
    if (s.profileName === null) continue;
    const title = stepTitle(s);
    const list = by.get(s.profileName) ?? [];
    if (!list.includes(title)) list.push(title);
    by.set(s.profileName, list);
  }
  return by.size === 0 ? 'None' : [...by].map(([p, list]) => `${p} (${list.join(', ')})`).join(', ');
}

function providersUsed(steps: readonly ReportStep[]): string {
  const by = new Map<string, Set<string>>();
  for (const s of steps) {
    if (s.providerId === null) continue;
    const set = by.get(s.providerId) ?? new Set<string>();
    if (s.modelId !== null) set.add(s.modelId);
    by.set(s.providerId, set);
  }
  if (by.size === 0) return 'None';
  return [...by]
    .map(([p, models]) => `${PROVIDER_LABELS[p as keyof typeof PROVIDER_LABELS]} (${[...models].join(', ')})`)
    .join('; ');
}

/** Why an incomplete run stopped, from `statusDetail.incompleteCause` (B4); neutral when the engine did not say. */
const INCOMPLETE_NOTE: Readonly<Record<IncompleteCause, string>> = {
  revision_limit:
    'The reviewer still requested changes when the revision limit was reached. It is not a failure of Relay and not a judgment that the patch is wrong.',
  verifier_incomplete:
    'The workflow reviewer marked the result incomplete. It is not a failure of Relay; review the latest proposal before using it.',
};

export function SummarySection({ report, run }: { readonly report: ReportV1; readonly run: RunDetail | undefined }) {
  const verdict = VERDICT_TEXT[report.status];
  const cause = report.status === 'incomplete' && run !== undefined ? incompleteCauseOf(run) : null;
  const verdictTitle =
    report.status === 'completed' && report.verdict !== 'accept'
      ? 'Completed'
      : report.status === 'incomplete' && run !== undefined
        ? incompleteTitle(run)
        : verdict.title;
  const verdictNote = cause === null ? verdict.note : INCOMPLETE_NOTE[cause];
  return (
    <Section title="Summary">
      <KeyValueList
        items={[
          { id: 'goal', term: 'Goal', value: report.goal },
          {
            id: 'verdict',
            term: 'Verdict',
            value: (
              <span className="stack">
                <strong>{verdictTitle}</strong>
                <span className="subtle">{verdictNote}</span>
              </span>
            ),
          },
          {
            id: 'workflow',
            term: 'Workflow version',
            value: (
              <>
                v{report.workflow.version} <Hash value={report.workflow.contentHash} label="workflow content hash" />
              </>
            ),
          },
          { id: 'profiles', term: 'Profiles used', value: profilesUsed(report.steps) },
          { id: 'providers', term: 'Providers', value: providersUsed(report.steps) },
          ...(run === undefined
            ? []
            : [
                {
                  id: 'revisions',
                  term: 'Revisions',
                  value: `${String(run.revisionCycle)} of ${String(run.limits.maxRevisionCycles)} revision cycles`,
                },
              ]),
          ...(report.snapshotUsed
            ? [{ id: 'snapshot', term: 'Snapshot', value: 'The preserved snapshot was used; files changed after it are not reflected.' }]
            : []),
        ]}
      />
    </Section>
  );
}

/** incomplete-report: leads with the terminal status and reason, and the steps that did not finish. */
export function TerminalLead({ report, run }: { readonly report: ReportV1; readonly run: RunDetail | undefined }) {
  if (report.status === 'completed') return null;
  const p = statusPresentation('run', report.status);
  const unfinished = report.steps.filter((s) => s.state !== 'succeeded');
  const title =
    report.status === 'incomplete'
      ? run === undefined
        ? 'Incomplete'
        : incompleteTitle(run)
      : report.status === 'cancelled'
        ? 'Cancelled: the run was stopped before it finished'
        : 'Failed: the run stopped because of an internal error';
  return (
    <InlineAlert tone={p.tone} title={title}>
      {run?.statusDetail == null ? null : (
        <p>
          {run.statusDetail.userMessage} <span className="subtle">(code <code>{run.statusDetail.code}</code>)</span>
        </p>
      )}
      {unfinished.length > 0 ? (
        <div className="stack">
          <p>Steps that did not finish:</p>
          <ul>
            {unfinished.map((s) => (
              <li key={`${s.stepKey}-${String(s.revisionIndex)}-${String(s.retryIndex)}`}>
                {stepTitle(s)}: <StatusBadge kind="step" value={s.state} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p>Useful artifacts are still listed below and can be exported.</p>
    </InlineAlert>
  );
}

export function FindingsSection({ findings, error, hasFindings }: { readonly findings: FindingsV1 | undefined; readonly error: unknown; readonly hasFindings: boolean }) {
  let body: ReactNode;
  if (!hasFindings) body = <p className="subtle">The review step did not produce findings in this run.</p>;
  else if (error !== null && error !== undefined) {
    body = <p className="subtle">The findings could not be loaded ({errorTitle(toViewError(error))}).</p>;
  } else if (findings === undefined) body = <Skeleton lines={4} />;
  else body = <FindingsView value={findings} headingLevel={3} />;
  return (
    <Section title="Findings" aside={findings === undefined ? undefined : <span className="subtle">{findings.findings.length} findings</span>}>
      {body}
    </Section>
  );
}

export function LimitationsSection({ report }: { readonly report: ReportV1 }) {
  return (
    <Section title="Limitations">
      {report.limitations.length === 0 ? (
        <p className="subtle">No limitations were recorded.</p>
      ) : (
        <ul>
          {report.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function CostSection({ report }: { readonly report: ReportV1 }) {
  const t = report.totals;
  const total = addMicrousd(t.settledReported, t.settledCalculated, t.settledEstimated);
  return (
    <Section title="Total tracked cost">
      <p className="text-2xl font-semibold">
        <Money value={total} certainty={t.settledEstimated > 0 ? 'estimated' : null} />
      </p>
      <KeyValueList
        items={[
          { id: 'rep', term: 'Reported', value: <Money value={t.settledReported} /> },
          { id: 'calc', term: 'Calculated', value: <Money value={t.settledCalculated} /> },
          { id: 'est', term: 'Estimated', value: <Money value={t.settledEstimated} certainty="estimated" /> },
          { id: 'unk', term: 'Unknown liability', value: <Money value={t.unknown} /> },
          { id: 'allow', term: 'Run allowance', value: <Money value={t.allowance} /> },
        ]}
      />
      {report.unknownLiabilities.length > 0 ? (
        <div className="stack">
          <h3 className="section-label">Unresolved charges</h3>
          <ul className="small">
            {report.unknownLiabilities.map((u) => (
              <li key={u.attemptId}>
                {stepTitle(u)}: up to <Money value={u.liabilityMicrousd} /> ({u.state === 'unknown' ? 'outcome unknown' : 'abandoned'})
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="subtle small">Tracked by Relay; your provider invoice may differ.</p>
    </Section>
  );
}

const ARTIFACT_NAMES: Readonly<Record<keyof ReportV1['artifacts'], string>> = {
  findings: 'Findings (JSON)',
  plan: 'Plan (JSON)',
  patch: 'Patch (.patch)',
  review: 'Review notes (JSON)',
};

export function ArtifactsSection({ report, onExport }: { readonly report: ReportV1; readonly onExport: () => void }) {
  const present = (Object.keys(ARTIFACT_NAMES) as Array<keyof ReportV1['artifacts']>).filter((k) => report.artifacts[k] !== null);
  return (
    <Section title="Artifacts">
      {report.status === 'completed' ? null : <p className="subtle">Still useful even though the run did not complete.</p>}
      <ul className="small">
        <li>Run report (Markdown)</li>
        {present.map((k) => (
          <li key={k}>
            {ARTIFACT_NAMES[k]}
            {k === 'patch' && report.status !== 'completed' ? ' · latest proposal, not accepted' : ''}
          </li>
        ))}
      </ul>
      <div className="actions">
        <Button onClick={onExport}>Export artifacts…</Button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Export dialog (export-dialog / export-failed)

export interface ExportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly hasPatch: boolean;
  readonly initial: ExportWhat;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onExport: (what: ExportWhat) => void;
}

/** What to export; main shows the folder dialog. A failure changes nothing: "Run is intact; retry export only." */
export function ExportDialog({ open, onOpenChange, hasPatch, initial, pending, error, onExport }: ExportDialogProps) {
  const [what, setWhat] = useState<ExportWhat>(hasPatch ? initial : 'report');
  const failed = error !== null && error !== undefined;
  const e = failed ? toViewError(error) : null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={failed ? 'Export failed' : 'Export the run'}
      description={failed ? undefined : 'Relay asks where to save; it never exports into the project folder.'}
      footer={
        <DialogFooter
          primaryLabel={failed ? 'Retry export' : what === 'both' ? 'Export 2 files' : 'Export'}
          secondaryLabel={failed ? 'Close' : 'Cancel'}
          pending={pending}
          onPrimary={() => {
            onExport(what);
          }}
        />
      }
    >
      {failed && e !== null ? (
        <InlineAlert tone="danger" title={errorTitle(e)}>
          <p>Run is intact; retry export only.</p>
          <p className="subtle">
            Error code <code>{e.code}</code>. No run data, ledger entries, or artifacts were changed.
          </p>
        </InlineAlert>
      ) : null}
      <RadioGroup<ExportWhat>
        legend="What to export"
        value={what}
        onValueChange={setWhat}
        options={[
          { value: 'report', label: 'Report (Markdown)' },
          { value: 'patch', label: 'Patch (.patch)', disabled: !hasPatch, ...(hasPatch ? {} : { description: 'This run has no patch.' }) },
          { value: 'both', label: 'Both', description: '2 files', disabled: !hasPatch },
        ]}
      />
      <p className="subtle small">Export excludes credentials, raw provider payloads, and diagnostics.</p>
    </Dialog>
  );
}
