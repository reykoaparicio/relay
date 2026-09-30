import { Pin, TriangleAlert } from 'lucide-react';
import type { MemoryRecordView } from '@relay/contracts';
import { MEMORY_TYPE_LABELS } from '../../../lib/format/labels';
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
  const body = (
    <>
      <span className="row" style={{ justifyContent: 'space-between' }}>
        <span className="title">{record.title}</span>
        <StatusBadge kind="memory" value={record.status} />
      </span>
      <span className="muted small">{record.excerpt}</span>
      <span className="meta row" style={{ gap: 8 }}>
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
      </span>
    </>
  );
  if (!onSelect) {
    return (
      <div className="list-item" aria-current={selected ? 'true' : undefined}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="list-item"
      aria-current={selected ? 'true' : undefined}
      onClick={() => { onSelect(record.id); }}
    >
      {body}
    </button>
  );
}
