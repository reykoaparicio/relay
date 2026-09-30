import { useId } from 'react';
import { CircleCheck, Loader, TriangleAlert, CircleX } from 'lucide-react';
import type { RunnerState } from '@relay/contracts';
import { ErrorView, KeyValueList, RelativeTime, Skeleton } from '../../components/ui';
import type { KeyValueItem } from '../../components/ui';
import { toViewError } from '../../api/errors';
import { useAppInfo } from '../../hooks/useAppInfo';
import { useDiagnostics } from '../../hooks/useDiagnostics';
import { NOW_IDLE_INTERVAL_MS, useNow } from '../../hooks/useNow';
import { formatBytes } from '../run-setup/PreviewPanel';

const RUNNER: Readonly<Record<RunnerState, { label: string; tone: string; icon: typeof CircleCheck }>> = {
  ready: { label: 'Healthy', tone: 'success', icon: CircleCheck },
  starting: { label: 'Starting', tone: 'info', icon: Loader },
  restarting: { label: 'Restarting', tone: 'warning', icon: TriangleAlert },
  unavailable: { label: 'Unavailable', tone: 'danger', icon: CircleX },
};

/** Settings → Diagnostics (§18.3): runner heartbeat, schema version, unresolved calls, provider mode, version/build. */
export function DiagnosticsSection() {
  const titleId = useId();
  const diagnostics = useDiagnostics();
  const info = useAppInfo();
  const now = useNow(NOW_IDLE_INTERVAL_MS, diagnostics.dataUpdatedAt);
  const d = diagnostics.data;
  const i = info.data;
  const error = diagnostics.error ?? info.error;

  let body;
  if (error !== null) {
    body = (
      <ErrorView
        error={toViewError(error)}
        onAction={() => {
          void diagnostics.refetch();
          void info.refetch();
        }}
      />
    );
  } else if (d === undefined || i === undefined) {
    body = (
      <div aria-busy="true">
        <Skeleton lines={8} />
      </div>
    );
  } else {
    const runner = RUNNER[d.runner.state];
    const RunnerIcon = runner.icon;
    const items: KeyValueItem[] = [
      {
        id: 'runner',
        term: 'Runner heartbeat',
        value: (
          <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className={`badge ${runner.tone}`}>
              <RunnerIcon aria-hidden="true" />
              {runner.label}
            </span>
            <span className="small">
              {d.runner.lastHeartbeatAt === null ? (
                'No heartbeat yet'
              ) : (
                <>
                  Last beat <RelativeTime epochMs={d.runner.lastHeartbeatAt} now={now} />
                </>
              )}
              {d.runner.pid === null ? '' : ` · pid ${String(d.runner.pid)}`} · {String(d.runner.restarts)}{' '}
              restart{d.runner.restarts === 1 ? '' : 's'}
            </span>
          </span>
        ),
      },
      {
        id: 'schema',
        term: 'Database schema',
        value: `Version ${String(d.db.schemaVersion)} · ${d.db.migrationsPending === 0 ? 'current' : `${String(d.db.migrationsPending)} migration(s) pending`} · ${formatBytes(d.db.sizeBytes)}`,
        mono: true,
      },
      {
        id: 'unresolved',
        term: 'Unresolved calls',
        value:
          d.unresolvedAttempts === 0
            ? 'None'
            : `${String(d.unresolvedAttempts)} with an unknown outcome · decide them from the run inspector`,
      },
      {
        id: 'mode',
        term: 'Provider mode',
        value:
          i.providerMode === 'fake'
            ? `Fake providers${i.fakeScenario === null ? '' : ` · scenario ${i.fakeScenario}`} (no real requests)`
            : 'Live providers',
      },
      {
        id: 'storage',
        term: 'Credential storage',
        value: d.secureStorage.available
          ? `Available · ${d.secureStorage.backend}`
          : `Unavailable · ${d.secureStorage.backend} (session-only keys)`,
      },
      {
        id: 'catalog',
        term: 'Price catalog',
        value: `${d.catalog.version ?? 'none loaded'} · ${String(d.catalog.models)} models`,
        mono: true,
      },
      { id: 'prompts', term: 'Prompt templates', value: `${String(d.prompts.loaded)} loaded` },
      { id: 'version', term: 'App version', value: i.version, mono: true },
      { id: 'build', term: 'Build id', value: i.buildId, mono: true },
      {
        id: 'platform',
        term: 'Platform',
        value: `${i.platform} · Electron ${i.electron} · Node ${i.node}${i.isPackaged ? '' : ' · development build'}`,
      },
      { id: 'data', term: 'Data folder', value: i.userDataDisplayPath, mono: true },
    ];
    body = (
      <>
        <KeyValueList items={items} />
        <p className="small muted">
          Diagnostics exports include versions, migration state, error codes and attempt ids. They exclude API
          keys, prompts, file contents and memory text. Export and backup arrive in a later milestone.
        </p>
      </>
    );
  }
  return (
    <section
      className="card stack"
      aria-labelledby={titleId}
      aria-busy={d === undefined && error === null ? true : undefined}
    >
      <h2 id={titleId}>Diagnostics</h2>
      {body}
    </section>
  );
}

/** Settings → About (§18.5): version and build id. */
export function AboutSection() {
  const titleId = useId();
  const info = useAppInfo();
  return (
    <section className="card stack" aria-labelledby={titleId}>
      <h2 id={titleId}>About</h2>
      {info.data === undefined ? (
        info.error === null ? (
          <Skeleton lines={2} />
        ) : (
          <ErrorView error={toViewError(info.error)} onAction={() => void info.refetch()} />
        )
      ) : (
        <p>
          Relay <span className="mono">{info.data.version}</span> · build{' '}
          <span className="mono">{info.data.buildId}</span>. A local desktop prototype: project data, runs,
          memory and the usage ledger are stored on this computer. Model calls are processed by the providers
          you connect.
        </p>
      )}
      <p className="small muted">Open-source license notices arrive in a later milestone.</p>
    </section>
  );
}
