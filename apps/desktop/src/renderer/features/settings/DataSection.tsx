import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup, FileDown, FileJson, FileSpreadsheet, Trash2 } from 'lucide-react';
import type { Microusd, Project } from '@relay/contracts';
import {
  Button,
  Dialog,
  DialogFooter,
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
import { formatAbsoluteTime } from '../../lib/format';
import { useAppInfo } from '../../hooks/useAppInfo';
import { useIdempotentMutation } from '../../hooks/useIdempotentMutation';
import { MutationError } from '../common/MutationError';
import { useRetryAction } from '../common/useNextAction';
import { dollarsText } from '../run-setup/limits';
import { formatBytes } from '../run-setup/PreviewPanel';
import { paths } from '../shell/paths';
import { FallbackProjectNote, SettingsProjectPicker, useSettingsProject } from './useSettingsProject';

/** Raw-response retention bounds (02 `app.updateSettings`, §12.3). */
export const RETENTION_BOUNDS = { min: 1, max: 365 } as const;

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
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(y ?? 2000, (m ?? 1) - 1, 1));
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

function ExportsCard({ project, explicit }: { readonly project: Project | undefined; readonly explicit: boolean }) {
  const titleId = useId();
  const monthId = useId();
  const exportToast = useExportToast();
  const [months] = useState(() => recentMonths(Date.now()));
  const [month, setMonth] = useState(months[0] ?? '');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const projectExport = useMutation({
    mutationFn: (projectId: string) => call('relay/v1/projects.export', { projectId }),
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
            disabled={project === undefined}
            pending={projectExport.isPending}
            onClick={() => {
              if (project !== undefined) projectExport.mutate(project.id);
            }}
          >
            Export project…
          </Button>
        </div>
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
            hint="Redacted raw responses older than this are deleted. Structured outputs, reports and the ledger are kept."
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
      toast.show({
        key: `purge:${project.id}`,
        title: 'Project history purged',
        body: `${String(res.purgedSnapshots)} run snapshot${res.purgedSnapshots === 1 ? '' : 's'} no longer hold memory copies.`,
        tone: 'success',
      });
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
        Removes memory copies kept inside run snapshots of <strong>{project.name}</strong>, and old memory revisions. Run
        reports that quoted that memory lose the quoted text. To stop using a single record, archive or delete it on the{' '}
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
          <li>Earlier revisions of memory records are removed; each record keeps its current text.</li>
          <li>Runs, ledgers and artifacts other than memory copies are kept. Project files are never touched.</li>
        </ul>
        <Field label={`Type “${PURGE_PHRASE}” to confirm purging the history of “${project.name}”`} id={phraseId}>
          {(control) => <TextInput {...control} value={phrase} onValueChange={setPhrase} autoComplete="off" />}
        </Field>
        <MutationError error={purge.error} />
      </Dialog>
    </section>
  );
}
