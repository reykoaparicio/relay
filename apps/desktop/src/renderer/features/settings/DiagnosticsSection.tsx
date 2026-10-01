import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { CircleCheck, ExternalLink, Loader, TriangleAlert, CircleX } from 'lucide-react';
import type { RunnerState } from '@relay/contracts';
import { Button, CopyButton, ErrorView, KeyValueList, RelativeTime, Skeleton } from '../../components/ui';
import type { KeyValueItem } from '../../components/ui';
import { toViewError } from '../../api/errors';
import { useAppInfo } from '../../hooks/useAppInfo';
import { useDiagnostics } from '../../hooks/useDiagnostics';
import { NOW_IDLE_INTERVAL_MS, useNow } from '../../hooks/useNow';
import { useOpenExternal } from '../common/useOpenExternal';
import { formatBytes } from '../../lib/format';
import { paths } from '../shell/paths';
import type { ThirdPartyNotices } from './third-party-notices';

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
          keys, prompts, file contents and memory text. Export diagnostics and create backups in{' '}
          <Link to={paths.settings('data')}>Storage &amp; data</Link>.
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

/** Electron's license (MIT). Relay itself has no published license page yet. */
export const ELECTRON_LICENSE_URL = 'https://github.com/electron/electron/blob/main/LICENSE';

/** How many package names a collapsed license group lists before "+N more". */
const SUMMARY_NAMES = 3;

type NoticesState =
  { status: 'loading' } | { status: 'ready'; notices: ThirdPartyNotices } | { status: 'failed' };

/** Lazily loads the build-generated license list (its own chunk: only About pays for it). */
function useThirdPartyNotices(): NoticesState {
  const [state, setState] = useState<NoticesState>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    import('./third-party-notices')
      .then((m) => m.loadThirdPartyNotices())
      .then(
        (notices) => {
          if (live) setState({ status: 'ready', notices });
        },
        () => {
          if (live) setState({ status: 'failed' });
        },
      );
    return () => {
      live = false;
    };
  }, []);
  return state;
}

function ThirdPartyLicenses() {
  const state = useThirdPartyNotices();
  if (state.status === 'loading') {
    return (
      <div aria-busy="true">
        <Skeleton lines={3} />
      </div>
    );
  }
  if (state.status === 'failed') {
    return <p className="small">The third-party license list could not be loaded.</p>;
  }
  const { notices } = state;
  if (notices.groups.length === 0) {
    return (
      <p className="small">
        The third-party license list is generated by production builds; this development build does not
        include it.
      </p>
    );
  }
  return (
    <>
      <p className="small">
        Relay includes {String(notices.packageCount)} open-source packages, listed below with their license
        texts.
        {notices.partial ? ' This list is incomplete for this build.' : ''}
      </p>
      <div className="stack" style={{ gap: 4 }}>
        {notices.groups.map((g) => {
          const names = g.packages.map((p) => `${p.name}@${p.version}`);
          const shown = names.slice(0, SUMMARY_NAMES).join(', ');
          const more = names.length > SUMMARY_NAMES ? ` +${String(names.length - SUMMARY_NAMES)} more` : '';
          return (
            <details key={names.join(' ')}>
              <summary className="small">
                <span className="mono">{g.license}</span> · {shown}
                {more}
              </summary>
              <div className="stack" style={{ gap: 4, marginTop: 4 }}>
                <p className="small mono">{names.join(', ')}</p>
                <div>
                  <CopyButton value={g.text} label={`Copy license text (${g.license}: ${shown}${more})`} />
                </div>
                <pre className="code prewrap small" aria-label={`License text for ${shown}${more}`}>
                  {g.text}
                </pre>
              </div>
            </details>
          );
        })}
      </div>
    </>
  );
}

/** Settings → About (§18.5): version and build id, and the third-party license notices (LIC-01). */
export function AboutSection() {
  const titleId = useId();
  const info = useAppInfo();
  const openExternal = useOpenExternal();
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
      <h3 className="section-label">Third-party licenses</h3>
      <p className="small">
        Relay is built on open-source software, including Electron (with Chromium and Node.js) and React. The
        notices for Chromium and its components ship with the app in{' '}
        <span className="mono">LICENSES.chromium.html</span> (Relay.app/Contents/Resources, next to{' '}
        <span className="mono">LICENSE.electron.txt</span>).
      </p>
      <ThirdPartyLicenses />
      <div>
        <Button
          size="sm"
          variant="ghost"
          icon={ExternalLink}
          pending={openExternal.isPending}
          onClick={() => {
            openExternal.mutate(ELECTRON_LICENSE_URL);
          }}
        >
          Electron license (opens in your browser)
        </Button>
      </div>
      {openExternal.error === null ? null : (
        <ErrorView
          error={toViewError(openExternal.error)}
          live="assertive"
          onAction={() => {
            openExternal.reset();
          }}
        />
      )}
    </section>
  );
}
