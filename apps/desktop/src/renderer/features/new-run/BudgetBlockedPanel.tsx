import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { BudgetBreakdown, Microusd, ProfileWithWarnings, Project } from '@relay/contracts';
import { BudgetBreakdownTable, Button, ButtonLink, Field, MoneyInput, parseDollarInput, Select } from '../../components/ui';
import { call } from '../../api/client';
import { MutationError } from '../common/MutationError';
import { formatMoney, PROVIDER_LABELS, stepKeyLabel } from '../../lib/format';
import { paths } from '../shell/paths';
import { dollarsText } from '../run-setup/limits';
import type { ModelStepRow } from '../run-setup/model-steps';

export interface BudgetBlockedPanelProps {
  readonly budget: BudgetBreakdown;
  readonly project: Project;
  /** Model steps of the workflow: the first one is the request the check reserves for (N). */
  readonly rows: readonly ModelStepRow[];
  readonly profiles: readonly ProfileWithWarnings[];
  readonly selection: Readonly<Record<string, string>>;
  /** Applies a new run allowance to the form (the preflight re-checks). */
  readonly onSetAllowance: (text: string) => void;
  /** Switches a step's profile in the form (the preflight re-checks). */
  readonly onSelectProfile: (stepKey: string, profileId: string) => void;
  /** The project's monthly allowance was saved: re-check. */
  readonly onProjectAllowanceSaved: () => void;
}

/** Inline monthly allowance edit (`projects.update`), then the page re-checks. */
function MonthlyAllowanceEdit({ project, suggested, onSaved }: { readonly project: Project; readonly suggested: string; readonly onSaved: () => void }) {
  const [edit, setEdit] = useState<{ readonly over: string; readonly text: string } | null>(null);
  const text = edit !== null && edit.over === suggested ? edit.text : suggested;
  const parsed = parseDollarInput(text);
  const save = useMutation({
    mutationFn: (value: Microusd) =>
      call('relay/v1/projects.update', {
        projectId: project.id,
        expectedUpdatedAt: project.updatedAt,
        patch: { monthlyAllowanceMicrousd: value },
      }),
    onSuccess: onSaved,
  });
  return (
    <>
      <MoneyInput
        label="New monthly allowance (USD)"
        value={text}
        onValueChange={(t) => {
          setEdit({ over: suggested, text: t });
        }}
      />
      <p className="small muted">A project setting, recorded as a policy change. Runs of this project paused for it are re-checked.</p>
      <div>
        <Button
          pending={save.isPending}
          disabled={!parsed.ok}
          onClick={() => {
            if (parsed.ok) save.mutate(parsed.value);
          }}
        >
          Save and re-check
        </Button>
      </div>
      <MutationError error={save.error} projectId={project.id} />
      <p className="small">
        Or <Link to={paths.settings('projects', { project: project.id })}>edit it in Settings</Link>; this form is kept.
      </p>
    </>
  );
}

/** Inline profile switch for the first model step (its reservation is the N of the check). */
function ProfileSwitch({
  rows,
  profiles,
  selection,
  onSelect,
}: {
  readonly rows: readonly ModelStepRow[];
  readonly profiles: readonly ProfileWithWarnings[];
  readonly selection: Readonly<Record<string, string>>;
  readonly onSelect: (stepKey: string, profileId: string) => void;
}) {
  const id = useId();
  const row = rows[0];
  if (row === undefined) return null;
  const value = selection[row.stepKey] ?? row.defaultProfileId ?? '';
  return (
    <Field label={`Profile for ${stepKeyLabel(row.stepKey)}`} id={id} hint="Changes this run only. The check runs again.">
      {(control) => (
        <Select
          {...control}
          value={value}
          options={profiles.map((p) => ({ value: p.profile.id, label: `${p.profile.name} · ${PROVIDER_LABELS[p.profile.providerId]}` }))}
          onValueChange={(v) => {
            onSelect(row.stepKey, v);
          }}
        />
      )}
    </Field>
  );
}

/** The smallest allowance that admits this reservation: L + (total − L), rounded up to the cent. */
function neededAllowance(b: BudgetBreakdown): Microusd {
  const cents = 10_000;
  return (Math.ceil(b.total / cents) * cents) as Microusd;
}

/**
 * `budget-blocked` (mock new-run): the §9.3 arithmetic and the three ways forward: increase the allowance inline,
 * choose a cheaper profile, or do not start. Nothing was reserved or sent.
 */
export function BudgetBlockedPanel({
  budget,
  project,
  rows,
  profiles,
  selection,
  onSetAllowance,
  onSelectProfile,
  onProjectAllowanceSaved,
}: BudgetBlockedPanelProps) {
  const projectId = project.id;
  const titleId = useId();
  // The suggestion follows the current breakdown: an edit applies only to the suggestion it was typed over.
  const suggested = dollarsText(neededAllowance(budget));
  const [edit, setEdit] = useState<{ readonly over: string; readonly text: string } | null>(null);
  const text = edit !== null && edit.over === suggested ? edit.text : suggested;
  const isProject = budget.scope === 'project';
  const over = (budget.total - budget.L) as Microusd;
  return (
    <section className="card stack" aria-labelledby={titleId}>
      <h2 id={titleId}>
        Admission check: <span className="badge warning">Blocked</span>
      </h2>
      <p className="small">
        {isProject
          ? 'The project monthly allowance would be exceeded'
          : 'The run allowance would be exceeded'}{' '}
        by <span className="num">{formatMoney(over)}</span>. Relay did not reserve or send anything. A model
        cannot raise this allowance; only you can. Amounts are tracked by Relay.
      </p>
      <BudgetBreakdownTable breakdown={budget} />
      <h3>Choose how to continue</h3>
      <div className="grid grid-cols-3 gap-4 max-[1100px]:grid-cols-1">
        <div className="stack rounded-md border border-border p-4">
          <strong>{isProject ? 'Increase the monthly allowance' : 'Increase the run allowance'}</strong>
          {isProject ? (
            <MonthlyAllowanceEdit project={project} suggested={suggested} onSaved={onProjectAllowanceSaved} />
          ) : (
            <>
              <MoneyInput
                label="New run allowance (USD)"
                value={text}
                onValueChange={(t) => {
                  setEdit({ over: suggested, text: t });
                }}
              />
              <div>
                <Button
                  onClick={() => {
                    onSetAllowance(text);
                  }}
                >
                  Use this allowance and re-check
                </Button>
              </div>
            </>
          )}
        </div>
        <div className="stack rounded-md border border-border p-4">
          <strong>Use a cheaper profile</strong>
          <p className="small muted">A smaller model lowers the first reservation (N).</p>
          <ProfileSwitch rows={rows} profiles={profiles} selection={selection} onSelect={onSelectProfile} />
        </div>
        <div className="stack rounded-md border border-border p-4">
          <strong>Don&apos;t start</strong>
          <p className="small muted">Nothing was reserved or sent.</p>
          <div>
            <ButtonLink as={Link} to={paths.runs(projectId)} variant="ghost">
              Cancel
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}
