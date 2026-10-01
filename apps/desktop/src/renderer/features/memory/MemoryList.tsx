import type { MemoryRecordView } from '@relay/contracts';
import { MemoryRecordCard } from '../../components/ui';

export interface MemoryListProps {
  /** E.g. "Approved records" (the section and list name). */
  readonly label: string;
  readonly records: readonly MemoryRecordView[];
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
}

/** The record list of the Approved / Archived tab: one selectable MemoryRecordCard per record. */
export function MemoryList({ label, records, selectedId, onSelect }: MemoryListProps) {
  return (
    <section className="card stack" aria-label={label}>
      <ul className="list" aria-label={label}>
        {records.map((r) => (
          <li key={r.id}>
            <MemoryRecordCard record={r} selected={r.id === selectedId} onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </section>
  );
}
