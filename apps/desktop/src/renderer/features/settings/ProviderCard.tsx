import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { CircleCheck, CircleX, KeyRound, PlugZap, Trash2, TriangleAlert } from 'lucide-react';
import type { CredentialStorageMode, ProviderStatus } from '@relay/contracts';
import { Button, ConfirmDialog, ErrorView, KeyValueList, RelativeTime } from '../../components/ui';
import { toViewError } from '../../api/errors';
import { paths } from '../shell/paths';
import { NotAvailableNotice } from '../common/NotAvailableNotice';
import { ApiKeyField, apiKeyError } from '../providers/ApiKeyField';
import { TestOutcomeView } from '../providers/TestOutcomeView';
import type { TestOutcome } from '../providers/useProviderMutations';
import {
  useConnectProvider,
  useDisconnectProvider,
  useTestProvider,
} from '../providers/useProviderMutations';

type ProviderState = 'connected' | 'not-connected' | 'auth-failed';

export function providerState(p: ProviderStatus): ProviderState {
  if (!p.connected) return 'not-connected';
  return p.lastTest?.ok === false ? 'auth-failed' : 'connected';
}

const STATE_BADGE: Readonly<
  Record<ProviderState, { label: string; tone: string; icon: typeof CircleCheck }>
> = {
  connected: { label: 'Connected', tone: 'success', icon: CircleCheck },
  'not-connected': { label: 'Not connected', tone: 'neutral', icon: CircleX },
  'auth-failed': { label: 'Auth failed', tone: 'danger', icon: TriangleAlert },
};

const STORAGE_TEXT: Readonly<Record<ProviderStatus['storage'], string>> = {
  os_protected: 'Stored with macOS Keychain protection (safeStorage)',
  session: 'Memory only · cleared when Relay quits',
  none: 'No key stored',
};

export interface ProviderCardProps {
  readonly provider: ProviderStatus;
  readonly secureStorageAvailable: boolean;
  readonly now: number;
}

/**
 * One provider in Settings → Providers (mock settings-providers): redacted label, storage, last test, and
 * Test / Replace / Remove. Keys go to main only; this card never holds one after submit.
 */
export function ProviderCard({ provider: p, secureStorageAvailable, now }: ProviderCardProps) {
  const titleId = useId();
  const navigate = useNavigate();
  const state = providerState(p);
  const badge = STATE_BADGE[state];
  const BadgeIcon = badge.icon;
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{
    readonly source: 'test' | 'connect';
    readonly test: TestOutcome;
  } | null>(null);
  const connect = useConnectProvider();
  const test = useTestProvider();
  const disconnect = useDisconnectProvider();
  const showForm = state === 'not-connected' || replacing;

  const submit = (storage: CredentialStorageMode) => {
    const problem = apiKeyError(apiKey);
    setKeyError(problem);
    if (problem !== null) return;
    const key = apiKey;
    setApiKey(''); // FR-02: the key leaves React state on submit.
    connect.mutate(
      { providerId: p.providerId, apiKey: key, storage },
      {
        onSuccess: (res) => {
          setOutcome({ source: 'connect', test: res.test });
          setReplacing(false);
        },
      },
    );
  };

  const onErrorAction = (action: string) => {
    if (action === 'increase_allowance') void navigate(paths.settings('data'));
    if (action === 'reconnect_provider') setReplacing(true);
    if (action === 'use_session_key') submit('session');
  };

  const lastTest = p.lastTest;
  return (
    <section className="card stack" aria-labelledby={titleId}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h3 id={titleId}>{p.displayName}</h3>
        <span className={`badge ${badge.tone}`}>
          <BadgeIcon aria-hidden="true" />
          {badge.label}
        </span>
      </div>
      {p.connected ? (
        <KeyValueList
          items={[
            {
              id: 'key',
              term: 'Key',
              value: `${p.redactedLabel ?? 'saved'}${state === 'auth-failed' ? ' (rejected)' : ''}`,
              mono: true,
            },
            { id: 'storage', term: 'Storage', value: STORAGE_TEXT[p.storage] },
            {
              id: 'test',
              term: 'Last test',
              value:
                lastTest === null ? (
                  'Not tested yet'
                ) : (
                  <>
                    <RelativeTime epochMs={lastTest.at} now={now} /> ·{' '}
                    {lastTest.ok
                      ? 'passed'
                      : `failed${lastTest.code === undefined ? '' : ` · ${lastTest.code}`}`}
                  </>
                ),
            },
          ]}
        />
      ) : null}
      {p.providerId === 'openai' ? (
        <p className="small muted">
          OpenAI can store responses (the <code>store</code> option) so Relay can look up a request whose
          outcome is unknown after a crash. Each project can turn off “Store responses at OpenAI” in Settings
          → Projects; doing so limits that recovery.
        </p>
      ) : null}
      {p.connected ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Button
            icon={PlugZap}
            pending={test.isPending}
            onClick={() => {
              test.mutate(p.providerId, {
                onSuccess: (res) => {
                  setOutcome({ source: 'test', test: res });
                },
              });
            }}
          >
            Test connection
          </Button>
          <Button
            icon={KeyRound}
            onClick={() => {
              setReplacing((r) => !r);
            }}
            aria-expanded={replacing}
          >
            Replace key
          </Button>
          <ConfirmDialog
            open={confirmRemove}
            onOpenChange={setConfirmRemove}
            title={`Remove the ${p.displayName} key?`}
            consequences="Relay deletes the stored key. Runs whose profiles use this provider pause before their next call until you connect it again. Finished runs are not affected."
            confirmLabel="Remove key"
            cancelLabel="Keep the key"
            pending={disconnect.isPending}
            onConfirm={() => {
              disconnect.mutate(p.providerId, {
                onSettled: () => {
                  setConfirmRemove(false);
                  setOutcome(null);
                },
              });
            }}
            trigger={
              <Button variant="danger" icon={Trash2}>
                Remove key
              </Button>
            }
          />
        </div>
      ) : null}
      {showForm ? (
        <div className="stack">
          <ApiKeyField
            label={replacing ? `Replacement ${p.displayName} API key` : `${p.displayName} API key`}
            value={apiKey}
            onValueChange={(v) => {
              setApiKey(v);
              if (keyError !== null) setKeyError(null);
            }}
            error={keyError}
            disabled={connect.isPending}
            hint={
              secureStorageAvailable
                ? 'Masked. Relay sends a deliberately small test request after saving. Only a redacted label is shown afterwards.'
                : 'Masked. Kept in memory for this session only; secure storage is unavailable and Relay never stores keys in plaintext.'
            }
          />
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {secureStorageAvailable ? (
              <>
                <Button
                  variant="primary"
                  pending={connect.isPending}
                  onClick={() => {
                    submit('os_protected');
                  }}
                >
                  Test and save to Keychain
                </Button>
                <Button
                  disabled={connect.isPending}
                  onClick={() => {
                    submit('session');
                  }}
                >
                  Use for this session only
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="primary"
                  pending={connect.isPending}
                  onClick={() => {
                    submit('session');
                  }}
                >
                  Test and use for this session
                </Button>
                <Button disabled aria-describedby={`${titleId}-no-keychain`}>
                  Save to Keychain (unavailable)
                </Button>
                <span id={`${titleId}-no-keychain`} className="small subtle">
                  OS credential protection is unavailable on this computer.
                </span>
              </>
            )}
          </div>
        </div>
      ) : null}
      {connect.error === null ? null : (
        <ErrorView error={toViewError(connect.error)} onAction={onErrorAction} />
      )}
      {disconnect.error === null ? null : (
        <ErrorView error={toViewError(disconnect.error)} onAction={() => undefined} />
      )}
      {outcome === null ? null : outcome.source === 'test' && outcome.test.kind === 'not_tested' ? (
        <NotAvailableNotice error={outcome.test.error}>
          The key is saved. Relay uses it when a run starts.
        </NotAvailableNotice>
      ) : (
        <TestOutcomeView
          providerName={p.displayName}
          redactedLabel={p.redactedLabel}
          outcome={outcome.test}
          onErrorAction={onErrorAction}
        />
      )}
    </section>
  );
}
