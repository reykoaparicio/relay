import { useId, useState } from 'react';
import { Link } from 'react-router';
import type { BudgetBreakdown } from '@relay/contracts';
import { BudgetBreakdownTable, Button, ButtonLink, MoneyInput } from '../../components/ui';
import { formatMoney } from '../../lib/format';
import { paths } from '../shell/paths';
import { dollarsText } from '../run-setup/limits';
import type { Microusd } from '@relay/contracts';

export interface BudgetBlockedPanelProps {
  readonly budget: BudgetBreakdown;
  readonly projectId: string;
  /** Applies a new run allowance to the form (the preflight re-checks). */
  readonly onSetAllowance: (text: string) => void;
  /** Moves focus to the first profile select. */
  readonly onChooseProfile: () => void;
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
  projectId,
  onSetAllowance,
  onChooseProfile,
}: BudgetBlockedPanelProps) {
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
            <>
              <p className="small muted">
                The project monthly allowance is a project setting, recorded as a policy change.
              </p>
              <div>
                <ButtonLink as={Link} to={paths.settings('projects', { project: projectId })}>
                  Edit project allowance
                </ButtonLink>
              </div>
            </>
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
          <div>
            <Button onClick={onChooseProfile}>Choose a profile</Button>
          </div>
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
