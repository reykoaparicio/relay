import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup, FileDown, FileJson, FileSpreadsheet, Trash2 } from 'lucide-react';
import type { Microusd, Project } from '@relay/contracts';
import {
  Button,
  Checkbox,
  Dialog,
  DialogFooter,
  Disclosure,
  ErrorView,
  Field,
  InlineAlert,
  MoneyInput,
  NumberInput,
  Select,
  Skeleton,
  TextInput,
  useToast,
} from '../../components/ui';
import { call } from '../../api/client';
import { toViewError } from '../../api/errors';
import { qk } from '../../api/keys';
import { formatAbsoluteTime, formatBytes, formatMonth } from '../../lib/format';
import { useAppInfo } from '../../hooks/useAppInfo';
import { useIdempotentMutation } from '../../hooks/useIdempotentMutation';
import { RUNS_MAX_PAGE, useRuns } from '../../hooks/useRuns';
import { runLabel } from '../../lib/format';
import { MutationError } from '../common/MutationError';
import { useRetryAction } from '../common/useNextAction';
import { dollarsText } from '../run-setup/limits';
import { paths } from '../shell/paths';
import { FallbackProjectNote, SettingsProjectPicker, useSettingsProject } from './useSettingsProject';

/** Raw-response retention bounds (02 `app.updateSettings`, §12.3). */
const RETENTION_BOUNDS = { min: 1, max: 365 } as const;

/** The last `count` calendar months, newest first, as `YYYY-MM` (ledger month export). */
export function recentMonths(now: number, count = 12): string[] {
  const d = new Date(now);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${String(m.getFullYear())}-${String(m.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return formatMonth(new Date(y ?? 2000, (m ?? 1) - 1, 1).getTime(), undefined, { withYear: true });
}

const DIAGNOSTICS_INCLUDED = [
  'App version, build id and platform',
  'Database schema version and migration state',
  'Runner state, restarts and heartbeat times',
  'Error codes and correlation ids',
  'Attempt ids with their outcome (no content)',
] as const;
const DIAGNOSTICS_EXCLUDED = ['API keys and credentials', 'Prompts and model responses', 'Project file contents', 'Memory text'] as const;

/** "Saved to …" / "Cancelled" toast for a save-dialog export. */
function useExportToast() {
  const toast = useToast();
  return (key: string, what: string, res: { readonly exported: boolean; readonly displayPath?: string | undefined }) => {
    toast.show(
      res.exported
        ? { key, title: `${what} saved`, ...(res.displayPath === undefined ? {} : { body: res.displayPath }), tone: 'success' }
        : { key, title: `${what} not saved`, body: 'The save dialog was cancelled.', tone: 'info' },
    );
  };
}

/** Settings → Storage & data (10 J10, §12.3, §18.3–18.4). */
export function DataSection() {
  const { project, explicit, projects, settings, choose } = useSettingsProject();
  const retry = useRetryAction(() => {
    void projects.refetch();
    void settings.refetch();
  });
  return (
    <section className="stack" aria-label="Storage & data">
      {projects.error === null ? null : <ErrorView error={toViewError(projects.error)} onAction={retry} />}
      {projects.data === undefined || project === undefined ? null : (
        <SettingsProjectPicker projects={projects.data} value={project.id} onChange={choose} />
      )}
      <BackupCard />
      <ExportsCard project={project} explicit={explicit} />
      {settings.data === undefined ? (
        settings.error === null ? (
          <div className="card" aria-busy="true">
            <Skeleton lines={4} />
          </div>
        ) : (
          <ErrorView error={toViewError(settings.error)} onAction={retry} />
        )
      ) : (
        <RetentionCard
          key={`${String(settings.data.rawResponseRetentionDays)}:${String(settings.data.setupAllowanceMicrousd)}`}
          retentionDays={settings.data.rawResponseRetentionDays}
          setupAllowance={settings.data.setupAllowanceMicrousd}
        />
      )}
      {project === undefined ? null : <PurgeCard project={project} explicit={explicit} />}
    </section>
  );
}

function BackupCard() {
  const titleId = useId();
  const info = useAppInfo();
  const backup = useIdempotentMutation('relay/v1/app.createBackup');
  return (
    <section className="card stack" aria-labelledby={titleId}>
      <div className="card-header">
        <h2 id={titleId}>Data folder and backup</h2>
        <Button icon={DatabaseBackup} pending={backup.isPending} onClick={() => { backup.mutate({}); }}>
          Create backup
        </Button>
      </div>
      <p>
        Data folder <span className="mono">{info.data?.userDataDisplayPath ?? '…'}</span>
      </p>
      <p className="small muted">
        Contains the SQLite database, run artifacts, memory records and the usage ledger. Never API keys: those stay in
        the operating system&apos;s credential store. Relay does not claim the full database is encrypted.
      </p>
      {backup.data === undefined ? null : (
        <InlineAlert tone="success" title="Backup created">
          <p>
            <span className="mono">{backup.data.backupDisplayPath}</span> · {formatBytes(backup.data.sizeBytes)} ·{' '}
            {formatAbsoluteTime(backup.data.createdAt)}
          </p>
        </InlineAlert>
      )}
      <MutationError error={backup.error} />
    </section>
  );
}

/** Which runs a project export includes: every run (default), or the ones ticked here (`projects.export.runIds`). */
function ExportRunPicker({
  projectId,
  picked,
  onChange,
}: {
  readonly projectId: string;
  readonly picked: readonly string[] | null;
  readonly onChange: (ids: readonly string[] | null) => void;
}) {
  const runs = useRuns(projectId, { limit: RUNS_MAX_PAGE });
  const list = runs.data?.pages.flatMap((p) => p.items) ?? [];
  const chosen = new Set(picked ?? list.map((r) => r.id));
  const summary =
    picked === null ? 'Runs: all runs are included (choose runs…)' : `Runs: ${String(picked.length)} of ${String(list.length)} chosen`;
  return (
    <Disclosure summary={summary}>
      {runs.error !== null ? (
        <MutationError error={runs.error} handlers={{ reload: () => void runs.refetch() }} />
      ) : runs.data === undefined ? (
        <Skeleton lines={3} />
      ) : list.length === 0 ? (
        <p className="subtle">This project has no runs yet.</p>
      ) : (
        <fieldset className="fieldset field">
          <legend>Runs to include</legend>
          <div className="row" style={{ gap: 8 }}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onChange(null);
              }}
            >
              All runs
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onChange([]);
              }}
            >
              None
            </Button>
          </div>
          <ul className="stack small" style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 240, overflow: 'auto' }}>
            {list.map((r) => (
              <li key={r.id}>
                <Checkbox
                  label={`${runLabel(r.id)} · ${r.goal}`}
                  checked={chosen.has(r.id)}
                  onCheckedChange={(checked) => {
                    const next = list.map((x) => x.id).filter((id) => (id === r.id ? checked : chosen.has(id)));
                    onChange(next.length === list.length ? null : next);
                  }}
                />
              </li>
            ))}
          </ul>
          {picked !== null && picked.length === 0 ? <span className="error">Choose at least one run, or All runs.</span> : null}
          {runs.hasNextPage ? <p className="subtle">The newest {String(list.length)} runs are listed; All runs exports every run.</p> : null}
        </fieldset>
      )}
    </Disclosure>
  );
}

function ExportsCard({ project, explicit }: { readonly project: Project | undefined; readonly explicit: boolean }) {
  const titleId = useId();
  const monthId = useId();
  const exportToast = useExportToast();
  const [months] = useState(() => recentMonths(Date.now()));
  const [month, setMonth] = useState(months[0] ?? '');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  // null = every run (no `runIds` sent); a list = only the runs the user ticked.
  const [pickedRuns, setPickedRuns] = useState<{ readonly projectId: string; readonly ids: readonly string[] } | null>(null);
  const runIds = pickedRuns !== null && pickedRuns.projectId === project?.id ? pickedRuns.ids : null;
  const projectExport = useMutation({
    mutationFn: (input: { readonly projectId: string; readonly runIds: readonly string[] | null }) =>
      call('relay/v1/projects.export', { projectId: input.projectId, ...(input.runIds === null ? {} : { runIds: [...input.runIds] }) }),
    onSuccess: (res) => {
      exportToast('export:project', 'Project export', res);
    },
  });
  const ledgerExport = useMutation({
    mutationFn: (input: { readonly projectId: string; readonly month: string }) =>
      call('relay/v1/ledger.export', { projectId: input.projectId, month: input.month }),
    onSuccess: (res) => {
      exportToast('export:ledger', 'Ledger export', res);
    },
  });
  const diagnosticsExport = useMutation({
    mutationFn: () => call('relay/v1/app.exportDiagnostics', {}),
    onSuccess: (res) => {
      setDiagnosticsOpen(false);
      exportToast('export:diagnostics', 'Diagnostics export', res);
    },
  });

  return (
    <section className="card stack" aria-labelledby={titleId}>
      <h2 id={titleId}>Exports</h2>
      <p className="small muted">Relay asks where to save each file. Exports never contain API keys.</p>
      {project === undefined ? null : <FallbackProjectNote project={project} explicit={explicit} />}
      <div className="stack">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div className="stack" style={{ gap: 2 }}>
            <strong>Project (JSON){project === undefined ? null : <>: {project.name}</>}</strong>
            <span className="small muted">
              Memory records with all revisions, workflow versions and run reports. No credentials and no absolute folder
              path.
            </span>
          </div>
          <Button
            icon={FileJson}
            disabled={project === undefined || runIds?.length === 0}
            pending={projectExport.isPending}
            onClick={() => {
              if (project !== undefined) projectExport.mutate({ projectId: project.id, runIds });
            }}
          >
            Export project…
          </Button>
        </div>
        {project === undefined ? null : (
          <ExportRunPicker
            projectId={project.id}
            picked={runIds}
            onChange={(ids) => {
              setPickedRuns(ids === null ? null : { projectId: project.id, ids });
            }}
          />
        )}
        <MutationError error={projectExport.error} />
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <Field label="Ledger month (CSV)" id={monthId} hint="Every ledger entry of the project in that month, tracked by Relay.">
            {(control) => (
              <Select
                {...control}
                value={month}
                onValueChange={setMonth}
                options={months.map((m) => ({ value: m, label: monthLabel(m) }))}
                style={{ maxWidth: 240 }}
              />
            )}
          </Field>
          <Button
            icon={FileSpreadsheet}
            disabled={project === undefined}
            pending={ledgerExport.isPending}
            onClick={() => {
              if (project !== undefined) ledgerExport.mutate({ projectId: project.id, month });
            }}
          >
            Export ledger (CSV)…
          </Button>
        </div>
        <MutationError error={ledgerExport.error} />
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div className="stack" style={{ gap: 2 }}>
            <strong>Diagnostics (redacted)</strong>
            <span className="small muted">For bug reports. You review what is included before saving.</span>
          </div>
          <Button
            icon={FileDown}
            onClick={() => {
              diagnosticsExport.reset();
              setDiagnosticsOpen(true);
            }}
          >
            Export diagnostics…
          </Button>
        </div>
      </div>
      <Dialog
        open={diagnosticsOpen}
        onOpenChange={setDiagnosticsOpen}
        title="Export diagnostics"
        description="Review what the file contains. Nothing is sent anywhere; Relay only saves the file where you choose."
        footer={
          <DialogFooter
            primaryLabel="Choose where to save…"
            pending={diagnosticsExport.isPending}
            onPrimary={() => {
              diagnosticsExport.mutate();
            }}
          />
        }
      >
        <div className="grid grid-cols-2 gap-4 max-[700px]:grid-cols-1">
          <div className="stack" style={{ gap: 4 }}>
            <span className="section-label">Included</span>
            <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
              {DIAGNOSTICS_INCLUDED.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <span className="section-label">Never included</span>
            <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
              {DIAGNOSTICS_EXCLUDED.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        </div>
        <MutationError error={diagnosticsExport.error} />
      </Dialog>
    </section>
  );
}

function RetentionCard({ retentionDays, setupAllowance }: { readonly retentionDays: number; readonly setupAllowance: Microusd }) {
  const titleId = useId();
  const retentionId = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [daysText, setDaysText] = useState(String(retentionDays));
  const [allowanceText, setAllowanceText] = useState(dollarsText(setupAllowance));
  const [allowance, setAllowance] = useState<Microusd | null>(setupAllowance);
  const [submitted, setSubmitted] = useState(false);
  const days = /^\d+$/.test(daysText.trim()) ? Number.parseInt(daysText, 10) : null;
  const daysError =
    days === null || days < RETENTION_BOUNDS.min || days > RETENTION_BOUNDS.max
      ? `Enter a whole number of days from ${String(RETENTION_BOUNDS.min)} to ${String(RETENTION_BOUNDS.max)}.`
      : undefined;
  const allowanceError = allowance === null ? 'Enter an amount like 0.05.' : undefined;
  const changed = days !== retentionDays || allowance !== setupAllowance;
  const save = useMutation({
    mutationFn: () =>
      call('relay/v1/app.updateSettings', {
        ...(days === null || days === retentionDays ? {} : { rawResponseRetentionDays: days }),
        ...(allowance === null || allowance === setupAllowance ? {} : { setupAllowanceMicrousd: allowance }),
      }),
    onSuccess: (s) => {
      queryClient.setQueryData(qk.settings(), s);
      toast.show({ key: 'settings:data', title: 'Data settings saved', tone: 'success' });
    },
  });
  return (
    <section className="card stack" aria-labelledby={titleId}>
      <h2 id={titleId}>Retention and setup allowance</h2>
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (daysError !== undefined || allowanceError !== undefined || !changed) return;
          save.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
          <Field
            label="Keep raw provider responses (days)"
            id={retentionId}
            hint="Redacted raw responses older than this are deleted at the next cleanup, so lowering it takes effect then, not at once. Structured outputs, reports and the ledger are kept."
            error={submitted ? daysError : undefined}
            required
          >
            {(control) => (
              <NumberInput
                {...control}
                value={daysText}
                min={RETENTION_BOUNDS.min}
                max={RETENTION_BOUNDS.max}
                onValueChange={(text) => {
                  setDaysText(text);
                }}
              />
            )}
          </Field>
          <MoneyInput
            label="Setup allowance per month"
            value={allowanceText}
            hint="Pays for provider connection tests (a few cents each). When it is used up, tests are blocked until next month."
            {...(submitted && allowanceError !== undefined ? { error: allowanceError } : {})}
            onValueChange={(text, parsed) => {
              setAllowanceText(text);
              setAllowance(parsed);
            }}
          />
        </div>
        <MutationError error={save.error} />
        <div className="actions">
          <Button type="submit" variant="primary" pending={save.isPending} disabled={!changed}>
            Save data settings
          </Button>
        </div>
      </form>
    </section>
  );
}

const PURGE_PHRASE = 'purge';

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/**
 * The purge result as a toast (03 C8). `purgedArtifacts` / `failed` are optional in the contract (older runners omit
 * them). Files that could not be removed stay unpurged and the next retention sweep retries them, so the toast says so
 * instead of reporting success.
 */
function purgeToast(res: { readonly purgedSnapshots: number; readonly purgedArtifacts?: number | undefined; readonly failed?: number | undefined }): {
  readonly title: string;
  readonly body: string;
  readonly tone: 'success' | 'warning';
} {
  const parts = [`${plural(res.purgedSnapshots, 'run snapshot no longer holds', 'run snapshots no longer hold')} memory copies.`];
  if (res.purgedArtifacts !== undefined) parts.push(`${plural(res.purgedArtifacts, 'stored file', 'stored files')} removed.`);
  const failed = res.failed ?? 0;
  if (failed > 0) {
    parts.push(`${plural(failed, 'file', 'files')} could not be removed; they will be retried.`);
    return { title: 'Project history partly purged', body: parts.join(' '), tone: 'warning' };
  }
  return { title: 'Project history purged', body: parts.join(' '), tone: 'success' };
}

function PurgeCard({ project, explicit }: { readonly project: Project; readonly explicit: boolean }) {
  const titleId = useId();
  const phraseId = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const purge = useMutation({
    mutationFn: () => call('relay/v1/memory.purgeProjectHistory', { projectId: project.id, confirmPhrase: PURGE_PHRASE }),
    onSuccess: (res) => {
      setOpen(false);
      setPhrase('');
      void queryClient.invalidateQueries({ queryKey: ['memory', project.id] });
      void queryClient.invalidateQueries({ queryKey: ['memory-record'] });
      toast.show({ key: `purge:${project.id}`, ...purgeToast(res) });
    },
  });
  const confirmed = phrase.trim().toLowerCase() === PURGE_PHRASE;
  return (
    <section className="card stack" aria-labelledby={titleId}>
      <h2 id={titleId} ref={headingRef} tabIndex={-1}>
        Purge project history
      </h2>
      <FallbackProjectNote project={project} explicit={explicit} />
      <p className="small muted">
        Removes memory copies kept inside run snapshots of <strong>{project.name}</strong>, and the stored raw provider
        responses and context manifests of its runs. Run reports that quoted that memory lose the quoted text. To stop using a single record, archive or delete it on the{' '}
        <Link to={paths.memory(project.id)}>Memory</Link> page instead.
      </p>
      <div>
        <Button
          variant="danger"
          icon={Trash2}
          onClick={() => {
            purge.reset();
            setPhrase('');
            setOpen(true);
          }}
        >
          Purge project history…
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        returnFocusFallback={headingRef}
        title={`Purge the history of “${project.name}”?`}
        description="This cannot be undone."
        footer={
          <DialogFooter
            primaryLabel="Purge project history"
            primaryVariant="danger"
            primaryDisabled={!confirmed}
            pending={purge.isPending}
            onPrimary={() => {
              if (confirmed) purge.mutate();
            }}
          />
        }
      >
        <p>
          Project: <strong>{project.name}</strong> <span className="mono small">({project.rootDisplayPath})</span>
        </p>
        <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
          <li>Memory copies inside every run snapshot of “{project.name}” are removed.</li>
          <li>Stored raw provider responses and context manifests of these runs are removed.</li>
          <li>Memory records keep their text and revisions. Runs, ledgers, reports, plans and patches are kept. Project files are never touched.</li>
        </ul>
        <Field label={`Type “${PURGE_PHRASE}” to confirm purging the history of “${project.name}”`} id={phraseId}>
          {(control) => <TextInput {...control} value={phrase} onValueChange={setPhrase} autoComplete="off" />}
        </Field>
        <MutationError error={purge.error} />
      </Dialog>
    </section>
  );
}
