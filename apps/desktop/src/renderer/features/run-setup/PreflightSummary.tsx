import type { ReactNode } from 'react';
import type { Microusd, ProfileWithWarnings, ProviderId, ProviderStatus, RunPreflight } from '@relay/contracts';
import { KeyValueList, Money } from '../../components/ui';
import type { KeyValueItem } from '../../components/ui';
import { formatBytes, formatTokensExact, PROVIDER_LABELS } from '../../lib/format';
import { ROLE_LABELS } from './model-steps';
import type { ModelStepRow } from './model-steps';
import { stepProviderId } from './preflight-issues';

export interface PreflightSummaryProps {
  readonly preflight: RunPreflight;
  readonly allowance: Microusd | null;
  /** Rows placed before the computed ones (project, workflow, …). */
  readonly leading?: readonly KeyValueItem[];
  readonly capBytes?: number | undefined;
}

/** Input summary of a preflight: files/bytes/tokens, memory, first reservation (§9.3), and the allowance. */
export function PreflightSummary({ preflight, allowance, leading = [], capBytes }: PreflightSummaryProps) {
  const s = preflight.inputSummary;
  const memoryCount = s.memoryRecords.length;
  const items: KeyValueItem[] = [
    ...leading,
    {
      id: 'files',
      term: 'Files',
      value: `${String(s.files)} · ${formatBytes(s.bytes)}${capBytes === undefined ? '' : ` of ${formatBytes(capBytes)}`}`,
      mono: true,
    },
    {
      id: 'tokens',
      term: 'Input tokens',
      value: `~${formatTokensExact(s.estimatedInputTokens)} est.`,
      mono: true,
    },
    {
      id: 'memory',
      term: 'Memory records',
      value:
        memoryCount === 0 ? (
          'None'
        ) : (
          <span className="stack" style={{ gap: 2 }}>
            <span>{`${String(memoryCount)} approved`}</span>
            <ul className="small" style={{ margin: 0, paddingLeft: 16 }} aria-label="Memory records this run includes">
              {s.memoryRecords.map((m) => (
                <li key={m.id}>
                  {m.title} <span className="subtle">{`rev ${String(m.revision)}${m.pinned ? ' · pinned' : ''}`}</span>
                </li>
              ))}
            </ul>
          </span>
        ),
    },
    {
      id: 'first',
      term: 'First reservation',
      value: <Money value={preflight.firstReservation.N} certainty="estimated" />,
    },
    { id: 'allowance', term: 'Run allowance', value: allowance === null ? '—' : <Money value={allowance} /> },
  ];
  return <KeyValueList items={items} />;
}

/** The roles each provider serves for a run, from the role → profile table (the form's selection, else the defaults). */
export function rolesByProvider(
  rows: readonly ModelStepRow[],
  selection: Readonly<Record<string, string>>,
  profiles: readonly ProfileWithWarnings[] | undefined,
): ReadonlyMap<ProviderId, readonly string[]> {
  const out = new Map<ProviderId, string[]>();
  for (const row of rows) {
    const id = stepProviderId(row.stepKey, rows, selection, profiles);
    if (id === null) continue;
    const roles = out.get(id) ?? [];
    const role = ROLE_LABELS[row.role];
    if (!roles.includes(role)) roles.push(role);
    out.set(id, roles);
  }
  return out;
}

/** A provider's connection state in words (never color alone). */
function providerStatusText(status: ProviderStatus | undefined): string | null {
  if (status === undefined) return null;
  if (!status.connected) return 'not connected';
  if (status.lastTest?.ok === false) return 'last connection test failed';
  return 'connected';
}

export interface ProvidersReceivingProps {
  readonly preflight: RunPreflight;
  readonly footnote?: ReactNode;
  /** What the run sends besides the goal: the selected files, or an imported diff. */
  readonly inputKind?: 'files' | 'diff';
  /** Roles per provider ({@link rolesByProvider}). */
  readonly roles?: ReadonlyMap<ProviderId, readonly string[]>;
  /** `providers.list`, for each provider's connection state. */
  readonly statuses?: readonly ProviderStatus[] | undefined;
}

/** "Providers that will receive this context" (§6.2): per provider, its roles, its status, and what it receives. */
export function ProvidersReceiving({ preflight, footnote, inputKind = 'files', roles, statuses }: ProvidersReceivingProps) {
  const ids = preflight.inputSummary.providersReceivingContext;
  const what = inputKind === 'diff' ? 'the goal, the imported diff and the included memory' : 'the goal, the selected files and the included memory';
  return (
    <div className="stack">
      {ids.length === 0 ? (
        <p className="small muted">No provider receives context for this run.</p>
      ) : (
        <ul className="stack small" style={{ margin: 0, paddingLeft: 18 }}>
          {ids.map((id) => {
            const r = roles?.get(id) ?? [];
            const status = providerStatusText(statuses?.find((p) => p.providerId === id));
            return (
              <li key={id}>
                <strong>{PROVIDER_LABELS[id]}</strong>
                {r.length === 0 ? null : ` as ${r.join(', ')}`}
                {status === null ? null : <span className="subtle"> · {status}</span>}
                <span className="block">Receives {what}.</span>
              </li>
            );
          })}
        </ul>
      )}
      {footnote === undefined ? null : <p className="small muted">{footnote}</p>}
    </div>
  );
}
