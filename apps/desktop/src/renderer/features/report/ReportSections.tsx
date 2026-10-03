// Sections of the run report (10 J8 ReportPage, report.html). Everything renders from the engine-generated
// `report.v1` artifact (type from `@relay/contracts` `outputs/report.v1`), never from a local shape.
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { addMicrousd } from '@relay/contracts';
import type { ExportWhat, FindingsV1, ReportV1, RunDetail } from '@relay/contracts';
import { Button, Dialog, DialogFooter, Hash, InlineAlert, KeyValueList, Money, RadioGroup, Skeleton, StatusBadge } from '../../components/ui';
import { APPROVAL_DECISION_LABELS, formatAbsoluteTime, PROVIDER_LABELS, statusPresentation, toIsoString } from '../../lib/format';
import { errorTitle, toViewError } from '../../api/errors';
import { FindingsView } from '../outputs/OutputViews';
import { EXPORT_PART_LABELS, retryWhatOf } from './export-results';
import type { ExportPartResult } from './export-results';
import { incompleteCauseOf, incompleteTitle, stepTitle } from '../run-inspector/inspector-model';
import type { IncompleteCause } from '../run-inspector/inspector-model';

type ReportStep = ReportV1['steps'][number];
type ReportApproval = NonNullable<ReportV1['approvals']>[number];
type ReportRevisions = NonNullable<ReportV1['revisions']>;

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

export function SummarySection({
  report,
  run,
  after,
}: {
  readonly report: ReportV1;
  readonly run: RunDetail | undefined;
  /** Shown under the summary list (the memory suggestions the run proposed). */
  readonly after?: ReactNode;
}) {
  const verdict = VERDICT_TEXT[report.status];
  const cause =
    report.status !== 'incomplete'
      ? null
      : ((run === undefined ? null : incompleteCauseOf(run)) ?? report.revisions?.incompleteCause ?? null);
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
          ...(report.snapshotUsed
            ? [{ id: 'snapshot', term: 'Snapshot', value: 'The preserved snapshot was used; files changed after it are not reflected.' }]
            : []),
        ]}
      />
      {after}
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

const NOT_RECORDED = 'Not recorded in this report.';

/** Why an approval stopped binding (contracts APPROVAL_STALE_REASONS, 06 F17). */
const INVALIDATED_TEXT: Readonly<Record<NonNullable<ReportApproval['invalidatedReason']>, string>> = {
  plan_changed: 'plan changed',
  scope_changed: 'file scope changed',
  project_changed: 'project files changed',
  provider_changed: 'providers changed',
};

function Timestamp({ epochMs }: { readonly epochMs: number }) {
  return <time dateTime={toIsoString(epochMs)}>{formatAbsoluteTime(epochMs)}</time>;
}

/**
 * Every approval the run opened, oldest first (`report.v1.approvals`, optional: reports from before wave 4 lack it).
 * The note is the user's own text, rendered as plain text.
 */
export function ApprovalsSection({ report }: { readonly report: ReportV1 }) {
  const approvals = report.approvals;
  let body: ReactNode;
  if (approvals === undefined) body = <p className="subtle">{NOT_RECORDED}</p>;
  else if (approvals.length === 0) body = <p className="subtle">No approval was requested.</p>;
  else {
    body = (
      <ul className="list">
        {approvals.map((a) => (
          <li key={a.approvalId} className="list-item" style={{ cursor: 'default' }} data-testid="report-approval">
            <span className="row">
              <span className="title">
                {stepTitle(a)}: {a.decision === null ? 'not decided' : APPROVAL_DECISION_LABELS[a.decision]}
              </span>
              {a.invalidatedReason === null ? null : (
                <span className="badge warning">invalidated: {INVALIDATED_TEXT[a.invalidatedReason]}</span>
              )}
            </span>
            <span className="meta">
              {a.decidedAt === null ? (
                <>
                  Opened <Timestamp epochMs={a.createdAt} />; no decision recorded
                </>
              ) : (
                <>
                  Decided <Timestamp epochMs={a.decidedAt} />
                </>
              )}{' '}
              · plan <Hash value={a.planHash} label={`plan hash of the ${stepTitle(a)} approval`} />
            </span>
            {a.note === null || a.note === '' ? null : (
              <p className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                Note: {a.note}
              </p>
            )}
          </li>
        ))}
      </ul>
    );
  }
  return <Section title="Approvals">{body}</Section>;
}

const INCOMPLETE_CAUSE_TEXT: Readonly<Record<NonNullable<ReportRevisions['incompleteCause']>, string>> = {
  revision_limit: 'Revision limit reached: the reviewer still requested changes.',
  verifier_incomplete: 'The workflow reviewer marked the result incomplete.',
};

/** Quality revision cycles vs the run limit, plan revisions, and why an incomplete run ended (`report.v1.revisions`). */
export function RevisionsSection({ report }: { readonly report: ReportV1 }) {
  const r = report.revisions;
  return (
    <Section title="Revisions">
      {r === undefined ? (
        <p className="subtle">{NOT_RECORDED}</p>
      ) : (
        <KeyValueList
          items={[
            { id: 'cycles', term: 'Revision cycles', value: `${String(r.cycles)} of ${String(r.maxCycles)}` },
            { id: 'plans', term: 'Plan revisions', value: String(r.planRevisions) },
            ...(report.status === 'incomplete'
              ? [
                  {
                    id: 'cause',
                    term: 'Why the run is incomplete',
                    value: r.incompleteCause === null ? 'Not recorded' : INCOMPLETE_CAUSE_TEXT[r.incompleteCause],
                  },
                ]
              : []),
          ]}
        />
      )}
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
        <Button onClick={onExport}>Export run…</Button>
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
  /**
   * Per-part rows of a partial export (E2 #10), or `null` before one. With rows, the dialog shows each file as
   * "Written" (path) or "Failed" (reason), and the primary action retries only the failed parts.
   */
  readonly parts?: readonly ExportPartResult[] | null;
}

/** "Written" / "Failed" rows of a partial export. Status is spelled out, never shown by color alone. */
function ExportPartRows({ parts }: { readonly parts: readonly ExportPartResult[] }) {
  return (
    <ul className="stack" aria-label="Exported files">
      {parts.map((p) => (
        <li key={p.what} data-testid="export-part">
          <strong>{EXPORT_PART_LABELS[p.what]}</strong>
          {': '}
          {p.state === 'written' ? (
            <>
              Written to <span className="mono">{p.displayPath}</span>
            </>
          ) : (
            <>
              Failed. {p.reason}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** What to export; main shows the folder dialog. A failure changes nothing: "Run is intact; retry export only." */
export function ExportDialog({ open, onOpenChange, hasPatch, initial, pending, error, onExport, parts = null }: ExportDialogProps) {
  const [what, setWhat] = useState<ExportWhat>(hasPatch ? initial : 'report');
  const failed = error !== null && error !== undefined;
  const e = failed ? toViewError(error) : null;
  const retryWhat = parts === null ? null : retryWhatOf(parts);
  const partial = parts !== null && retryWhat !== null;
  const failedCount = parts?.filter((p) => p.state === 'failed').length ?? 0;
  const title = partial ? 'Export partly saved' : failed ? 'Export failed' : 'Export the run';
  const primaryLabel = partial
    ? failedCount > 1
      ? 'Retry failed files'
      : 'Retry failed file'
    : failed
      ? 'Retry export'
      : what === 'both'
        ? 'Export 2 files'
        : 'Export';
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={failed || partial ? undefined : 'Relay asks where to save; it never exports into the project folder.'}
      footer={
        <DialogFooter
          primaryLabel={primaryLabel}
          secondaryLabel={failed || partial ? 'Close' : 'Cancel'}
          pending={pending}
          onPrimary={() => {
            onExport(partial ? retryWhat : what);
          }}
        />
      }
    >
      {partial ? (
        <InlineAlert tone="warning" live="polite" title={failedCount > 1 ? 'Some files were not saved' : 'One file was not saved'}>
          <p>Run is intact; retry only the files that failed.</p>
        </InlineAlert>
      ) : null}
      {failed && e !== null ? (
        <InlineAlert tone="danger" live="assertive" title={errorTitle(e)}>
          <p>Run is intact; retry export only.</p>
          <p className="subtle">
            Error code <code>{e.code}</code>. No run data, ledger entries, or artifacts were changed.
          </p>
        </InlineAlert>
      ) : null}
      {partial ? (
        <ExportPartRows parts={parts} />
      ) : (
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
      )}
      <p className="subtle small">Export excludes credentials, raw provider payloads, and diagnostics.</p>
    </Dialog>
  );
}
