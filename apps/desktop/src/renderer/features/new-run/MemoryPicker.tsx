import type { ReactNode } from 'react';
import { Pin } from 'lucide-react';
import type { MemoryRecordView } from '@relay/contracts';
import { Button, ErrorView, Skeleton } from '../../components/ui';
import { toViewError } from '../../api/errors';
import { MEMORY_TYPE_LABELS } from '../../lib/format';
import { useRetryAction } from '../common/useNextAction';
import { ROLE_LABELS } from '../run-setup/model-steps';
import { FIELD, MAX_MEMORY_RECORD_IDS } from './new-run-model';

export interface MemoryPickerProps {
  readonly records: readonly MemoryRecordView[] | undefined;
  readonly error: unknown;
  readonly onRetry: () => void;
  /** Ticked non-pinned ids; `null` = untouched (every approved record is included). */
  readonly checked: readonly string[] | null;
  readonly onToggle: (id: string, checked: boolean) => void;
  /** Back to the untouched selection (every approved record, nothing sent). */
  readonly onIncludeAll?: () => void;
  readonly suggestions?: number;
  /** A server problem about the memory selection (error-summary target, shown inline). */
  readonly fieldError?: string | undefined;
}

function scopeText(m: MemoryRecordView): string {
  return m.scope.roles === 'all' ? 'all roles' : m.scope.roles.map((r) => ROLE_LABELS[r]).join(', ');
}

/**
 * Approved memory to include (10 J7). By default every approved record is ticked and nothing is sent (the engine
 * includes all approved records). Pinned rules are shown checked and locked on (always included, never sent). Once
 * the user changes the selection, the ticked non-pinned records are sent as `memoryRecordIds`.
 */
export function MemoryPicker({
  records,
  error,
  onRetry,
  checked,
  onToggle,
  onIncludeAll,
  suggestions = 0,
  fieldError,
}: MemoryPickerProps) {
  const onAction = useRetryAction(onRetry);
  const errorId = `${FIELD.memory}-error`;
  const inlineError =
    fieldError === undefined ? null : (
      <span className="error" id={errorId}>
        {fieldError}
      </span>
    );
  // Without a list there is no checkbox: the section itself is the error-summary target (focusable, not tabbable).
  const wrap = (body: ReactNode) => (
    <div
      id={FIELD.memory}
      tabIndex={-1}
      className="stack"
      aria-describedby={fieldError === undefined ? undefined : errorId}
    >
      {body}
      {inlineError}
    </div>
  );
  if (error !== null && error !== undefined) {
    return wrap(<ErrorView error={toViewError(error)} onAction={onAction} />);
  }
  if (records === undefined) {
    return wrap(
      <div aria-busy="true">
        <Skeleton lines={3} />
      </div>,
    );
  }
  if (records.length === 0) return wrap(<p className="small muted">No approved memory in this project yet.</p>);
  // The anchor goes on the first control that can take focus: pinned rules are disabled (locked on).
  const firstEnabled = records.findIndex((m) => !m.pinned);
  // An explicit selection names at most MAX_MEMORY_RECORD_IDS records: at the cap, unticked records cannot be added.
  const atCap = checked !== null && checked.length >= MAX_MEMORY_RECORD_IDS;
  const capId = `${FIELD.memory}-cap`;
  return (
    <fieldset
      className="fieldset field"
      aria-describedby={fieldError === undefined ? undefined : errorId}
    >
      <legend
        className={fieldError === undefined ? 'sr-only' : undefined}
        {...(firstEnabled === -1 ? { id: FIELD.memory, tabIndex: -1 } : {})}
      >
        Approved memory records to include
      </legend>
      <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {records.map((m, i) => {
          const id = i === firstEnabled ? FIELD.memory : `${FIELD.memory}-${String(i)}`;
          const descId = `${id}-desc`;
          return (
            <li key={m.id} className="row" style={{ gap: 8, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <input
                type="checkbox"
                id={id}
                checked={m.pinned || checked === null || checked.includes(m.id)}
                disabled={m.pinned || (atCap && !checked.includes(m.id))}
                aria-describedby={[descId, ...(atCap ? [capId] : []), ...(fieldError === undefined ? [] : [errorId])].join(' ')}
                aria-invalid={fieldError === undefined || m.pinned ? undefined : true}
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
      {atCap ? (
        <p className="small muted" id={capId}>
          At most {String(MAX_MEMORY_RECORD_IDS)} records can be chosen one by one. Untick one to choose another
          {onIncludeAll === undefined ? '.' : ', or include every approved record.'}
        </p>
      ) : null}
      {checked !== null && onIncludeAll !== undefined && records.length > MAX_MEMORY_RECORD_IDS ? (
        <div>
          <Button variant="secondary" size="sm" onClick={onIncludeAll}>
            Include all approved records
          </Button>
        </div>
      ) : null}
      {suggestions > 0 ? (
        <p className="small muted">
          {String(suggestions)} suggested record{suggestions === 1 ? ' is' : 's are'} excluded until approved.
        </p>
      ) : null}
      {inlineError}
    </fieldset>
  );
}
