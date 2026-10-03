import { useState } from 'react';
import { File, FileX, TriangleAlert } from 'lucide-react';
import { INPUT_CAPS } from '@relay/contracts';
import type { PreviewResult } from '@relay/contracts';
import { Button, ConfirmDialog, ErrorView, Skeleton } from '../../components/ui';
import { toViewError } from '../../api/errors';
import { useRetryAction } from '../common/useNextAction';
import { formatBytes } from '../../lib/format';
import { exclusionReasonText, secretLabelText, suspectedSecretText, UNREADABLE_FILE_TEXT } from '../../lib/format/labels';
import { acknowledgedFor, FIELD, fileCheckboxId, isSuspectedSecret } from './new-run-model';

type Included = PreviewResult['included'][number];

export interface FilePickerProps {
  readonly preview: PreviewResult | undefined;
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly selected: readonly string[];
  /** Selected suspected secrets the user confirmed sending (E2 #11); a subset of `selected`. */
  readonly acknowledged?: readonly string[];
  /** The new selection and the confirmed suspected secrets (always a subset of it). */
  readonly onChange: (next: readonly string[], acknowledged: readonly string[]) => void;
  /** Display names of the providers that receive the run's context (the suspected-secret confirm names them). */
  readonly providerNames?: readonly string[];
  readonly fieldError?: string | undefined;
  /** checkbox id → message, for problems about one file (a suspected secret, an unreadable file). */
  readonly rowErrors?: Readonly<Record<string, string>>;
}

/** "Anthropic and OpenAI", "Anthropic, OpenAI and Google Gemini". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? 'the providers of this workflow';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/**
 * Multi-select of the included files from `projects.previewFiles` (10 J7). Excluded and unreadable files are listed
 * with their reason as text but cannot be selected. A file flagged as a suspected secret (E2 #11) is never ticked by
 * default nor by "Select all"; ticking it asks for an explicit confirm naming the providers that would receive it. Each
 * checkbox has a stable id ({@link fileCheckboxId}): the first one is the field id (error-summary anchor), and per-file
 * problems link to their own row.
 */
export function FilePicker({
  preview,
  error,
  onRetry,
  selected,
  acknowledged = [],
  onChange,
  providerNames = [],
  fieldError,
  rowErrors = {},
}: FilePickerProps) {
  const onAction = useRetryAction(onRetry);
  /** The suspected secret waiting for the "Send this file?" confirm. */
  const [confirming, setConfirming] = useState<Included | null>(null);
  if (error !== null && error !== undefined)
    return <ErrorView error={toViewError(error)} onAction={onAction} onRetry={onRetry} />;
  if (preview === undefined) {
    return (
      <div aria-busy="true" id={FIELD.files} tabIndex={-1}>
        <Skeleton lines={5} />
      </div>
    );
  }
  const chosen = new Set(selected);
  const acked = new Set(acknowledgedFor(selected, acknowledged));
  const bytes = preview.included.filter((f) => chosen.has(f.relPath)).reduce((n, f) => n + f.sizeBytes, 0);
  const errorId = `${FIELD.files}-error`;
  // "Select all" never ticks a suspected secret on its own: only the confirmed ones stay selected.
  const all = preview.included
    .filter((f) => !isSuspectedSecret(f) || chosen.has(f.relPath))
    .slice(0, INPUT_CAPS.maxFiles)
    .map((f) => f.relPath);
  const suspectedLeftOut = preview.included.filter((f) => isSuspectedSecret(f) && !chosen.has(f.relPath)).length;
  const unreadable = preview.unreadable ?? [];
  const providers = joinNames(providerNames);
  const emit = (next: readonly string[], ack: readonly string[] = [...acked]) => {
    onChange(next, acknowledgedFor(next, ack));
  };
  const confirm = () => {
    if (confirming === null) return;
    const path = confirming.relPath;
    emit(chosen.has(path) ? selected : [...selected, path], [...acked, path]);
    setConfirming(null);
  };
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
            emit(all);
          }}
        >
          Select all
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            emit([], []);
          }}
        >
          Clear
        </Button>
      </div>
      {suspectedLeftOut === 0 ? null : (
        <p className="small muted">
          {suspectedLeftOut === 1 ? '1 file looks' : `${String(suspectedLeftOut)} files look`} like{' '}
          {suspectedLeftOut === 1 ? 'it contains' : 'they contain'} a secret and{' '}
          {suspectedLeftOut === 1 ? 'is' : 'are'} not selected. Tick one to send it anyway; Relay asks you to confirm.
        </p>
      )}
      <ul className="tree" style={{ maxHeight: 280, overflow: 'auto' }}>
        {preview.included.map((f, i) => {
          const id = fileCheckboxId(i);
          const suspected = isSuspectedSecret(f);
          const flagId = `${id}-secret`;
          const rowErrorId = `${id}-error`;
          // The first row's problem is the field error, shown under the list.
          const rowError = i === 0 ? undefined : rowErrors[id];
          const unconfirmed = suspected && chosen.has(f.relPath) && !acked.has(f.relPath);
          const describedBy = [suspected ? flagId : null, rowError === undefined ? null : rowErrorId].filter((x) => x !== null);
          return (
            <li key={f.relPath} style={suspected || rowError !== undefined ? { flexWrap: 'wrap' } : undefined}>
              <input
                type="checkbox"
                id={id}
                checked={chosen.has(f.relPath)}
                aria-invalid={fieldError === undefined && rowError === undefined ? undefined : true}
                aria-describedby={describedBy.length === 0 ? undefined : describedBy.join(' ')}
                onChange={(e) => {
                  if (e.target.checked && suspected && !acked.has(f.relPath)) {
                    setConfirming(f);
                    return;
                  }
                  emit(e.target.checked ? [...selected, f.relPath] : selected.filter((p) => p !== f.relPath));
                }}
              />
              {suspected ? <TriangleAlert aria-hidden="true" /> : <File aria-hidden="true" />}
              <label htmlFor={id} className="path">
                {f.relPath}
              </label>
              <span className="why">{formatBytes(f.sizeBytes)}</span>
              {suspected ? (
                <span id={flagId} className="small" style={{ flexBasis: '100%', paddingLeft: 24, fontFamily: 'var(--font-sans)' }}>
                  {suspectedSecretText(f.secretLabel, f.secretLine)}.{' '}
                  {acked.has(f.relPath) ? (
                    <span>You confirmed sending it.</span>
                  ) : unconfirmed ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setConfirming(f);
                      }}
                    >
                      Confirm sending…
                    </Button>
                  ) : (
                    <span className="muted">Not selected.</span>
                  )}
                </span>
              ) : null}
              {rowError === undefined ? null : (
                <span id={rowErrorId} className="error" style={{ flexBasis: '100%', paddingLeft: 24 }}>
                  {rowError}
                </span>
              )}
            </li>
          );
        })}
        {unreadable.map((relPath) => (
          <li key={`unreadable:${relPath}`} className="excluded">
            <FileX aria-hidden="true" />
            <span className="path">{relPath}</span>
            <span className="why">{UNREADABLE_FILE_TEXT}</span>
          </li>
        ))}
      </ul>
      {preview.excluded.length === 0 ? null : (
        <p className="small muted">
          Excluded by project policy (never sent):{' '}
          {preview.excluded.map((x) => `${x.relPath} (${exclusionReasonText(x.reason)})`).join(', ')}.
        </p>
      )}
      {fieldError === undefined ? null : (
        <span className="error" id={errorId}>
          {fieldError}
        </span>
      )}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={`Send this file to ${providers}?`}
        consequences={
          confirming === null
            ? ''
            : `${confirming.relPath} looks like it contains a secret (${secretLabelText(confirming.secretLabel)}${
                confirming.secretLine === undefined ? '' : `, line ${String(confirming.secretLine)}`
              }). If you include it, its whole content is sent to ${providers} with this run. Remove the secret from the file first if it should not leave this computer.`
        }
        confirmLabel="Send this file"
        cancelLabel="Do not send it"
        destructive
        onConfirm={confirm}
      />
    </fieldset>
  );
}
