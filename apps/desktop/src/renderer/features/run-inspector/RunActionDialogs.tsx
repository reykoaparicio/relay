// Dialogs that collect the parameters of a run action (10 J2 action→op table): increase allowance, edit project
// allowance, choose profile, raise limits, and the unknown-outcome decision. Each one only builds a
// `RunActionRequest`; the page dispatches it through `useRunActions` (the single action→op mapping).
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { RUN_LIMIT_MAXIMUMS, UNKNOWN_OUTCOME_DECISIONS } from '@relay/contracts';
import type { Microusd, ProfileWithWarnings, ProjectDetail, RunDetail, StepView } from '@relay/contracts';
import { Button, Dialog, Field, Money, MoneyInput, NumberInput, RadioGroup, Select } from '../../components/ui';
import { formatDuration, PROVIDER_LABELS } from '../../lib/format';
import { dollarsText } from '../run-setup/limits';
import { ActionErrorNotice } from './ActionErrorNotice';
import { stepTitle } from './inspector-model';
import type { UnknownOutcomeDecision } from './run-actions';

interface BaseDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly pending: boolean;
  /** The last failure of this action (shown inside the dialog; the dialog stays open). */
  readonly error: unknown;
}

function DialogFooter({
  formId,
  submitLabel,
  pending,
  disabled = false,
  onCancel,
}: {
  readonly formId: string;
  readonly submitLabel: string;
  readonly pending: boolean;
  readonly disabled?: boolean;
  readonly onCancel: () => void;
}) {
  return (
    <>
      <Button variant="secondary" disabled={pending} onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="primary" type="submit" form={formId} pending={pending} disabled={disabled}>
        {submitLabel}
      </Button>
    </>
  );
}

function ActionForm({ id, onSubmit, children }: { readonly id: string; readonly onSubmit: () => void; readonly children: ReactNode }) {
  return (
    <form
      id={id}
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export interface AllowanceDialogProps extends BaseDialogProps {
  readonly run: RunDetail;
  readonly onSubmit: (newAllowanceMicrousd: Microusd) => void;
}

/** `increase_allowance` → `runs.increaseAllowance`. Only a higher allowance is accepted. */
export function IncreaseAllowanceDialog({ open, onOpenChange, pending, error, run, onSubmit }: AllowanceDialogProps) {
  const formId = useId();
  const [text, setText] = useState(() => dollarsText(run.cost.allowance));
  const [value, setValue] = useState<Microusd | null>(run.cost.allowance);
  const [touched, setTouched] = useState(false);
  const tooLow = value !== null && value <= run.cost.allowance;
  const fieldError = touched && tooLow ? `Enter more than the current ${dollarsText(run.cost.allowance)} USD.` : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Increase the run allowance"
      description="Only you can raise it; the model cannot. It applies to this run only."
      footer={
        <DialogFooter
          formId={formId}
          submitLabel="Save allowance and continue"
          pending={pending}
          onCancel={() => {
            onOpenChange(false);
          }}
        />
      }
    >
      <ActionForm
        id={formId}
        onSubmit={() => {
          setTouched(true);
          if (value !== null && !tooLow) onSubmit(value);
        }}
      >
        <MoneyInput
          label="New run allowance (USD)"
          value={text}
          required
          validateEmpty={touched}
          hint={
            <>
              Currently <Money value={run.cost.allowance} />. The run continues on its own when the next request fits.
            </>
          }
          error={fieldError}
          onValueChange={(t, parsed) => {
            setText(t);
            setValue(parsed);
          }}
        />
        <ActionErrorNotice error={error} />
      </ActionForm>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export interface ProjectAllowanceDialogProps extends BaseDialogProps {
  readonly project: ProjectDetail | undefined;
  readonly onSubmit: (monthlyAllowanceMicrousd: Microusd, expectedUpdatedAt: number) => void;
}

/** `edit_project_allowance` → `projects.update({ patch: { monthlyAllowanceMicrousd } })`. */
export function ProjectAllowanceDialog({ open, onOpenChange, pending, error, project, onSubmit }: ProjectAllowanceDialogProps) {
  const formId = useId();
  const current = project?.monthlyAllowanceMicrousd ?? null;
  const [text, setText] = useState(() => (current === null ? '' : dollarsText(current)));
  const [value, setValue] = useState<Microusd | null>(current);
  const [touched, setTouched] = useState(false);
  const tooLow = value !== null && current !== null && value <= current;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit the project monthly allowance"
      description="Applies to every run of this project this month. Paused runs that now fit continue on their own."
      footer={
        <DialogFooter
          formId={formId}
          submitLabel="Save project allowance"
          pending={pending}
          disabled={project === undefined}
          onCancel={() => {
            onOpenChange(false);
          }}
        />
      }
    >
      <ActionForm
        id={formId}
        onSubmit={() => {
          setTouched(true);
          if (project !== undefined && value !== null && !tooLow) onSubmit(value, project.updatedAt);
        }}
      >
        <MoneyInput
          label="Monthly allowance (USD)"
          value={text}
          required
          validateEmpty={touched}
          hint={current === null ? 'No monthly allowance is set.' : <>Currently <Money value={current} /> per month.</>}
          error={touched && tooLow ? 'Enter more than the current monthly allowance.' : undefined}
          onValueChange={(t, parsed) => {
            setText(t);
            setValue(parsed);
          }}
        />
        <ActionErrorNotice error={error} />
      </ActionForm>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export interface ProfileDialogProps extends BaseDialogProps {
  readonly step: StepView | undefined;
  /** Profiles the project permits (its allowed providers). */
  readonly profiles: readonly ProfileWithWarnings[];
  readonly onSubmit: (profileId: string) => void;
}

/**
 * `choose_profile`: permitted profiles only. A failed step is retried with the new profile (`runs.retryStep`);
 * other pauses switch the step's profile and resume (`runs.resume` `switch_profile`) — the mapping lives in run-actions.
 */
export function ChooseProfileDialog({ open, onOpenChange, pending, error, step, profiles, onSubmit }: ProfileDialogProps) {
  const formId = useId();
  const options = profiles
    .filter((p) => p.profile.name !== step?.profileName)
    .map((p) => ({
      value: p.profile.id,
      label: `${p.profile.name} · ${PROVIDER_LABELS[p.profile.providerId]} · ${p.profile.modelId}${p.warnings.length > 0 ? ' (has warnings)' : ''}`,
    }));
  const [choice, setChoice] = useState('');
  const selected = choice === '' ? (options[0]?.value ?? '') : choice;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={step === undefined ? 'Choose another profile' : `Choose another profile for ${stepTitle(step)}`}
      description="Only profiles permitted for this project are listed. The change is recorded as a configuration revision of this run."
      footer={
        <DialogFooter
          formId={formId}
          submitLabel={step?.state === 'failed' ? 'Retry step with this profile' : 'Switch profile and continue'}
          pending={pending}
          disabled={selected === '' || step === undefined}
          onCancel={() => {
            onOpenChange(false);
          }}
        />
      }
    >
      <ActionForm
        id={formId}
        onSubmit={() => {
          if (selected !== '' && step !== undefined) onSubmit(selected);
        }}
      >
        {options.length === 0 ? (
          <p>No other profile is permitted for this project. Add one in Settings → Model profiles.</p>
        ) : (
          <Field
            label="Profile"
            hint={step?.profileName === null || step === undefined ? undefined : `Currently ${step.profileName}.`}
          >
            {(control) => <Select {...control} value={selected} onValueChange={setChoice} options={options} />}
          </Field>
        )}
        <ActionErrorNotice error={error} />
      </ActionForm>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export interface LimitsDialogProps extends BaseDialogProps {
  readonly run: RunDetail;
  readonly onSubmit: (limits: { readonly maxAttempts?: number; readonly executionTimeoutSeconds?: number }) => void;
}

const MAX_TIMEOUT_MINUTES = Math.floor(RUN_LIMIT_MAXIMUMS.executionTimeoutSeconds / 60);

/** A whole number in (current, max], or empty (unchanged). */
function checkRaise(text: string, current: number, max: number): { value: number | undefined } | { error: string } {
  const t = text.trim();
  if (t === '') return { value: undefined };
  if (!/^\d+$/.test(t)) return { error: 'Enter a whole number.' };
  const n = Number.parseInt(t, 10);
  if (n <= current) return { error: `Enter more than the current ${String(current)}.` };
  if (n > max) return { error: `Must be at most ${String(max)} (the maximum Relay allows).` };
  return { value: n };
}

/** `raise_limits` → `runs.resume({ kind: 'raise_limits' })`. Bounded by `RUN_LIMIT_MAXIMUMS` with inline errors. */
export function RaiseLimitsDialog({ open, onOpenChange, pending, error, run, onSubmit }: LimitsDialogProps) {
  const formId = useId();
  const currentMinutes = Math.floor(run.limits.executionTimeoutSeconds / 60);
  const [attempts, setAttempts] = useState('');
  const [minutes, setMinutes] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const a = checkRaise(attempts, run.limits.maxAttempts, RUN_LIMIT_MAXIMUMS.maxAttempts);
  const m = checkRaise(minutes, currentMinutes, MAX_TIMEOUT_MINUTES);
  const aError = 'error' in a ? a.error : undefined;
  const mError = 'error' in m ? m.error : undefined;
  const nothing = 'value' in a && a.value === undefined && 'value' in m && m.value === undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Raise limits for this run"
      description="Only you can raise limits; the model cannot. This applies to this run only and does not change the run allowance."
      footer={
        <DialogFooter
          formId={formId}
          submitLabel="Save limits and resume"
          pending={pending}
          onCancel={() => {
            onOpenChange(false);
          }}
        />
      }
    >
      <ActionForm
        id={formId}
        onSubmit={() => {
          setSubmitted(true);
          if (aError !== undefined || mError !== undefined || nothing) return;
          const maxAttempts = 'value' in a ? a.value : undefined;
          const mins = 'value' in m ? m.value : undefined;
          onSubmit({
            ...(maxAttempts === undefined ? {} : { maxAttempts }),
            ...(mins === undefined ? {} : { executionTimeoutSeconds: mins * 60 }),
          });
        }}
      >
        <Field
          label="Max attempts"
          hint={`Currently ${String(run.limits.maxAttempts)}. Up to ${String(RUN_LIMIT_MAXIMUMS.maxAttempts)}.`}
          error={attempts.trim() === '' && !submitted ? undefined : aError}
        >
          {(control) => (
            <NumberInput
              {...control}
              value={attempts}
              min={run.limits.maxAttempts + 1}
              max={RUN_LIMIT_MAXIMUMS.maxAttempts}
              onValueChange={(t) => {
                setAttempts(t);
              }}
            />
          )}
        </Field>
        <Field
          label="Execution timeout (minutes)"
          hint={`Currently ${formatDuration(run.limits.executionTimeoutSeconds * 1000)}. Up to ${String(MAX_TIMEOUT_MINUTES)} min. Approval wait is not counted.`}
          error={minutes.trim() === '' && !submitted ? undefined : mError}
        >
          {(control) => (
            <NumberInput
              {...control}
              value={minutes}
              min={currentMinutes + 1}
              max={MAX_TIMEOUT_MINUTES}
              onValueChange={(t) => {
                setMinutes(t);
              }}
            />
          )}
        </Field>
        {submitted && nothing ? <p className="error">Raise at least one limit.</p> : null}
        <ActionErrorNotice error={error} />
      </ActionForm>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------

/** §4.4 decision labels: the retry label says it may incur another charge. */
export const UNKNOWN_DECISION_LABELS: Readonly<Record<UnknownOutcomeDecision, string>> = {
  retry_acknowledging_charge: 'Retry (may incur another charge)',
  mark_failed_keep_liability: 'Mark as failed without retry',
  accept_estimated_charge: 'Accept the estimated charge',
};

const UNKNOWN_DECISION_HINTS: Readonly<Record<UnknownOutcomeDecision, string>> = {
  retry_acknowledging_charge:
    'Creates a new attempt with a new reservation. The possible charge of the earlier request stays until it is resolved.',
  mark_failed_keep_liability: 'The step is marked failed; the possible charge stays recorded as unknown liability.',
  accept_estimated_charge: 'Records the estimated amount as the charge for this request.',
};

export interface DecideUnknownDialogProps extends BaseDialogProps {
  readonly run: RunDetail;
  readonly onSubmit: (attemptId: string, decision: UnknownOutcomeDecision) => void;
}

/** `decide_unknown` → `runs.decideUnknown`, one decision per unresolved attempt. */
export function DecideUnknownDialog({ open, onOpenChange, pending, error, run, onSubmit }: DecideUnknownDialogProps) {
  const formId = useId();
  const [attemptChoice, setAttemptChoice] = useState('');
  const [decision, setDecision] = useState<UnknownOutcomeDecision | null>(null);
  const attempts = run.unresolvedAttempts;
  const attemptId = attemptChoice === '' ? (attempts[0]?.id ?? '') : attemptChoice;
  const attempt = attempts.find((x) => x.id === attemptId);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Decide on the unknown request"
      description="Relay cannot confirm whether the provider processed this request. Choose how to record it."
      footer={
        <DialogFooter
          formId={formId}
          submitLabel="Continue with selected option"
          pending={pending}
          disabled={decision === null || attempt === undefined}
          onCancel={() => {
            onOpenChange(false);
          }}
        />
      }
    >
      <ActionForm
        id={formId}
        onSubmit={() => {
          if (decision !== null && attempt !== undefined) onSubmit(attempt.id, decision);
        }}
      >
        {attempts.length === 0 ? <p>No request is waiting for a decision.</p> : null}
        {attempts.length > 1 ? (
          <Field label="Request">
            {(control) => (
              <Select
                {...control}
                value={attemptId}
                onValueChange={setAttemptChoice}
                options={attempts.map((x) => ({ value: x.id, label: `${stepTitle(x)} · attempt ${String(x.seq)}` }))}
              />
            )}
          </Field>
        ) : null}
        {attempt === undefined ? null : (
          <p>
            {stepTitle(attempt)} · attempt {attempt.seq}: possible charge{' '}
            {attempt.cost === null ? 'not known' : <Money value={attempt.cost.microusd} certainty={attempt.cost.certainty} />}{' '}
            (liability kept until you decide).
          </p>
        )}
        <RadioGroup<UnknownOutcomeDecision>
          legend="Recovery options"
          value={decision}
          onValueChange={setDecision}
          options={UNKNOWN_OUTCOME_DECISIONS.map((d) => ({
            value: d,
            label: UNKNOWN_DECISION_LABELS[d],
            description: UNKNOWN_DECISION_HINTS[d],
          }))}
        />
        <ActionErrorNotice error={error} />
      </ActionForm>
    </Dialog>
  );
}
