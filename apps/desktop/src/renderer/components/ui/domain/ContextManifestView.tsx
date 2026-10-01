import { memo } from 'react';
import type { ContextManifest } from '@relay/contracts';
import { MEMORY_TYPE_LABELS, PROVIDER_LABELS, stepKeyLabel } from '../../../lib/format/labels';
import { formatTokens } from '../../../lib/format/tokens';
import { DataTable } from '../DataTable';
import { Hash } from '../Hash';
import { KeyValueList } from '../KeyValueList';

export interface ContextManifestViewProps {
  readonly manifest: ContextManifest;
}

type ManifestFile = ContextManifest['files'][number];
type ManifestMemory = ContextManifest['memory'][number];

const FILE_REASON: Readonly<Record<ManifestFile['reason'], string>> = {
  selected: 'Selected by you',
  plan_scope: 'In the approved plan scope',
  referenced_by_findings: 'Referenced by findings',
};

const OMIT_REASON: Readonly<Record<ContextManifest['omitted'][number]['reason'], string>> = {
  token_budget: 'Over the token budget',
  excluded_by_policy: 'Excluded by policy',
  stale_source: 'Source changed since it was recorded',
};

/** §5.4 "Context used": exactly what a request carried, and where it went (§6.2 honesty). */
function ContextManifestViewView({ manifest: m }: ContextManifestViewProps) {
  return (
    <div className="stack">
      <KeyValueList
        items={[
          { term: 'Profile', value: `${m.profile.name} · ${PROVIDER_LABELS[m.profile.providerId]}` },
          { term: 'Model', value: m.profile.modelId, mono: true },
          { term: 'Price catalog', value: m.priceCatalogVersion, mono: true },
          { term: 'Instructions', value: <>{m.instructions.version} <Hash value={m.instructions.sha256} label="instructions hash" /></> },
          {
            term: 'Input tokens',
            value: `${formatTokens(m.tokens.estimatedInput)} of ${formatTokens(m.tokens.budget)} (${m.tokens.basis === 'provider_count' ? 'provider count' : 'local estimate'})`,
          },
          { term: 'Context hash', value: <Hash value={m.contextHash} label="context hash" /> },
          {
            term: 'Providers receiving this context',
            value: m.providersReceivingContext.map((p) => PROVIDER_LABELS[p]).join(', ') || 'none',
          },
        ]}
      />
      <DataTable<ManifestFile>
        caption="Files in this context"
        showCaption
        columns={[
          { key: 'path', header: 'File', cell: (f) => <span className="mono">{f.relPath}</span> },
          { key: 'status', header: 'Status', cell: (f) => (f.included ? 'Included' : 'Omitted') },
          { key: 'reason', header: 'Why', cell: (f) => FILE_REASON[f.reason] },
          { key: 'tokens', header: 'Tokens', numeric: true, cell: (f) => <span className="num">{formatTokens(f.tokens)}</span> },
          { key: 'hash', header: 'Hash', cell: (f) => <Hash value={f.sha256} label={`hash of ${f.relPath}`} /> },
        ]}
        rows={m.files}
        getRowKey={(f) => f.relPath}
        emptyState={<p className="subtle">No project files in this context.</p>}
      />
      <DataTable<ManifestMemory>
        caption="Memory in this context"
        showCaption
        columns={[
          { key: 'record', header: 'Record', cell: (r) => <span className="mono">{r.recordId}</span> },
          { key: 'type', header: 'Type', cell: (r) => MEMORY_TYPE_LABELS[r.type] },
          { key: 'rev', header: 'Revision', numeric: true, cell: (r) => <span className="num">{r.revision}</span> },
          {
            key: 'status',
            header: 'Status',
            cell: (r) => [r.included ? 'Included' : 'Omitted', r.pinned ? 'pinned' : null, r.stale ? 'stale source' : null].filter(Boolean).join(', '),
          },
        ]}
        rows={m.memory}
        getRowKey={(r) => `${r.recordId}:${String(r.revision)}`}
        emptyState={<p className="subtle">No memory records in this context.</p>}
      />
      {m.upstream.length > 0 ? (
        <DataTable
          caption="Upstream artifacts"
          showCaption
          columns={[
            { key: 'step', header: 'From step', cell: (u: ContextManifest['upstream'][number]) => stepKeyLabel(u.stepKey) },
            { key: 'schema', header: 'Output', cell: (u) => <span className="mono">{u.schemaId}</span> },
            { key: 'hash', header: 'Hash', cell: (u) => <Hash value={u.sha256} label={`hash of ${u.schemaId} output`} /> },
          ]}
          rows={m.upstream}
          getRowKey={(u) => u.artifactId}
        />
      ) : null}
      {m.omitted.length > 0 ? (
        <div className="stack">
          <h3 className="section-label">Left out</h3>
          <ul className="small">
            {m.omitted.map((o) => (
              <li key={`${o.kind}:${o.ref}`}>
                <span className="mono">{o.ref}</span> ({o.kind}): {OMIT_REASON[o.reason]}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Memoized (PERF-02): re-renders only when its props change, not on every parent tick. */
export const ContextManifestView = memo(ContextManifestViewView);
