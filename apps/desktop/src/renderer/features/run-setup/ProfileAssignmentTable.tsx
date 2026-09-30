import type { ProfileWithWarnings, ProviderId, ProviderStatus } from '@relay/contracts';
import { Select } from '../../components/ui';
import { formatTokensExact, PROVIDER_LABELS, stepKeyLabel } from '../../lib/format';
import { ROLE_LABELS } from './model-steps';
import type { ModelStepRow } from './model-steps';

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
}: ProfileAssignmentTableProps) {
  const options = profiles.map((p) => ({
    value: p.profile.id,
    label: `${p.profile.name} · ${PROVIDER_LABELS[p.profile.providerId]} · ${p.profile.modelId}`,
  }));
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Profile</th>
            <th scope="col">Provider · model</th>
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
                    {hasNote ? (
                      <span id={noteId} className={error === undefined ? 'hint' : 'error'}>
                        {[error, problem, ...warnings.map((w) => w.message)]
                          .filter((m) => m !== undefined && m !== null)
                          .join(' ')}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td>
                  {chosen === undefined ? (
                    '—'
                  ) : (
                    <span className="mono small">
                      {PROVIDER_LABELS[chosen.profile.providerId]} · {chosen.profile.modelId}
                    </span>
                  )}
                </td>
                <td className="num">
                  {formatTokensExact(row.maxOutputTokens ?? chosen?.profile.params.maxOutputTokens ?? 0)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
