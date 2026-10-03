import type { ProfileWithWarnings, ProviderId, ProviderStatus } from '@relay/contracts';
import { Button, NumberInput, Select, TableScroll } from '../../components/ui';
import { formatTokensExact, PROVIDER_LABELS, stepKeyLabel } from '../../lib/format';
import { ROLE_LABELS } from './model-steps';
import type { ModelStepRow } from './model-steps';
import { isOutputOverridden, outputRangeText } from './output-limits';
import type { StepOutputLimit } from './output-limits';

/**
 * Decision 3: makes the "Max output (tokens)" column editable (New run). Without it the column is read-only text
 * (onboarding).
 */
export interface OutputLimitEditor {
  /** stepKey → default and allowed range. A step without one stays read-only. */
  readonly limits: Readonly<Record<string, StepOutputLimit>>;
  /** stepKey → the text typed (missing = the default). */
  readonly values: Readonly<Record<string, string>>;
  /** stepKey → validation message (client or `outputTokenOverrides.<step>` server issue). */
  readonly errors?: Readonly<Record<string, string>>;
  /** stepKey → a note about a change made for the user (e.g. lowered to a new model's maximum). */
  readonly notes?: Readonly<Record<string, string>>;
  /** Id of a step's input (error-summary anchors). */
  readonly inputId: (stepKey: string) => string;
  readonly onChange: (stepKey: string, text: string) => void;
  readonly onReset: (stepKey: string) => void;
  readonly onResetAll: () => void;
}

export interface ProfileAssignmentTableProps {
  readonly caption: string;
  readonly rows: readonly ModelStepRow[];
  readonly profiles: readonly ProfileWithWarnings[];
  /** stepKey → selected profile id (missing = the default). */
  readonly selected: Readonly<Record<string, string>>;
  readonly onSelect: (stepKey: string, profileId: string) => void;
  /** Connection state, to flag profiles whose provider has no working key. */
  readonly providers?: readonly ProviderStatus[] | undefined;
  /** Per-step problems (e.g. preflight issues on `profileOverrides.<step>`), shown under the select. */
  readonly errors?: Readonly<Record<string, string>>;
  /** Id of a step's select (error-summary anchors). */
  readonly selectId: (stepKey: string) => string;
  readonly disabled?: boolean;
  /** Editable per-step output limits (New run); absent = read-only column. */
  readonly output?: OutputLimitEditor | undefined;
}

function providerProblem(
  providers: readonly ProviderStatus[] | undefined,
  providerId: ProviderId,
): string | null {
  if (providers === undefined) return null;
  const p = providers.find((x) => x.providerId === providerId);
  if (p?.connected !== true) return `${PROVIDER_LABELS[providerId]} is not connected.`;
  if (p.lastTest?.ok === false)
    return `${p.displayName} credential failed. Reconnect it or pick another profile.`;
  return null;
}

/**
 * Role → model profile snapshot table (mock onboarding step 7, new-run "Workflow"). Each row is a labelled native
 * select; the engine re-validates capabilities at preflight, so this table only surfaces engine-computed warnings.
 */
export function ProfileAssignmentTable({
  caption,
  rows,
  profiles,
  selected,
  onSelect,
  providers,
  errors = {},
  selectId,
  disabled = false,
  output,
}: ProfileAssignmentTableProps) {
  // Profile + provider only (as in the mock): the model is in the next column, and the full label stays short
  // enough to read in the closed select.
  const options = profiles.map((p) => ({
    value: p.profile.id,
    label: `${p.profile.name} · ${PROVIDER_LABELS[p.profile.providerId]}`,
  }));
  // Editable limits need the room: the model moves under the profile select (whose label already names the provider).
  const compact = output !== undefined;
  const anyOverride =
    output !== undefined &&
    rows.some((r) => isOutputOverridden(output.values[r.stepKey], output.limits[r.stepKey]));
  return (
    <>
      <TableScroll label={caption}>
        <table className="table profile-assignment">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Profile</th>
              {compact ? null : <th scope="col">Provider · model</th>}
              <th scope="col" className="num">
                Max output (tokens)
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const value = selected[row.stepKey] ?? row.defaultProfileId ?? '';
              const chosen = profiles.find((p) => p.profile.id === value);
              const id = selectId(row.stepKey);
              const error = errors[row.stepKey];
              const problem =
                chosen === undefined ? null : providerProblem(providers, chosen.profile.providerId);
              const warnings = chosen?.warnings ?? [];
              const noteId = `${id}-note`;
              const hasNote = error !== undefined || problem !== null || warnings.length > 0;
              const label = `${ROLE_LABELS[row.role]} profile (${stepKeyLabel(row.stepKey)} step)`;
              const outputLimit = output?.limits[row.stepKey];
              return (
                <tr key={row.stepKey}>
                  <th scope="row">
                    <span className="stack" style={{ gap: 0 }}>
                      <span>{stepKeyLabel(row.stepKey)}</span>
                      <span className="subtle small">{ROLE_LABELS[row.role]}</span>
                    </span>
                  </th>
                  <td>
                    <div className="stack" style={{ gap: 4 }}>
                      <label htmlFor={id} className="sr-only">
                        {label}
                      </label>
                      <Select
                        id={id}
                        value={value}
                        disabled={disabled}
                        aria-invalid={error === undefined ? undefined : true}
                        aria-describedby={hasNote ? noteId : undefined}
                        options={
                          value === ''
                            ? [{ value: '', label: 'No matching profile', disabled: true }, ...options]
                            : options
                        }
                        onValueChange={(v) => {
                          onSelect(row.stepKey, v);
                        }}
                      />
                      {compact && chosen !== undefined ? (
                        <span className="mono small subtle">{chosen.profile.modelId}</span>
                      ) : null}
                      {hasNote ? (
                        <span id={noteId} className={error === undefined ? 'hint' : 'error'}>
                          {[error, problem, ...warnings.map((w) => w.message)]
                            .filter((m) => m !== undefined && m !== null)
                            .join(' ')}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  {compact ? null : (
                    <td>
                      {chosen === undefined ? (
                        '—'
                      ) : (
                        <span className="stack" style={{ gap: 0 }}>
                          <span className="small">{PROVIDER_LABELS[chosen.profile.providerId]}</span>
                          <span className="mono small nowrap">{chosen.profile.modelId}</span>
                        </span>
                      )}
                    </td>
                  )}
                  {output === undefined || outputLimit === undefined ? (
                    <td className="num nowrap">
                      {formatTokensExact(row.maxOutputTokens ?? chosen?.profile.params.maxOutputTokens ?? 0)}
                    </td>
                  ) : (
                    <td className="num">
                      <OutputLimitCell
                        stepKey={row.stepKey}
                        limit={outputLimit}
                        editor={output}
                        disabled={disabled}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
      {output !== undefined && anyOverride ? (
        <div>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={output.onResetAll}>
            Reset all to defaults
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** One step's "Max output (tokens)" input: range hint, inline error, note, and "Reset to default" once changed. */
function OutputLimitCell({
  stepKey,
  limit,
  editor,
  disabled,
}: {
  readonly stepKey: string;
  readonly limit: StepOutputLimit;
  readonly editor: OutputLimitEditor;
  readonly disabled: boolean;
}) {
  const id = editor.inputId(stepKey);
  const text = editor.values[stepKey];
  const error = editor.errors?.[stepKey];
  const note = editor.notes?.[stepKey];
  const stepLabel = stepKeyLabel(stepKey);
  const hintId = `${id}-hint`;
  const noteId = `${id}-note`;
  const errorId = `${id}-error`;
  const describedBy = [hintId, note === undefined ? null : noteId, error === undefined ? null : errorId]
    .filter((x) => x !== null)
    .join(' ');
  return (
    <div className="stack items-end" style={{ gap: 4 }}>
      <label htmlFor={id} className="sr-only">
        Max output tokens for {stepLabel}
      </label>
      <NumberInput
        id={id}
        className="w-24 text-right"
        min={limit.min}
        max={limit.max}
        value={text ?? String(limit.defaultTokens)}
        disabled={disabled}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy}
        onValueChange={(t) => {
          editor.onChange(stepKey, t);
        }}
      />
      <span id={hintId} className="hint">
        {outputRangeText(limit)}
      </span>
      {note === undefined ? null : (
        <span id={noteId} className="hint">
          {note}
        </span>
      )}
      {error === undefined ? null : (
        <span id={errorId} className="error">
          {error}
        </span>
      )}
      {isOutputOverridden(text, limit) ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          aria-label={`Reset to default: max output tokens for ${stepLabel}`}
          onClick={() => {
            editor.onReset(stepKey);
          }}
        >
          Reset to default
        </Button>
      ) : null}
    </div>
  );
}
