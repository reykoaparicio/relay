import { File } from 'lucide-react';
import { INPUT_CAPS } from '@relay/contracts';
import type { PreviewResult } from '@relay/contracts';
import { Button, ErrorView, Skeleton } from '../../components/ui';
import { toViewError } from '../../api/errors';
import { useRetryAction } from '../common/useNextAction';
import { EXCLUSION_REASON_LABELS, formatBytes } from '../../lib/format';
import { FIELD } from './new-run-model';

export interface FilePickerProps {
  readonly preview: PreviewResult | undefined;
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly fieldError?: string | undefined;
}

/**
 * Multi-select of the included files from `projects.previewFiles` (10 J7). Excluded files are listed with their
 * reason as text but cannot be selected. The first checkbox carries the field id (error-summary anchor).
 */
export function FilePicker({ preview, error, onRetry, selected, onChange, fieldError }: FilePickerProps) {
  const onAction = useRetryAction(onRetry);
  if (error !== null && error !== undefined)
    return <ErrorView error={toViewError(error)} onAction={onAction} />;
  if (preview === undefined) {
    return (
      <div aria-busy="true" id={FIELD.files} tabIndex={-1}>
        <Skeleton lines={5} />
      </div>
    );
  }
  const chosen = new Set(selected);
  const bytes = preview.included.filter((f) => chosen.has(f.relPath)).reduce((n, f) => n + f.sizeBytes, 0);
  const errorId = `${FIELD.files}-error`;
  const all = preview.included.slice(0, INPUT_CAPS.maxFiles).map((f) => f.relPath);
  return (
    <fieldset
      className="fieldset field"
      aria-describedby={
        fieldError === undefined ? `${FIELD.files}-totals` : `${FIELD.files}-totals ${errorId}`
      }
    >
      <legend>Files to include</legend>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span id={`${FIELD.files}-totals`} className="small num">
          {String(selected.length)} of {String(preview.included.length)} selected · {formatBytes(bytes)} of{' '}
          {formatBytes(preview.totals.capBytes)} input cap
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onChange(all);
          }}
        >
          Select all
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onChange([]);
          }}
        >
          Clear
        </Button>
      </div>
      <ul className="tree" style={{ maxHeight: 280, overflow: 'auto' }}>
        {preview.included.map((f, i) => {
          const id = i === 0 ? FIELD.files : `${FIELD.files}-${String(i)}`;
          return (
            <li key={f.relPath}>
              <input
                type="checkbox"
                id={id}
                checked={chosen.has(f.relPath)}
                aria-invalid={fieldError === undefined ? undefined : true}
                onChange={(e) => {
                  onChange(
                    e.target.checked ? [...selected, f.relPath] : selected.filter((p) => p !== f.relPath),
                  );
                }}
              />
              <File aria-hidden="true" />
              <label htmlFor={id} className="path">
                {f.relPath}
              </label>
              <span className="why">{formatBytes(f.sizeBytes)}</span>
            </li>
          );
        })}
      </ul>
      {preview.excluded.length === 0 ? null : (
        <p className="small muted">
          Excluded by project policy (never sent):{' '}
          {preview.excluded.map((x) => `${x.relPath} (${EXCLUSION_REASON_LABELS[x.reason]})`).join(', ')}.
        </p>
      )}
      {fieldError === undefined ? null : (
        <span className="error" id={errorId}>
          {fieldError}
        </span>
      )}
    </fieldset>
  );
}
