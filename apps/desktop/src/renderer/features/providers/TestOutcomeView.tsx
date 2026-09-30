import { InlineAlert, ErrorView, Money } from '../../components/ui';
import { toViewError } from '../../api/errors';
import { formatDuration } from '../../lib/format';
import type { TestOutcome } from './useProviderMutations';

export interface TestOutcomeViewProps {
  readonly providerName: string;
  /** Redacted label from the provider status ("sk-ant-…a1F9"); the key itself is never shown. */
  readonly redactedLabel: string | null;
  readonly outcome: TestOutcome;
  readonly onErrorAction?: Parameters<typeof ErrorView>[0]['onAction'];
}

/** The redacted result of a connect/test (FR-02): "Connected to Anthropic · sk-ant-…a1F9". */
export function TestOutcomeView({
  providerName,
  redactedLabel,
  outcome,
  onErrorAction = () => undefined,
}: TestOutcomeViewProps) {
  const label = redactedLabel === null ? null : <span className="mono">{redactedLabel}</span>;
  if (outcome.kind === 'passed') {
    const r = outcome.result;
    return (
      <InlineAlert
        tone="success"
        title={
          <>
            Connected to {providerName}
            {label === null ? null : <> · {label}</>}
          </>
        }
      >
        <p>
          Test request to <span className="mono">{r.modelProbed}</span> · {formatDuration(r.latencyMs)} ·{' '}
          <Money value={r.costMicrousd} certainty={r.certainty} />
        </p>
      </InlineAlert>
    );
  }
  if (outcome.kind === 'not_tested') {
    return (
      <InlineAlert
        tone="info"
        title={
          <>
            {providerName} key saved (not tested)
            {label === null ? null : <> · {label}</>}
          </>
        }
      >
        <p>Connection tests are not available yet in this build. Relay uses the key when a run starts.</p>
      </InlineAlert>
    );
  }
  const error = outcome.error === null || outcome.error === undefined ? null : toViewError(outcome.error);
  const appErr = error ?? outcome.result?.error ?? null;
  return (
    <div className="stack">
      <InlineAlert
        tone="warning"
        title={
          <>
            {providerName} key saved, but the connection test failed
            {label === null ? null : <> · {label}</>}
          </>
        }
      >
        <p>Check the key and replace it, or continue and fix it later in Settings.</p>
      </InlineAlert>
      {appErr === null ? null : <ErrorView error={appErr} onAction={onErrorAction} />}
    </div>
  );
}
