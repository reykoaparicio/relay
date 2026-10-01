import { useCallback, useId, useState } from 'react';
import { Download, SearchCode } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import { findingsV1Schema, patchV1Schema, reportV1Schema } from '@relay/contracts';
import type { ArtifactContent, ExportWhat } from '@relay/contracts';
import {
  Button,
  ButtonLink,
  CopyButton,
  EmptyState,
  ErrorView,
  InlineAlert,
  LazyDiffViewer,
  PageHeader,
  Skeleton,
  StatusBadge,
  Tabs,
  useToast,
} from '../components/ui';
import type { Panel } from '../components/ui';
import { toViewError } from '../api/errors';
import { diffStats } from '../features/outputs/OutputViews';
import {
  ArtifactsSection,
  CostSection,
  ExportDialog,
  FindingsSection,
  LimitationsSection,
  SummarySection,
  TerminalLead,
} from '../features/report/ReportSections';
import { useArtifactExport } from '../features/run-inspector/useRunExports';
import { runLabel } from '../features/runs/run-display';
import { href, paths } from '../features/shell/paths';
import { useArtifact } from '../hooks/useArtifact';
import { useNavPerf } from '../hooks/useNavPerf';
import { useRun } from '../hooks/useRun';

/** The JSON value of an artifact, or undefined (text artifacts, or not loaded yet). */
function jsonOf(content: ArtifactContent | undefined): unknown {
  return content?.kind === 'json' ? content.value : undefined;
}

/** Run report (10 J8, report.html): report / patch tabs, export dialog, incomplete-report lead. */
export function ReportPage() {
  const { projectId = '', runId = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const toast = useToast();
  const runQ = useRun(runId);
  const run = runQ.data;
  const reportQ = useArtifact(run?.reportArtifactId);
  const reportParsed = reportV1Schema.safeParse(jsonOf(reportQ.data?.content));
  const report = reportParsed.success ? reportParsed.data : undefined;
  const findingsQ = useArtifact(report?.artifacts.findings);
  const findingsParsed = findingsV1Schema.safeParse(jsonOf(findingsQ.data?.content));
  const findings = findingsParsed.success ? findingsParsed.data : undefined;
  const patchId = report?.artifacts.patch ?? null;
  const patchQ = useArtifact(patchId);
  const patchParsed = patchV1Schema.safeParse(jsonOf(patchQ.data?.content));
  const patch = patchParsed.success ? patchParsed.data : undefined;
  const exporter = useArtifactExport(runId);
  const [exportOpen, setExportOpen] = useState<ExportWhat | null>(null);
  const bannerId = useId();
  const tab = search.get('tab') === 'patch' && patchId !== null ? 'patch' : 'report';

  useNavPerf('report', report !== undefined || (run !== undefined && run.reportArtifactId === null));

  const setTab = useCallback(
    (id: string) => {
      setSearch(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('tab', id);
          return next;
        },
        { replace: true },
      );
    },
    [setSearch],
  );

  const openExport = (what: ExportWhat) => {
    exporter.reset();
    setExportOpen(what);
  };

  const doExport = (what: ExportWhat) => {
    exporter.mutate(what, {
      onSuccess: (res) => {
        setExportOpen(null);
        if (res.exported) {
          toast.show({ key: `export:${runId}:${what}`, title: 'Export saved', body: res.displayPaths.join(', '), tone: 'success' });
        }
      },
    });
  };

  const header = (
    <PageHeader
      title="Run report"
      breadcrumbs={[
        { label: 'Runs', href: href(paths.runs(projectId)) },
        {
          label: run === undefined ? 'Run' : `${runLabel(run.id)} · ${run.workflow.name} v${String(run.workflow.version)}`,
          href: href(paths.run(projectId, runId)),
        },
        { label: 'Report' },
      ]}
      status={run === undefined ? undefined : <StatusBadge kind="run" value={run.status} pauseReason={run.pauseReason} />}
      actions={
        <>
          <ButtonLink as={Link} variant="ghost" icon={SearchCode} to={paths.run(projectId, runId)}>
            Open run inspector
          </ButtonLink>
          {run?.reportArtifactId == null ? null : (
            <Button
              variant="primary"
              icon={Download}
              onClick={() => {
                openExport('report');
              }}
            >
              Export…
            </Button>
          )}
        </>
      }
    />
  );

  const loadError = runQ.error ?? reportQ.error;
  if (loadError !== null) {
    return (
      <>
        {header}
        <ErrorView
          error={toViewError(loadError)}
          onAction={() => {
            void runQ.refetch();
            void reportQ.refetch();
          }}
        />
      </>
    );
  }
  if (run === undefined) {
    return (
      <>
        {header}
        <div aria-busy="true">
          <Skeleton lines={6} height={40} />
        </div>
      </>
    );
  }
  if (run.reportArtifactId === null) {
    return (
      <>
        {header}
        <EmptyState
          title="No report yet"
          body="Relay writes the report when the run ends (completed, incomplete, cancelled, or failed)."
          actions={
            <ButtonLink as={Link} to={paths.run(projectId, runId)}>
              Open run inspector
            </ButtonLink>
          }
        />
      </>
    );
  }

  const notModified = (
    <InlineAlert tone="success" title="Original project files were not modified.">
      <p id={bannerId}>The patch is a proposal stored in Relay&apos;s run artifacts. Review it, then apply it yourself if you choose.</p>
    </InlineAlert>
  );

  if (report === undefined) {
    return (
      <>
        {header}
        <div aria-busy="true">
          <Skeleton lines={8} height={32} />
        </div>
      </>
    );
  }

  const reportContent = (
    <div className="stack">
      <SummarySection report={report} run={run} />
      <FindingsSection findings={findings} error={findingsQ.error} hasFindings={report.artifacts.findings !== null} />
      <LimitationsSection report={report} />
      <div className="grid grid-cols-2 items-start gap-5 max-[1024px]:grid-cols-1">
        <CostSection report={report} />
        <ArtifactsSection
          report={report}
          onExport={() => {
            openExport('report');
          }}
        />
      </div>
    </div>
  );

  const patchText = patch?.files.map((f) => f.unifiedDiff).join('\n') ?? '';
  const patchContent =
    patchId === null ? null : (
      <section className="card" aria-labelledby="report-patch-heading">
        <div className="card-header">
          <h2 id="report-patch-heading">Proposed patch</h2>
          <div className="actions">
            {patch === undefined ? null : <CopyButton value={patchText} label="Copy patch" />}
            <Button
              icon={Download}
              onClick={() => {
                openExport('patch');
              }}
            >
              Export patch…
            </Button>
          </div>
        </div>
        {patchQ.error !== null ? (
          <ErrorView
            error={toViewError(patchQ.error)}
            onAction={() => {
              void patchQ.refetch();
            }}
          />
        ) : patch === undefined ? (
          <Skeleton lines={8} />
        ) : (
          <div className="stack">
            <p className="subtle">
              {report.status === 'completed' ? 'Accepted by the workflow reviewer.' : 'Latest proposal; not accepted by the workflow reviewer.'}
            </p>
            <LazyDiffViewer files={patch.files} />
            <div className="stack">
              <h3 className="section-label">Files in patch</h3>
              <ul className="small">
                {patch.files.map((f) => {
                  const s = diffStats(f.unifiedDiff);
                  return (
                    <li key={f.relPath}>
                      <span className="mono">{f.relPath}</span> +{s.adds} −{s.dels}
                    </li>
                  );
                })}
              </ul>
            </div>
            <p className="subtle small">
              Suggested test cases are proposals only and were not executed. To apply the patch, use your own tools (for
              example <code>git apply</code>) in your own terminal.
            </p>
          </div>
        )}
      </section>
    );

  const tabs: Panel[] = [{ id: 'report', label: 'Report', content: reportContent }];
  if (patchContent !== null) tabs.push({ id: 'patch', label: 'Patch', content: patchContent });

  return (
    <>
      {header}
      <TerminalLead report={report} run={run} />
      {notModified}
      <Tabs label="Report sections" tabs={tabs} value={tab} onValueChange={setTab} />
      {exportOpen === null ? null : (
        <ExportDialog
          open
          onOpenChange={(open) => {
            if (!open) setExportOpen(null);
          }}
          hasPatch={patchId !== null}
          initial={exportOpen}
          pending={exporter.isPending}
          error={exporter.error}
          onExport={doExport}
        />
      )}
    </>
  );
}
