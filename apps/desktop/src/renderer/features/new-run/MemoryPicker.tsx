import { Pin } from 'lucide-react';
import type { MemoryRecordView } from '@relay/contracts';
import { ErrorView, Skeleton } from '../../components/ui';
import { isNotImplemented, toViewError } from '../../api/errors';
import { MEMORY_TYPE_LABELS } from '../../lib/format';
import { NotAvailableNotice } from '../common/NotAvailableNotice';
import { ROLE_LABELS } from '../run-setup/model-steps';
import { FIELD } from './new-run-model';

export interface MemoryPickerProps {
  readonly records: readonly MemoryRecordView[] | undefined;
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly checked: readonly string[];
  readonly onToggle: (id: string, checked: boolean) => void;
  readonly suggestions?: number;
}

function scopeText(m: MemoryRecordView): string {
  return m.scope.roles === 'all' ? 'all roles' : m.scope.roles.map((r) => ROLE_LABELS[r]).join(', ');
}

/**
 * Approved memory to include (10 J7). Pinned rules are shown checked and locked on (the engine always includes them,
 * so they are never sent); ticked non-pinned records become `memoryRecordIds`.
 */
export function MemoryPicker({
  records,
  error,
  onRetry,
  checked,
  onToggle,
  suggestions = 0,
}: MemoryPickerProps) {
  if (error !== null && error !== undefined) {
    return isNotImplemented(error) ? (
      <NotAvailableNotice error={error}>
        Pinned project rules are still included by Relay when the run starts.
      </NotAvailableNotice>
    ) : (
      <ErrorView error={toViewError(error)} onAction={onRetry} />
    );
  }
  if (records === undefined) {
    return (
      <div aria-busy="true">
        <Skeleton lines={3} />
      </div>
    );
  }
  if (records.length === 0) return <p className="small muted">No approved memory in this project yet.</p>;
  return (
    <fieldset className="fieldset field">
      <legend className="sr-only">Approved memory records to include</legend>
      <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {records.map((m, i) => {
          const id = i === 0 ? FIELD.memory : `${FIELD.memory}-${String(i)}`;
          const descId = `${id}-desc`;
          return (
            <li key={m.id} className="row" style={{ gap: 8, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <input
                type="checkbox"
                id={id}
                checked={m.pinned || checked.includes(m.id)}
                disabled={m.pinned}
                aria-describedby={descId}
                onChange={(e) => {
                  onToggle(m.id, e.target.checked);
                }}
              />
              <span className="stack" style={{ gap: 0 }}>
                <label htmlFor={id}>{m.title}</label>
                <span id={descId} className="small subtle">
                  {MEMORY_TYPE_LABELS[m.type]} · {scopeText(m)} · rev {String(m.currentRevision)}
                  {m.pinned ? (
                    <>
                      {' · '}
                      <Pin aria-hidden="true" width={12} height={12} /> Pinned: always included
                    </>
                  ) : null}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {suggestions > 0 ? (
        <p className="small muted">
          {String(suggestions)} suggested record{suggestions === 1 ? ' is' : 's are'} excluded until approved.
        </p>
      ) : null}
    </fieldset>
  );
}
