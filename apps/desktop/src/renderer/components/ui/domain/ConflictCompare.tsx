import { useId, useState } from 'react';
import type { MemoryRecordView } from '@relay/contracts';
import { MEMORY_TYPE_LABELS } from '../../../lib/format/labels';
import { Button } from '../Button';
import { RadioGroup } from '../RadioGroup';
import { StatusBadge } from '../StatusBadge';

/** The four §5.5 resolutions. Relay never merges silently: "combine" opens an explicit rewrite. */
export type ConflictResolution = 'keep_a' | 'keep_b' | 'combine' | 'keep_both_scoped';

export interface ConflictRecord extends MemoryRecordView {
  /** Full content when loaded (MemoryRecordDetail); the excerpt is shown otherwise. */
  readonly content?: string;
}

export interface ConflictCompareProps {
  readonly a: ConflictRecord;
  readonly b: ConflictRecord;
  readonly onResolve: (resolution: ConflictResolution) => void;
  readonly pending?: boolean;
}

function Column({ record, heading }: { readonly record: ConflictRecord; readonly heading: string }) {
  const id = useId();
  return (
    <section className="compare-col" aria-labelledby={id}>
      <span className="section-label">{heading}</span>
      <h3 id={id}>{record.title}</h3>
      <span className="row">
        <StatusBadge kind="memory" value={record.status} />
        <span className="subtle">
          {MEMORY_TYPE_LABELS[record.type]} · revision {record.currentRevision}
        </span>
      </span>
      <p className="prewrap">{record.content ?? record.excerpt}</p>
    </section>
  );
}

export function ConflictCompare({ a, b, onResolve, pending = false }: ConflictCompareProps) {
  const [choice, setChoice] = useState<ConflictResolution | null>(null);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (choice !== null) onResolve(choice);
      }}
    >
      <div className="compare">
        <Column record={a} heading="Record A" />
        <Column record={b} heading="Record B" />
      </div>
      <RadioGroup<ConflictResolution>
        legend="How should Relay resolve this conflict?"
        value={choice}
        onValueChange={setChoice}
        options={[
          { value: 'keep_a', label: `Keep A: "${a.title}"`, description: 'The other record is archived or rejected.' },
          { value: 'keep_b', label: `Keep B: "${b.title}"`, description: 'The other record is archived or rejected.' },
          { value: 'combine', label: 'Combine into a new record', description: 'You write the combined text; both originals are archived.' },
          {
            value: 'keep_both_scoped',
            label: 'Keep both with separate scopes',
            description: 'Each record applies to different roles, so they never meet in one request.',
          },
        ]}
      />
      <div className="actions">
        <Button type="submit" variant="primary" pending={pending} disabled={choice === null}>
          Resolve conflict
        </Button>
      </div>
    </form>
  );
}
