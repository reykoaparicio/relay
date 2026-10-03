// Dialogs that collect the parameters of a run action (10 J2 action→op table): increase allowance, edit project
// allowance, choose profile, and raise limits. Each one only builds a
// `RunActionRequest`; the page dispatches it through `useRunActions` (the single action→op mapping).
import { useId, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { RUN_LIMIT_MAXIMUMS } from '@relay/contracts';
import type { Microusd, ProfileOption, ProfileWithWarnings, ProjectDetail, RunDetail, StepView } from '@relay/contracts';
import { Dialog, DialogFooter, Field, Money, MoneyInput, NumberInput, Select } from '../../components/ui';
import { formatDuration, formatMoney, formatTokensExact, PROVIDER_LABELS } from '../../lib/format';
import { dollarsText } from '../run-setup/limits';
import { ActionErrorNotice } from './ActionErrorNotice';
import { stepTitle } from './inspector-model';

interface BaseDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly pending: boolean;
  /** The last failure of this action (shown inside the dialog; the dialog stays open). */
  readonly error: unknown;
  /** Where focus goes on close when the opener is gone or disabled (a heading with `tabIndex={-1}`). */
  readonly returnFocusFallback?: RefObject<HTMLElement | null>;
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
export function IncreaseAllowanceDialog({ open, onOpenChange, pending, error, run, onSubmit, returnFocusFallback }: AllowanceDialogProps) {
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
      {...(returnFocusFallback === undefined ? {} : { returnFocusFallback })}
      title="Increase the run allowance"
      description="Only you can raise it; the model cannot. It applies to this run only."
      footer={
        <DialogFooter
          formId={formId}
          primaryLabel="Save allowance and continue"
          pending={pending}
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
export function ProjectAllowanceDialog({ open, onOpenChange, pending, error, project, onSubmit, returnFocusFallback }: ProjectAllowanceDialogProps) {
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
      {...(returnFocusFallback === undefined ? {} : { returnFocusFallback })}
      title="Edit the project monthly allowance"
      description="Applies to every run of this project this month. Paused runs that now fit continue on their own."
      footer={
        <DialogFooter
          formId={formId}
          primaryLabel="Save project allowance"
          pending={pending}
          primaryDisabled={project === undefined}
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
  /** Profiles the project permits: those whose provider is in the loaded project's `allowedProviderIds`. */
  readonly profiles: readonly ProfileWithWarnings[];
  /**
   * E1 `RunDetail.profileOptions` for the step (with the reservation each would need). When non-empty, the dialog
   * lists these (still only permitted providers) and marks the current one; absent or empty → `profiles` as before.
   */
  readonly profileOptions?: readonly ProfileOption[] | undefined;
  /** The project's allowed providers (loaded); options of other providers are never offered. */
  readonly allowedProviderIds?: readonly string[] | undefined;
  /** The step's display name (`RunDetail.stepMeta`), else its key label. */
  readonly stepName?: string | undefined;
  /** Shown instead of the generic copy when no profile is offered (e.g. the project allows no provider). */
  readonly emptyMessage?: ReactNode;
  readonly onSubmit: (profileId: string) => void;
}

/** "reserves ≈ $0.24" (from the step's estimate) or "reserves at least ≈ $0.08" (input not estimated yet). */
export function reservationText(o: Pick<ProfileOption, 'basis' | 'reservationMicrousd'>): string {
  const amount = formatMoney(o.reservationMicrousd);
  return o.basis === 'minimum' ? `reserves at least ≈ ${amount}` : `reserves ≈ ${amount}`;
}

/** L-1: " · output limit lowered to 64,000" when choosing the profile lowers the step's output limit to its model's cap. */
export function outputLimitNote(o: Pick<ProfileOption, 'outputLimitLoweredTo'>): string {
  return o.outputLimitLoweredTo === undefined ? '' : ` · output limit lowered to ${formatTokensExact(o.outputLimitLoweredTo)}`;
}

interface ProfileChoice {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

function choicesOf(
  step: StepView | undefined,
  profiles: readonly ProfileWithWarnings[],
  profileOptions: readonly ProfileOption[] | undefined,
  allowedProviderIds: readonly string[] | undefined,
): readonly ProfileChoice[] {
  const forStep = (profileOptions ?? []).filter((o) => step === undefined || o.stepKey === step.stepKey);
  if (forStep.length === 0) {
    return profiles
      .filter((p) => p.profile.name !== step?.profileName)
      .map((p) => ({
        value: p.profile.id,
        label: `${p.profile.name} · ${PROVIDER_LABELS[p.profile.providerId]} · ${p.profile.modelId}${p.warnings.length > 0 ? ' (has warnings)' : ''}`,
      }));
  }
  const allowed = allowedProviderIds === undefined ? null : new Set<string>(allowedProviderIds);
  const warned = new Set(profiles.filter((p) => p.warnings.length > 0).map((p) => p.profile.id));
  return forStep
    .filter((o) => allowed === null || allowed.has(o.providerId))
    .map((o) => ({
      value: o.profileId,
      label: `${o.profileName} · ${PROVIDER_LABELS[o.providerId]} · ${o.modelId} · ${reservationText(o)}${outputLimitNote(o)}${warned.has(o.profileId) ? ' (has warnings)' : ''}${o.current ? ' (current)' : ''}`,
      // The current profile is listed for comparison but cannot be chosen again.
      ...(o.current ? { disabled: true } : {}),
    }));
}

/**
 * `choose_profile`: permitted profiles only, each with the reservation it would need (E1 `profileOptions`). A failed
 * step is retried with the new profile (`runs.retryStep`); other pauses switch the step's profile and resume
 * (`runs.resume` `switch_profile`) — the mapping lives in run-actions.
 */
export function ChooseProfileDialog({
  open,
  onOpenChange,
  pending,
  error,
  step,
  profiles,
  profileOptions,
  allowedProviderIds,
  stepName,
  emptyMessage,
  onSubmit,
  returnFocusFallback,
}: ProfileDialogProps) {
  const formId = useId();
  const options = choicesOf(step, profiles, profileOptions, allowedProviderIds);
  const selectable = options.filter((o) => o.disabled !== true);
  const [choice, setChoice] = useState('');
  const selected = choice === '' ? (selectable[0]?.value ?? '') : choice;
  const title = step === undefined ? undefined : (stepName ?? stepTitle(step));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      {...(returnFocusFallback === undefined ? {} : { returnFocusFallback })}
      title={title === undefined ? 'Choose another profile' : `Choose another profile for ${title}`}
      description="Only profiles permitted for this project are listed. The change is recorded as a configuration revision of this run."
      footer={
        <DialogFooter
          formId={formId}
          primaryLabel={step?.state === 'failed' ? 'Retry step with this profile' : 'Switch profile and continue'}
          pending={pending}
          primaryDisabled={selected === '' || step === undefined}
        />
      }
    >
      <ActionForm
        id={formId}
        onSubmit={() => {
          if (selected !== '' && step !== undefined) onSubmit(selected);
        }}
      >
        {selectable.length === 0 ? (
          <p>{emptyMessage ?? 'No other profile is permitted for this project. Add one in Settings → Model profiles.'}</p>
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
export function RaiseLimitsDialog({ open, onOpenChange, pending, error, run, onSubmit, returnFocusFallback }: LimitsDialogProps) {
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
      {...(returnFocusFallback === undefined ? {} : { returnFocusFallback })}
      title="Raise limits for this run"
      description="Only you can raise limits; the model cannot. This applies to this run only and does not change the run allowance."
      footer={
        <DialogFooter
          formId={formId}
          primaryLabel="Save limits and resume"
          pending={pending}
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
