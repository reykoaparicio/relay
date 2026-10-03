import { useId } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { MEMORY_TYPES } from '@relay/contracts';
import type { MemoryType, ProfileWithWarnings, StepSpec, WorkflowVersionView } from '@relay/contracts';
import {
  Button,
  Checkbox,
  Field,
  ListItemButton,
  MoneyInput,
  NumberInput,
  RadioGroup,
  Select,
  Textarea,
  TextInput,
} from '../../components/ui';
import { MEMORY_TYPE_LABELS, PROVIDER_LABELS, stepKeyLabel } from '../../lib/format';
import { LIMIT_BOUNDS } from '../run-setup/limits';
import { profileIdByName, ROLE_LABELS } from '../run-setup/model-steps';
import { OUTPUT_TOKENS_BOUNDS, promptVersioning, RETRY_BOUNDS, STEP_NAME_MAX, WF_FIELD } from './workflow-form';
import type { ModelStep, StepForm, WorkflowForm } from './workflow-form';

type SetForm = Dispatch<SetStateAction<WorkflowForm>>;

function profileOf(profiles: readonly ProfileWithWarnings[], name: string): ProfileWithWarnings | undefined {
  const id = profileIdByName(profiles, name);
  return profiles.find((p) => p.profile.id === id);
}

function stepMeta(step: StepSpec, form: WorkflowForm, profiles: readonly ProfileWithWarnings[]): string {
  if (step.kind === 'approval') return 'Human decision · Required · binds plan + context hash';
  const name = form.steps[step.id]?.profile ?? step.profile;
  const profile = profileOf(profiles, name);
  return `${profile?.profile.name ?? name} profile · ${step.outputSchema} · ${ROLE_LABELS[step.role]}`;
}

export interface StepListProps {
  readonly view: WorkflowVersionView;
  readonly form: WorkflowForm;
  readonly profiles: readonly ProfileWithWarnings[];
  readonly selected: string;
  readonly errorCounts: Readonly<Record<string, number>>;
  readonly structuralId: string;
  readonly onSelect: (stepKey: string) => void;
}

/** Ordered steps with the structural controls rendered disabled and explained (§5.3: structure is P1). */
export function StepList({ view, form, profiles, selected, errorCounts, structuralId, onSelect }: StepListProps) {
  const headingId = useId();
  return (
    <section className="card stack" aria-labelledby={headingId}>
      <div className="stack" style={{ gap: 4 }}>
        <h2 id={headingId}>Ordered steps</h2>
        <p className="subtle small">Fixed template: {view.spec.name}. Select a step to edit its prompt, profile and limits.</p>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {['Add step', 'Reorder steps', 'Remove step'].map((label) => (
          <Button key={label} size="sm" aria-disabled="true" aria-describedby={structuralId} onClick={() => undefined}>
            {label}
          </Button>
        ))}
      </div>
      <p className="subtle small" id={structuralId}>
        Structural editing arrives in a later release. In this preview the step order, dependencies and the approval gate
        are fixed; prompts, profiles and limits are editable.
      </p>
      <ol className="list" aria-label="Workflow steps">
        {view.spec.steps.map((s, i) => {
          const errors = errorCounts[s.id] ?? 0;
          return (
            <li key={s.id}>
              <ListItemButton
                id={WF_FIELD.step(s.id)}
                aria-current={s.id === selected ? 'true' : undefined}
                onClick={() => {
                  onSelect(s.id);
                }}
                leading={<span className="num muted">{String(i + 1)}</span>}
                title={
                  <>
                    <span className="sr-only">Step {String(i + 1)}:</span> {stepTitleOf(s.id, form)}
                  </>
                }
                meta={stepMeta(s, form, profiles)}
                {...(errors === 0
                  ? {}
                  : { badges: <span className="badge danger">{errors === 1 ? '1 error' : `${String(errors)} errors`}</span> })}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** A step's display name from the form (trimmed), else its key label. */
function stepTitleOf(stepKey: string, form: WorkflowForm): string {
  const name = (form.names[stepKey] ?? '').trim();
  return name === '' ? stepKeyLabel(stepKey) : name;
}

/** "8000" → "8,000" (a locked numeric field, formatted like New run); other text unchanged. */
function groupDigits(text: string): string {
  return /^\d+$/.test(text.trim()) ? Number.parseInt(text, 10).toLocaleString() : text;
}

export interface LimitsCardProps {
  readonly view: WorkflowVersionView;
  readonly form: WorkflowForm;
  readonly errors: Readonly<Record<string, string>>;
  readonly onChange: SetForm;
}

/** Workflow-level limits (snapshotted into every run), bounded by RUN_LIMIT_MAXIMUMS. */
export function LimitsCard({ view, form, errors, onChange }: LimitsCardProps) {
  const headingId = useId();
  const editable = view.editable.limits;
  const set = (patch: Partial<WorkflowForm>) => {
    onChange((f) => ({ ...f, ...patch }));
  };
  return (
    <section className="card stack" aria-labelledby={headingId}>
      <div className="card-header">
        <h2 id={headingId}>Workflow limits</h2>
        <span className="subtle small">Snapshotted into every run</span>
      </div>
      <div className="grid grid-cols-2 items-start gap-4 max-[700px]:grid-cols-1">
        {editable ? (
          <MoneyInput
            id={WF_FIELD.allowance}
            label="Run allowance (USD)"
            value={form.allowance}
            hint="Checked before every call. Tracked by Relay."
            {...(errors[WF_FIELD.allowance] === undefined ? {} : { error: errors[WF_FIELD.allowance] })}
            onValueChange={(text) => {
              set({ allowance: text });
            }}
          />
        ) : (
          // Limits are locked for this version: the allowance is shown, not editable (like the other limit inputs).
          <Field label="Run allowance (USD)" id={WF_FIELD.allowance} hint="Checked before every call. Tracked by Relay. Locked for this version.">
            {(control) => (
              <span className="money-input">
                <span className="prefix" aria-hidden="true">
                  $
                </span>
                <input {...control} className="input mono" type="text" value={form.allowance} readOnly />
              </span>
            )}
          </Field>
        )}
        <Field
          label="Revision cycles"
          id={WF_FIELD.revisions}
          hint={`Then the run is marked incomplete. ${String(LIMIT_BOUNDS.maxRevisionCycles.min)}–${String(LIMIT_BOUNDS.maxRevisionCycles.max)}.`}
          error={errors[WF_FIELD.revisions]}
        >
          {(control) => (
            <NumberInput
              {...control}
              value={form.revisions}
              min={LIMIT_BOUNDS.maxRevisionCycles.min}
              max={LIMIT_BOUNDS.maxRevisionCycles.max}
              readOnly={!editable}
              onValueChange={(text) => {
                set({ revisions: text });
              }}
            />
          )}
        </Field>
        <Field
          label="Max attempts (run)"
          id={WF_FIELD.attempts}
          hint={`Across all steps. ${String(LIMIT_BOUNDS.maxAttempts.min)}–${String(LIMIT_BOUNDS.maxAttempts.max)}.`}
          error={errors[WF_FIELD.attempts]}
        >
          {(control) => (
            <NumberInput
              {...control}
              value={form.attempts}
              min={LIMIT_BOUNDS.maxAttempts.min}
              max={LIMIT_BOUNDS.maxAttempts.max}
              readOnly={!editable}
              onValueChange={(text) => {
                set({ attempts: text });
              }}
            />
          )}
        </Field>
        <Field
          label="Timeout (minutes)"
          id={WF_FIELD.timeout}
          hint={`Execution time only; waiting for your approval does not count. ${String(LIMIT_BOUNDS.timeoutMinutes.min)}–${String(LIMIT_BOUNDS.timeoutMinutes.max)}.`}
          error={errors[WF_FIELD.timeout]}
        >
          {(control) => (
            <NumberInput
              {...control}
              value={form.timeoutMinutes}
              min={LIMIT_BOUNDS.timeoutMinutes.min}
              max={LIMIT_BOUNDS.timeoutMinutes.max}
              readOnly={!editable}
              onValueChange={(text) => {
                set({ timeoutMinutes: text });
              }}
            />
          )}
        </Field>
      </div>
      <p className="small">Concurrency: one step at a time (fixed in this release).</p>
      <p className="subtle small">
        Relay pauses before dispatch when the next request would exceed the remaining allowance. Models cannot raise
        limits.
      </p>
    </section>
  );
}

export interface StepDetailProps {
  readonly view: WorkflowVersionView;
  readonly step: StepSpec;
  readonly index: number;
  readonly form: WorkflowForm;
  readonly profiles: readonly ProfileWithWarnings[];
  readonly errors: Readonly<Record<string, string>>;
  readonly showPrompt: boolean;
  /** Instruction versions a validated version carries (E1), or null while unknown. */
  readonly publishedPrompts: ReadonlySet<string> | null;
  readonly onShowPrompt: (show: boolean) => void;
  readonly onChange: SetForm;
}

/** Optional display name of any step (E2 #10): 1–60 characters, trimmed; empty = no name. */
function StepNameField({ step, form, errors, onChange }: Pick<StepDetailProps, 'step' | 'form' | 'errors' | 'onChange'>) {
  const value = form.names[step.id] ?? '';
  return (
    <Field
      label="Name (optional)"
      id={WF_FIELD.name(step.id)}
      hint={`Shown in the editor and the run inspector instead of "${stepKeyLabel(step.id)}". Up to ${String(STEP_NAME_MAX)} characters.`}
      error={errors[WF_FIELD.name(step.id)]}
    >
      {(control) => (
        <TextInput
          {...control}
          value={value}
          autoComplete="off"
          onValueChange={(text) => {
            onChange((prev) => ({ ...prev, names: { ...prev.names, [step.id]: text } }));
          }}
        />
      )}
    </Field>
  );
}

/** Detail form of the selected step (§5.3 fields). Approval steps are read-only in P0. */
export function StepDetail(props: StepDetailProps) {
  const { step, index } = props;
  const headingId = useId();
  return (
    <section className="card stack" aria-labelledby={headingId}>
      <div className="card-header">
        <h2 id={headingId}>
          Step {String(index + 1)}: {stepTitleOf(step.id, props.form)}
        </h2>
        <span className="badge">{step.kind === 'model' ? 'Model step' : 'Approval step'}</span>
      </div>
      <StepNameField {...props} />
      {step.kind === 'model' ? (
        <ModelStepFields {...props} step={step} />
      ) : (
        <div className="stack">
          <p>
            A person approves the plan before the implementer runs. The approval binds the plan hash and the context
            hash; a changed plan or project file needs a new approval.
          </p>
          <p className="small muted">
            Depends on: {step.dependsOn.map(stepKeyLabel).join(', ')} · binds {step.bindTo.join(' + ')}. Apart from
            its name, an approval step cannot be edited in this preview.
          </p>
        </div>
      )}
      <hr className="divider" />
      <p className="small" style={{ color: 'var(--color-accent)' }}>
        New edits affect future runs only. Active runs keep the version they snapshotted.
      </p>
    </section>
  );
}

function ModelStepFields({ view, step, form, profiles, errors, showPrompt, publishedPrompts, onShowPrompt, onChange }: StepDetailProps & { readonly step: ModelStep }) {
  const promptWrapId = useId();
  const schemaId = useId();
  const f = form.steps[step.id];
  if (f === undefined) return null;
  const setStep = (patch: Partial<StepForm>) => {
    onChange((prev) => {
      const current = prev.steps[step.id];
      return current === undefined ? prev : { ...prev, steps: { ...prev.steps, [step.id]: { ...current, ...patch } } };
    });
  };
  const iv = step.instructionVersion;
  const promptText = form.prompts[iv];
  const versioning = promptVersioning(view, iv, publishedPrompts);
  const versionNote =
    versioning.kind === 'published'
      ? `Editing creates ${versioning.next}; runs that used ${iv} keep it.`
      : versioning.kind === 'draft_only'
        ? `${iv} exists only in this draft; editing changes it in place.`
        : null;
  const role = ROLE_LABELS[step.role];
  const resolved = profileOf(profiles, f.profile);
  const profileOptions = [
    ...(resolved === undefined ? [{ value: f.profile, label: `${f.profile} (no matching profile)` }] : []),
    ...profiles.map((p) => ({ value: p.profile.name, label: `${p.profile.name} · ${PROVIDER_LABELS[p.profile.providerId]}` })),
  ];
  const editable = view.editable;
  const toggleType = (t: MemoryType, on: boolean) => {
    setStep({ memoryTypes: on ? [...f.memoryTypes, t] : f.memoryTypes.filter((x) => x !== t) });
  };
  const scopeError = errors[WF_FIELD.memoryScope(step.id)];

  return (
    <div className="stack">
      <dl className="kv">
        <dt>Role</dt>
        <dd>{role} (fixed by the template)</dd>
      </dl>
      <div className="field">
        <span className="label">Instruction version</span>
        <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="mono" data-testid="instruction-version">
            {iv}
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={showPrompt}
            aria-controls={promptWrapId}
            onClick={() => {
              onShowPrompt(!showPrompt);
            }}
          >
            {showPrompt ? 'Hide prompt' : editable.prompts ? 'View and edit prompt' : 'View prompt'}
          </Button>
        </span>
        {versionNote === null || !editable.prompts ? null : (
          <span className="hint" data-testid="instruction-version-note">
            {versionNote}
          </span>
        )}
        <div id={promptWrapId} hidden={!showPrompt}>
          {promptText === undefined ? (
            <p className="small muted">This build has no prompt text for {iv}.</p>
          ) : (
            <Field
              label={`${role} instructions, ${iv}`}
              id={WF_FIELD.prompt(step.id)}
              hint="Editing changes the instructions in this draft. Project files and memory are added at run time, not here."
              error={errors[WF_FIELD.prompt(step.id)]}
            >
              {(control) => (
                <Textarea
                  {...control}
                  className="mono"
                  rows={8}
                  value={promptText}
                  readOnly={!editable.prompts}
                  onValueChange={(text) => {
                    onChange((prev) => ({ ...prev, prompts: { ...prev.prompts, [iv]: text } }));
                  }}
                />
              )}
            </Field>
          )}
        </div>
      </div>
      <Field
        label="Model profile"
        id={WF_FIELD.profile(step.id)}
        hint={
          resolved === undefined
            ? 'No profile has this name. Choose one of your profiles.'
            : `Resolves to ${PROVIDER_LABELS[resolved.profile.providerId]} · ${resolved.profile.modelId}. ${
                resolved.warnings.length === 0 ? 'No capability warnings.' : resolved.warnings.map((w) => w.message).join(' ')
              }`
        }
        error={errors[WF_FIELD.profile(step.id)]}
      >
        {(control) => (
          <Select
            {...control}
            value={resolved?.profile.name ?? f.profile}
            disabled={!editable.profiles}
            options={profileOptions}
            onValueChange={(v) => {
              setStep({ profile: v });
            }}
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-4 max-[700px]:grid-cols-1">
        <Field label="Expected output schema" id={schemaId} hint="Fixed by the template.">
          {(control) => <input {...control} className="input mono" value={step.outputSchema} readOnly />}
        </Field>
        <Field
          label="Output token maximum"
          id={WF_FIELD.maxOutputTokens(step.id)}
          hint={
            f.maxOutputTokens === '' && resolved !== undefined
              ? `Empty: the profile's ${resolved.profile.params.maxOutputTokens.toLocaleString()} applies. Reserved in full before dispatch.`
              : 'Reserved in full before dispatch.'
          }
          error={errors[WF_FIELD.maxOutputTokens(step.id)]}
        >
          {(control) =>
            editable.maxOutputTokens ? (
              <NumberInput
                {...control}
                value={f.maxOutputTokens}
                min={OUTPUT_TOKENS_BOUNDS.min}
                max={OUTPUT_TOKENS_BOUNDS.max}
                onValueChange={(text) => {
                  setStep({ maxOutputTokens: text });
                }}
              />
            ) : (
              // Locked: shown like New run shows it ("8,000").
              <input {...control} className="input mono" type="text" readOnly value={groupDigits(f.maxOutputTokens)} />
            )
          }
        </Field>
      </div>
      <div className="field">
        <span className="label">Allowed tools</span>
        <span>None. Model steps read the selected context and return structured output.</span>
        <span className="hint">Read-only in this preview. Source-file writes and shell commands are not available.</span>
      </div>
      <fieldset className="fieldset field">
        <legend>Retry policy</legend>
        <div className="grid grid-cols-3 gap-4 max-[900px]:grid-cols-1">
          {(
            [
              ['transport', 'Transport retries', 'Only when the attempt is known not to have executed.'],
              ['schemaRepair', 'Schema repair attempts', 'Unknown outcomes never retry automatically.'],
              ['rateLimitWaits', 'Rate-limit waits', 'Waits after a provider rate limit.'],
            ] as const
          ).map(([k, label, hint]) => (
            <Field key={k} label={label} id={WF_FIELD[k](step.id)} hint={`${hint} Max ${String(RETRY_BOUNDS[k].max)}.`} error={errors[WF_FIELD[k](step.id)]}>
              {(control) => (
                <NumberInput
                  {...control}
                  value={f[k]}
                  min={RETRY_BOUNDS[k].min}
                  max={RETRY_BOUNDS[k].max}
                  readOnly={!editable.retryPolicy}
                  onValueChange={(text) => {
                    setStep({ [k]: text });
                  }}
                />
              )}
            </Field>
          ))}
        </div>
      </fieldset>
      <div id={WF_FIELD.memoryScope(step.id)} tabIndex={-1} className="stack">
        <RadioGroup<'all' | 'step_role'>
          legend="Memory scope"
          value={f.memoryRoles}
          onValueChange={(v) => {
            if (editable.memoryScope) setStep({ memoryRoles: v });
          }}
          options={[
            { value: 'all', label: 'Records for all roles', disabled: !editable.memoryScope },
            { value: 'step_role', label: `Only records scoped to ${role}`, disabled: !editable.memoryScope },
          ]}
        />
        <fieldset className="fieldset field">
          <legend>Record types this step may receive</legend>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            {MEMORY_TYPES.map((t) => (
              <Checkbox
                key={t}
                label={MEMORY_TYPE_LABELS[t]}
                checked={f.memoryTypes.includes(t)}
                disabled={!editable.memoryScope}
                onCheckedChange={(on) => {
                  toggleType(t, on);
                }}
              />
            ))}
          </div>
          {scopeError === undefined ? null : <span className="error">{scopeError}</span>}
          <span className="hint">Approved records for this project only. Suggestions are never included.</span>
        </fieldset>
      </div>
    </div>
  );
}
