import { Check, X } from 'lucide-react';
import type { CapabilityWarning, CatalogModel, ModelCapabilities } from '@relay/contracts';
import { PROVIDER_LABELS } from '../../../lib/format/labels';
import { CopyButton } from '../CopyButton';
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

function buildColumns(profileChecks: CatalogTableProps['profileChecks']): ReadonlyArray<DataTableColumn<CatalogModel>> {
  const columns: Array<DataTableColumn<CatalogModel>> = [
    {
      key: 'model',
      header: 'Model',
      cell: (e) => (
        <span className="stack" style={{ gap: 0 }}>
          <span>{e.displayName}</span>
          <span className="mono subtle">{e.modelId}</span>
        </span>
      ),
    },
    { key: 'provider', header: 'Provider', cell: (e) => PROVIDER_LABELS[e.providerId] },
    ...CAPABILITIES.map(
      (c): DataTableColumn<CatalogModel> => ({ key: c.key, header: c.header, cell: (e) => <YesNo value={e.capabilities[c.key]} /> }),
    ),
    { key: 'input', header: 'Input / MTok', numeric: true, cell: (e) => <Money value={e.prices.input} /> },
    { key: 'output', header: 'Output / MTok', numeric: true, cell: (e) => <Money value={e.prices.output} /> },
    { key: 'cache-read', header: 'Cache read / MTok', numeric: true, cell: (e) => <Money value={e.prices.cacheRead} /> },
    { key: 'cache-write', header: 'Cache write / MTok', numeric: true, cell: (e) => <Money value={e.prices.cacheWrite} /> },
    { key: 'version', header: 'Catalog version', cell: (e) => <span className="mono">{e.catalogVersion}</span> },
    {
      key: 'source',
      header: 'Source',
      // Shown as text with a copy button, never as a clickable external link (§11.4).
      cell: (e) => (
        <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
          <span className="mono small">{e.source}</span>
          <CopyButton value={e.source} label={`Copy source URL for ${e.displayName}`} />
        </span>
      ),
    },
    {
      key: 'effective',
      header: 'Effective',
      cell: (e) => (
        <time dateTime={e.effectiveDate} className="mono">
          {e.effectiveDate}
        </time>
      ),
    },
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
        Price catalog version <span className="mono">{catalogVersion}</span>. Prices are per million tokens.
      </p>
      <DataTable
        caption={`Model catalog, version ${catalogVersion}`}
        columns={buildColumns(profileChecks)}
        rows={entries}
        getRowKey={(e) => `${e.providerId}:${e.modelId}:${e.catalogVersion}`}
        emptyState={<p className="subtle">No models in the catalog.</p>}
      />
    </div>
  );
}
