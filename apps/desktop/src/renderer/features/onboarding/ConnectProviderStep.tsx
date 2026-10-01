import { useId, useState } from 'react';
import { PlugZap } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { CredentialStorageMode, ProviderId } from '@relay/contracts';
import { Button, ErrorView, InlineAlert, RadioGroup, Skeleton } from '../../components/ui';
import { toViewError } from '../../api/errors';
import { PROVIDER_LABELS } from '../../lib/format';
import { useDiagnostics } from '../../hooks/useDiagnostics';
import { useProviders } from '../../hooks/useProviders';
import { ApiKeyField, apiKeyError } from '../providers/ApiKeyField';
import { TestOutcomeView } from '../providers/TestOutcomeView';
import { useConnectProvider } from '../providers/useProviderMutations';
import { useNextAction } from '../common/useNextAction';
import { paths } from '../shell/paths';
import { StepFrame } from './StepFrame';
import type { StepProps } from './StepFrame';

/** Providers offered in setup (the fake provider is test-only). */
const SETUP_PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'gemini'];

const KEY_SOURCE: Readonly<Record<ProviderId, string>> = {
  anthropic: 'API key from your Anthropic console',
  openai: 'API key from your OpenAI dashboard',
  gemini: 'API key from Google AI Studio',
  fake: 'Test provider',
};

/**
 * Step 3 `connect-provider`: provider select, masked key, Keychain vs session-only storage, then `providers.connect` →
 * `providers.test`. Only the redacted label is shown afterwards; the key leaves React state on submit.
 */
export function ConnectProviderStep({ state, dispatch, go }: StepProps) {
  const navigate = useNavigate();
  const providers = useProviders();
  const diagnostics = useDiagnostics();
  const connect = useConnectProvider();
  const secureAvailable = diagnostics.data?.secureStorage.available ?? true;
  const listed = (providers.data ?? []).filter((p) => SETUP_PROVIDERS.includes(p.providerId));
  const connectedIds = listed.filter((p) => p.connected).map((p) => p.providerId);
  const firstOpen = SETUP_PROVIDERS.find((id) => !connectedIds.includes(id)) ?? 'anthropic';

  const [providerId, setProviderId] = useState<ProviderId | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [storageChoice, setStorageChoice] = useState<CredentialStorageMode | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [needsRepaste, setNeedsRepaste] = useState(false);
  const keyFieldId = useId();

  const chosen = providerId ?? firstOpen;
  const storage: CredentialStorageMode = !secureAvailable ? 'session' : (storageChoice ?? 'os_protected');
  const lastForChosen = state.connected.find((c) => c.providerId === chosen);

  const submitKey = () => {
    const problem = apiKeyError(apiKey);
    setKeyError(problem);
    if (problem !== null) return;
    const key = apiKey;
    // Pin the choice: once connected, the default would move on to the next unconnected provider.
    setProviderId(chosen);
    // The key never stays in the DOM or React state after submit (FR-02).
    setApiKey('');
    setNeedsRepaste(false);
    connect.mutate(
      { providerId: chosen, apiKey: key, storage },
      {
        onSuccess: (outcome) => {
          dispatch({
            type: 'connected',
            entry: { providerId: chosen, status: outcome.status, test: outcome.test },
          });
        },
        onError: () => {
          setNeedsRepaste(true);
        },
      },
    );
  };

  /** Asks for the key again (it was cleared on submit and is never re-sent from memory). */
  const askForKey = () => {
    connect.reset();
    setNeedsRepaste(true);
    setKeyError(null);
    setTimeout(() => {
      document.getElementById(keyFieldId)?.focus();
    }, 0);
  };
  const onErrorAction = useNextAction({
    reconnect_provider: askForKey,
    use_session_key: () => {
      setStorageChoice('session');
      askForKey();
    },
    // providers.test BUDGET_BLOCKED: the setup allowance for connection tests is in Settings → Data.
    increase_allowance: () => void navigate(paths.settings('data')),
  });
  const onLoadAction = useNextAction({
    reload: () => void providers.refetch(),
    wait: () => void providers.refetch(),
  });

  const anyConnected = connectedIds.length > 0 || state.connected.length > 0;
  const otherProvider = SETUP_PROVIDERS.find((id) => id !== chosen && !connectedIds.includes(id));

  if (providers.data === undefined) {
    return (
      <StepFrame title="Connect a model provider" go={go} back="start-point">
        {providers.error === null ? (
          <div aria-busy="true">
            <Skeleton lines={4} />
          </div>
        ) : (
          <ErrorView error={toViewError(providers.error)} onAction={onLoadAction} />
        )}
      </StepFrame>
    );
  }

  return (
    <StepFrame
      title="Connect a model provider"
      intro="Relay sends model requests with your own API key. The key goes to the privileged part of the app and is never shown again; this screen only sees a redacted label."
      go={go}
      back="start-point"
      onFormSubmit={
        apiKey.trim() !== ''
          ? submitKey
          : anyConnected
            ? () => {
                go('select-project');
              }
            : undefined
      }
      primary={{
        label: 'Continue',
        onSubmit: () => {
          go('select-project');
        },
        disabled: !anyConnected,
        disabledReason: 'Connect a provider to continue.',
      }}
    >
      {connectedIds.length === 0 ? null : (
        <p className="small">
          Already connected:{' '}
          {listed
            .filter((p) => p.connected)
            .map((p) => `${p.displayName} · ${p.redactedLabel ?? 'key saved'}`)
            .join(', ')}
        </p>
      )}
      <RadioGroup
        legend="Provider"
        value={chosen}
        onValueChange={(v) => {
          setProviderId(v);
          setKeyError(null);
        }}
        options={SETUP_PROVIDERS.filter(
          (id) => listed.length === 0 || listed.some((p) => p.providerId === id),
        ).map((id) => ({
          value: id,
          label: PROVIDER_LABELS[id],
          description: connectedIds.includes(id) ? `${KEY_SOURCE[id]} · connected` : KEY_SOURCE[id],
        }))}
      />
      <ApiKeyField
        id={keyFieldId}
        label={`${PROVIDER_LABELS[chosen]} API key`}
        value={apiKey}
        onValueChange={(v) => {
          setApiKey(v);
          if (keyError !== null) setKeyError(null);
        }}
        error={keyError}
        disabled={connect.isPending}
        hint={
          needsRepaste
            ? 'The key was cleared for safety. Paste it again to retry.'
            : storage === 'os_protected'
              ? 'Masked. Stored with macOS Keychain protection and never shown again.'
              : 'Masked. Kept in memory for this session only and never shown again.'
        }
      />
      <RadioGroup
        legend="Where to keep the key"
        value={storage}
        onValueChange={setStorageChoice}
        options={[
          {
            value: 'os_protected',
            label: 'Store with macOS Keychain protection',
            description: secureAvailable
              ? 'Encrypted by the operating system. Relay remembers the key across launches.'
              : 'Unavailable on this computer: Relay could not use OS credential protection, and it never stores keys in plaintext.',
            disabled: !secureAvailable,
          },
          {
            value: 'session',
            label: 'Session only',
            description: 'Kept in memory until Relay quits. You paste it again next time.',
          },
        ]}
      />
      <div>
        <Button icon={PlugZap} pending={connect.isPending} onClick={submitKey}>
          Connect and test
        </Button>
      </div>
      {connect.error === null || connect.error === undefined ? null : (
        <ErrorView live="assertive" error={toViewError(connect.error)} onAction={onErrorAction} />
      )}
      {lastForChosen === undefined ? null : (
        <TestOutcomeView
          providerName={lastForChosen.status.displayName}
          redactedLabel={lastForChosen.status.redactedLabel}
          outcome={lastForChosen.test}
          onErrorAction={onErrorAction}
        />
      )}
      {anyConnected ? (
        <InlineAlert
          tone="info"
          title="A second provider is optional for setup"
          actions={
            otherProvider === undefined ? undefined : (
              <Button
                onClick={() => {
                  setProviderId(otherProvider);
                  setApiKey('');
                  connect.reset();
                }}
              >
                Add {PROVIDER_LABELS[otherProvider]} too
              </Button>
            )
          }
        >
          <p>
            It is required for the multi-provider demo, where different roles in one run use different
            providers. You can add it now or later in Settings.
          </p>
        </InlineAlert>
      ) : null}
    </StepFrame>
  );
}
