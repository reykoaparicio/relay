import { Check, X } from 'lucide-react';
import type { CapabilityWarning, CatalogModel, ModelCapabilities } from '@relay/contracts';
import { PROVIDER_LABELS } from '../../../lib/format/labels';
import { moneyColumnPrecision } from '../../../lib/format/money';
import type { MoneyPrecision } from '../../../lib/format/money';
import { CopyButton } from '../CopyButton';
import { Disclosure } from '../Disclosure';
import { KeyValueList } from '../KeyValueList';
import { DataTable } from '../DataTable';
import type { DataTableColumn } from '../DataTable';
import { Money } from '../Money';

export interface CatalogTableProps {
  readonly entries: readonly CatalogModel[];
  readonly catalogVersion: string;
  /** Per-model capability check results (from profiles.list warnings), keyed by model id. */
  readonly profileChecks?: Readonly<Record<string, readonly CapabilityWarning[]>>;
}

type BooleanCapability = {
  [K in keyof ModelCapabilities]-?: ModelCapabilities[K] extends boolean ? K : never;
}[keyof ModelCapabilities];

const CAPABILITIES: ReadonlyArray<{ readonly key: BooleanCapability; readonly header: string }> = [
  { key: 'structuredOutput', header: 'Structured output' },
  { key: 'streaming', header: 'Streaming' },
  { key: 'tools', header: 'Tools' },
  { key: 'supportsRequestLookup', header: 'Request lookup' },
  { key: 'supportsTokenCounting', header: 'Token counting' },
];

/** Yes/No as text; the glyph is decorative (color and glyph are never the only signal). */
function YesNo({ value }: { readonly value: boolean }) {
  const Icon = value ? Check : X;
  return (
    <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
      <Icon aria-hidden="true" width={14} height={14} />
      {value ? 'Yes' : 'No'}
    </span>
  );
}

/** Supported capabilities as short text; the full yes/no list is in the row's details. */
function CapabilityList({ capabilities }: { readonly capabilities: ModelCapabilities }) {
  const yes = CAPABILITIES.filter((c) => capabilities[c.key]);
  if (yes.length === 0) return <span className="subtle">None listed</span>;
  return (
    <ul className="chip-list">
      {yes.map((c) => (
        <li key={c.key} className="tag">
          {c.header}
        </li>
      ))}
    </ul>
  );
}

/** Per-row details: every capability as Yes/No, cache prices, catalog version, source, effective date. */
function ModelDetails({ e, p }: { readonly e: CatalogModel; readonly p: { readonly cacheRead: MoneyPrecision; readonly cacheWrite: MoneyPrecision } }) {
  return (
    <Disclosure summary="Details" className="catalog-details">
      <KeyValueList
        className="small"
        items={[
          ...CAPABILITIES.map((c) => ({ id: c.key, term: c.header, value: <YesNo value={e.capabilities[c.key]} /> })),
          { id: 'cache-read', term: 'Cache read / MTok', value: <Money value={e.prices.cacheRead} precision={p.cacheRead} /> },
          { id: 'cache-write', term: 'Cache write / MTok', value: <Money value={e.prices.cacheWrite} precision={p.cacheWrite} /> },
          { id: 'version', term: 'Catalog version', value: <span className="mono">{e.catalogVersion}</span> },
          {
            id: 'effective',
            term: 'Effective',
            value: (
              <time dateTime={e.effectiveDate} className="mono">
                {e.effectiveDate}
              </time>
            ),
          },
          {
            id: 'source',
            term: 'Source',
            // Shown as text with a copy button, never as a clickable external link (§11.4).
            value: (
              <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                <span className="mono small">{e.source}</span>
                <CopyButton value={e.source} label={`Copy source URL for ${e.displayName}`} />
              </span>
            ),
          },
        ]}
      />
    </Disclosure>
  );
}

function buildColumns(
  entries: readonly CatalogModel[],
  profileChecks: CatalogTableProps['profileChecks'],
): ReadonlyArray<DataTableColumn<CatalogModel>> {
  // One precision per price column.
  const p = {
    input: moneyColumnPrecision(entries.map((e) => e.prices.input)),
    output: moneyColumnPrecision(entries.map((e) => e.prices.output)),
    cacheRead: moneyColumnPrecision(entries.map((e) => e.prices.cacheRead)),
    cacheWrite: moneyColumnPrecision(entries.map((e) => e.prices.cacheWrite)),
  };
  const columns: Array<DataTableColumn<CatalogModel>> = [
    {
      key: 'model',
      header: 'Model',
      // The name may wrap; the id never breaks mid-token ("claude-/haiku-/4-5").
      minWidth: '11rem',
      cell: (e) => (
        <span className="stack" style={{ gap: 0 }}>
          <span>{e.displayName}</span>
          <span className="mono subtle whitespace-nowrap">{e.modelId}</span>
          <ModelDetails e={e} p={p} />
        </span>
      ),
    },
    { key: 'provider', header: 'Provider', nowrap: true, cell: (e) => PROVIDER_LABELS[e.providerId] },
    { key: 'capabilities', header: 'Capabilities', minWidth: '9rem', cell: (e) => <CapabilityList capabilities={e.capabilities} /> },
    { key: 'input', header: 'Input / MTok', numeric: true, cell: (e) => <Money value={e.prices.input} precision={p.input} /> },
    { key: 'output', header: 'Output / MTok', numeric: true, cell: (e) => <Money value={e.prices.output} precision={p.output} /> },
  ];
  if (profileChecks) {
    columns.push({
      key: 'warnings',
      header: 'Profile checks',
      cell: (e) => {
        const warnings = profileChecks[e.modelId] ?? [];
        if (warnings.length === 0) return <span className="subtle">No issues</span>;
        return (
          <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
            {warnings.map((w) => (
              <li key={`${w.code}:${w.stepKey ?? ''}:${w.profileId ?? ''}`}>{w.message}</li>
            ))}
          </ul>
        );
      },
    });
  }
  return columns;
}

/** Settings → Models: versioned capability and price catalog (§8.3, §9.2). Prices are µUSD per MTok. */
export function CatalogTable({ entries, catalogVersion, profileChecks }: CatalogTableProps) {
  return (
    <div className="stack">
      <p className="subtle">
        Price catalog version <span className="mono">{catalogVersion}</span>. Prices are per million tokens. Each
        model&apos;s Details list cache prices, every capability, and the price source.
      </p>
      <DataTable
        caption={`Model catalog, version ${catalogVersion}`}
        columns={buildColumns(entries, profileChecks)}
        rows={entries}
        getRowKey={(e) => `${e.providerId}:${e.modelId}:${e.catalogVersion}`}
        emptyState={<p className="subtle">No models in the catalog.</p>}
      />
    </div>
  );
}
