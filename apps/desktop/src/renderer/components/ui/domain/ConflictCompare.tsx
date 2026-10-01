import { useId } from 'react';
import type { ReactNode } from 'react';
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
  /** The chosen resolution (controlled); null until the user picks one. */
  readonly value: ConflictResolution | null;
  readonly onValueChange: (resolution: ConflictResolution) => void;
  /** The single submit of the whole form (the radios plus the chosen option's slot fields). */
  readonly onSubmit: (resolution: ConflictResolution) => void;
  /**
   * Extra fields per option, shown under the choices while that option is selected and submitted with the same form
   * (e.g. the rewrite fields for `combine`, the two scopes for `keep_both_scoped`).
   */
  readonly slots?: Partial<Readonly<Record<ConflictResolution, ReactNode>>>;
  readonly pending?: boolean;
  /** Blocks the submit (e.g. the chosen option's fields are invalid); nothing chosen always blocks it. */
  readonly submitDisabled?: boolean;
  /** Accessible names of the slot groups (default: the option labels). */
  readonly slotLabels?: Partial<Readonly<Record<ConflictResolution, string>>>;
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

const DEFAULT_SLOT_LABELS: Readonly<Record<ConflictResolution, string>> = {
  keep_a: 'Keep A',
  keep_b: 'Keep B',
  combine: 'Combined record',
  keep_both_scoped: 'Separate scopes',
};

/**
 * Both records side by side with the four §5.5 choices, as one form: the chosen option's slot fields render under the
 * choices and a single "Resolve conflict" submits everything (Enter in a slot field submits too).
 */
export function ConflictCompare({
  a,
  b,
  value,
  onValueChange,
  onSubmit,
  slots = {},
  pending = false,
  submitDisabled = false,
  slotLabels = {},
}: ConflictCompareProps) {
  const slot = value === null ? undefined : slots[value];
  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (value !== null && !submitDisabled && !pending) onSubmit(value);
      }}
    >
      <div className="compare">
        <Column record={a} heading="Record A" />
        <Column record={b} heading="Record B" />
      </div>
      <RadioGroup<ConflictResolution>
        legend="How should Relay resolve this conflict?"
        value={value}
        onValueChange={onValueChange}
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
      {value === null || slot === undefined ? null : (
        <div className="stack" role="group" aria-label={slotLabels[value] ?? DEFAULT_SLOT_LABELS[value]}>
          {slot}
        </div>
      )}
      <div className="actions">
        <Button type="submit" variant="primary" pending={pending} disabled={value === null || submitDisabled}>
          Resolve conflict
        </Button>
      </div>
    </form>
  );
}
