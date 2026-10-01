import { Pin, TriangleAlert } from 'lucide-react';
import type { MemoryRecordView } from '@relay/contracts';
import { MEMORY_TYPE_LABELS } from '../../../lib/format/labels';
import { ListItemButton } from '../ListItemButton';
import { StatusBadge } from '../StatusBadge';

export interface MemoryRecordCardProps {
  readonly record: MemoryRecordView;
  readonly selected: boolean;
  readonly onSelect?: (id: MemoryRecordView['id']) => void;
}

function sourceText(source: MemoryRecordView['source']): string {
  switch (source.kind) {
    case 'user':
      return 'Added by you';
    case 'run':
      return `From run ${source.runId}`;
    case 'file':
      return `From file ${source.relPath}`;
  }
}

/** Memory list row: title, excerpt, type/source line, stale indicator (§5.5). */
export function MemoryRecordCard({ record, selected, onSelect }: MemoryRecordCardProps) {
  const status = <StatusBadge kind="memory" value={record.status} />;
  const badges = (
    <>
      <span>
        {MEMORY_TYPE_LABELS[record.type]} · {sourceText(record.source)} · revision {record.currentRevision}
      </span>
      {record.pinned ? (
        <span className="tag">
          <Pin aria-hidden="true" width={12} height={12} /> Pinned
        </span>
      ) : null}
      {record.stale ? (
        <span className="badge warning">
          <TriangleAlert aria-hidden="true" /> Stale source
        </span>
      ) : null}
    </>
  );
  if (!onSelect) {
    return (
      <div className="list-item static" aria-current={selected ? 'true' : undefined}>
        <span className="row" style={{ justifyContent: 'space-between' }}>
          <span className="title">{record.title}</span>
          {status}
        </span>
        <span className="meta">{record.excerpt}</span>
        <span className="meta row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {badges}
        </span>
      </div>
    );
  }
  return (
    <ListItemButton
      title={record.title}
      aside={status}
      meta={record.excerpt}
      badges={badges}
      aria-current={selected ? 'true' : undefined}
      onClick={() => { onSelect(record.id); }}
    />
  );
}
