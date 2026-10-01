import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { CircleCheck, CircleX, KeyRound, PlugZap, Trash2, TriangleAlert } from 'lucide-react';
import type { RefObject } from 'react';
import type { CredentialStorageMode, ProviderStatus } from '@relay/contracts';
import { Button, ConfirmDialog, ErrorView, KeyValueList, RelativeTime } from '../../components/ui';
import { toViewError } from '../../api/errors';
import { paths } from '../shell/paths';
import { useNextAction } from '../common/useNextAction';
import { ApiKeyField, apiKeyError } from '../providers/ApiKeyField';
import { TestOutcomeView } from '../providers/TestOutcomeView';
import type { TestOutcome } from '../providers/useProviderMutations';
import {
  useConnectProvider,
  useDisconnectProvider,
  useTestProvider,
} from '../providers/useProviderMutations';

type ProviderState = 'connected' | 'not-connected' | 'auth-failed' | 'test-failed';

/** "Auth failed" only when the provider rejected the key (AUTH_REQUIRED); other failed tests keep their own code. */
export function providerState(p: ProviderStatus): ProviderState {
  if (!p.connected) return 'not-connected';
  if (p.lastTest?.ok !== false) return 'connected';
  return p.lastTest.code === 'AUTH_REQUIRED' ? 'auth-failed' : 'test-failed';
}

const STATE_BADGE: Readonly<
  Record<ProviderState, { label: string; tone: string; icon: typeof CircleCheck }>
> = {
  connected: { label: 'Connected', tone: 'success', icon: CircleCheck },
  'not-connected': { label: 'Not connected', tone: 'neutral', icon: CircleX },
  'auth-failed': { label: 'Auth failed', tone: 'danger', icon: TriangleAlert },
  'test-failed': { label: 'Test failed', tone: 'warning', icon: TriangleAlert },
};

const STORAGE_TEXT: Readonly<Record<ProviderStatus['storage'], string>> = {
  os_protected: 'Stored with macOS Keychain protection (safeStorage)',
  session: 'Memory only · cleared when Relay quits',
  none: 'No key stored',
};

/**
 * A11Y-02: removing the key removes the Remove / Replace / Test buttons with the connected state, so whichever had
 * focus (the dialog returns it to the Remove trigger) is gone. Focus moves to the card heading instead of <body>.
 */
function useHeadingFocusOnDisconnect(connected: boolean, heading: RefObject<HTMLHeadingElement | null>): void {
  const wasConnected = useRef(connected);
  useLayoutEffect(() => {
    const disconnected = wasConnected.current && !connected;
    wasConnected.current = connected;
    if (!disconnected) return;
    const active = document.activeElement;
    if (active === null || active === document.body || active === document.documentElement) heading.current?.focus();
  }, [connected, heading]);
}

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
  const [outcome, setOutcome] = useState<{ readonly test: TestOutcome } | null>(null);
  /** Session-only mode chosen from a SECURE_STORAGE_UNAVAILABLE recovery (the Keychain save is not offered). */
  const [sessionOnly, setSessionOnly] = useState(false);
  /** The key was cleared on submit and the last connect failed: ask for it again (it is never kept). */
  const [needsRepaste, setNeedsRepaste] = useState(false);
  const keyFieldId = `${titleId}-key`;
  const connect = useConnectProvider();
  const test = useTestProvider();
  const disconnect = useDisconnectProvider();
  const showForm = state === 'not-connected' || replacing || needsRepaste;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useHeadingFocusOnDisconnect(p.connected, headingRef);
  const secure = secureStorageAvailable && !sessionOnly;

  const focusKey = () => {
    // After the form re-renders (it may only appear with this state change).
    setTimeout(() => {
      document.getElementById(keyFieldId)?.focus();
    }, 0);
  };

  const submit = (storage: CredentialStorageMode) => {
    const problem = apiKeyError(apiKey);
    setKeyError(problem);
    if (problem !== null) return;
    const key = apiKey;
    setApiKey(''); // FR-02: the key leaves React state on submit.
    setNeedsRepaste(false);
    connect.mutate(
      { providerId: p.providerId, apiKey: key, storage },
      {
        onSuccess: (res) => {
          setOutcome({ test: res.test });
          setReplacing(false);
          setSessionOnly(false);
        },
        onError: () => {
          setNeedsRepaste(true);
        },
      },
    );
  };

  /** Asks for the key again; never re-submits (the key was cleared on submit, FR-02). */
  const askForKey = () => {
    connect.reset();
    setReplacing(true);
    setNeedsRepaste(true);
    setKeyError(null);
    focusKey();
  };

  const onErrorAction = useNextAction({
    increase_allowance: () => void navigate(paths.settings('data')),
    reconnect_provider: askForKey,
    use_session_key: () => {
      setSessionOnly(true);
      askForKey();
    },
  });

  const lastTest = p.lastTest;
  return (
    <section className="card stack" aria-labelledby={titleId}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h3 id={titleId} ref={headingRef} tabIndex={-1}>
          {p.displayName}
        </h3>
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
                  setOutcome({ test: res });
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
            onOpenChange={(open) => {
              setConfirmRemove(open);
              if (!open) disconnect.reset();
            }}
            returnFocusFallback={headingRef}
            title={`Remove the ${p.displayName} key?`}
            consequences="Relay deletes the stored key. Runs whose profiles use this provider pause before their next call until you connect it again. Finished runs are not affected."
            confirmLabel="Remove key"
            cancelLabel="Keep the key"
            pending={disconnect.isPending}
            onConfirm={() => {
              // The dialog closes only on success; a failure stays in the dialog next to the action that caused it.
              disconnect.mutate(p.providerId, {
                onSuccess: () => {
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
          >
            {disconnect.error === null ? null : (
              <ErrorView live="assertive" error={toViewError(disconnect.error)} onAction={onErrorAction} />
            )}
          </ConfirmDialog>
        </div>
      ) : null}
      {showForm ? (
        <div className="stack">
          <ApiKeyField
            id={keyFieldId}
            label={replacing ? `Replacement ${p.displayName} API key` : `${p.displayName} API key`}
            value={apiKey}
            onValueChange={(v) => {
              setApiKey(v);
              if (keyError !== null) setKeyError(null);
            }}
            error={keyError}
            disabled={connect.isPending}
            hint={
              needsRepaste
                ? sessionOnly
                  ? 'The key was cleared for safety. Paste it again to use it for this session only.'
                  : 'The key was cleared for safety. Paste it again to retry.'
                : secure
                  ? 'Masked. Relay sends a deliberately small test request after saving. Only a redacted label is shown afterwards.'
                  : 'Masked. Kept in memory for this session only; secure storage is unavailable and Relay never stores keys in plaintext.'
            }
          />
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {secure ? (
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
        <ErrorView live="assertive" error={toViewError(connect.error)} onAction={onErrorAction} />
      )}
      {outcome === null ? null : (
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
