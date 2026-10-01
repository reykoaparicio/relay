// The cards of the new-run form (10 J7, SPLIT-01). Presentational: the page owns the form reducer, the queries and
// the derived state (`deriveNewRunState`), and passes values and callbacks down.
import { useId } from 'react';
import { FileDiff, Play } from 'lucide-react';
import { Link } from 'react-router';
import type {
  MemoryRecordView,
  NextAction,
  PreviewResult,
  ProfileWithWarnings,
  ProviderStatus,
  RunPreflight,
  WorkflowSummary,
} from '@relay/contracts';
import {
  Button,
  ButtonLink,
  Card,
  CardHeader,
  ErrorView,
  Field,
  InlineAlert,
  KeyValueList,
  MoneyInput,
  NumberInput,
  RadioGroup,
  Skeleton,
  Textarea,
} from '../../components/ui';
import { toViewError } from '../../api/errors';
import { formatHash } from '../../lib/format';
import { LIMIT_BOUNDS } from '../run-setup/limits';
import type { ModelStepRow } from '../run-setup/model-steps';
import { PreflightSummary, ProvidersReceiving } from '../run-setup/PreflightSummary';
import { ProfileAssignmentTable } from '../run-setup/ProfileAssignmentTable';
import { paths } from '../shell/paths';
import { FilePicker } from './FilePicker';
import { MemoryPicker } from './MemoryPicker';
import { FIELD } from './new-run-model';
import type { FormAction, LimitTexts, NewRunForm } from './new-run-model';

type Dispatch = (action: FormAction) => void;
type FieldErrors = Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------------------------------------------
// Goal and input

export interface GoalInputCardProps {
  readonly form: NewRunForm;
  readonly dispatch: Dispatch;
  readonly fieldErrors: FieldErrors;
  readonly files: readonly string[];
  readonly preview: { readonly data: PreviewResult | undefined; readonly error: unknown; readonly refetch: () => void };
  readonly importDiff: { readonly isPending: boolean; readonly error: unknown; readonly start: () => void };
  readonly onImportErrorAction: (action: NextAction) => void;
}

export function GoalInputCard({ form, dispatch, fieldErrors, files, preview, importDiff, onImportErrorAction }: GoalInputCardProps) {
  const titleId = useId();
  return (
    <Card labelledBy={titleId}>
      <CardHeader title="Goal and input" titleId={titleId} />
      <Field
        id={FIELD.goal}
        label="Goal"
        required
        hint="Describe the outcome. Relay sends this to every role in the workflow."
        error={fieldErrors[FIELD.goal]}
      >
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={2000}
            value={form.goal}
            onValueChange={(v) => {
              dispatch({ type: 'patch', patch: { goal: v } });
            }}
          />
        )}
      </Field>
      <RadioGroup
        legend="Input source"
        value={form.source}
        onValueChange={(v) => {
          dispatch({ type: 'patch', patch: { source: v } });
        }}
        options={[
          { value: 'files', label: 'Selected files', description: 'Pick files under the project root' },
          { value: 'diff', label: 'Import a .diff/.patch file', description: 'A change prepared outside Relay' },
        ]}
      />
      {form.source === 'files' ? (
        <FilePicker
          preview={preview.data}
          error={preview.error}
          onRetry={preview.refetch}
          selected={files}
          fieldError={fieldErrors[FIELD.files]}
          onChange={(next) => {
            dispatch({ type: 'patch', patch: { files: next } });
          }}
        />
      ) : (
        <DiffImport form={form} fieldError={fieldErrors[FIELD.diff]} importDiff={importDiff} onImportErrorAction={onImportErrorAction} />
      )}
    </Card>
  );
}

function DiffImport({
  form,
  fieldError,
  importDiff,
  onImportErrorAction,
}: Pick<GoalInputCardProps, 'form' | 'importDiff' | 'onImportErrorAction'> & { readonly fieldError: string | undefined }) {
  return (
    <div className="stack">
      <div>
        <Button
          id={FIELD.diff}
          icon={FileDiff}
          pending={importDiff.isPending}
          aria-describedby={fieldError === undefined ? undefined : `${FIELD.diff}-error`}
          onClick={importDiff.start}
        >
          {form.diff === null ? 'Import a .diff/.patch file…' : 'Import a different file…'}
        </Button>
      </div>
      {fieldError === undefined ? null : (
        <span className="error" id={`${FIELD.diff}-error`}>
          {fieldError}
        </span>
      )}
      {form.diff === null ? null : (
        <p className="small">
          Imported diff touching {String(form.diff.files.length)} file
          {form.diff.files.length === 1 ? '' : 's'}: <span className="mono">{form.diff.files.join(', ')}</span>
        </p>
      )}
      {form.diff === null || form.diff.parseWarnings.length === 0 ? null : (
        <InlineAlert tone="warning" title="Relay read the file with warnings">
          <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
            {form.diff.parseWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </InlineAlert>
      )}
      {importDiff.error === null ? null : (
        <ErrorView live="assertive" error={toViewError(importDiff.error)} onAction={onImportErrorAction} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Workflow and profiles

export interface WorkflowCardProps {
  readonly projectId: string;
  readonly summary: WorkflowSummary;
  readonly contentHash: string | undefined;
  readonly rows: readonly ModelStepRow[];
  readonly profiles: readonly ProfileWithWarnings[];
  readonly providers: readonly ProviderStatus[] | undefined;
  readonly selection: Readonly<Record<string, string>>;
  readonly profileErrors: FieldErrors;
  readonly dispatch: Dispatch;
}

export function WorkflowCard({ projectId, summary, contentHash, rows, profiles, providers, selection, profileErrors, dispatch }: WorkflowCardProps) {
  const titleId = useId();
  return (
    <Card labelledBy={titleId}>
      <CardHeader
        title="Workflow"
        titleId={titleId}
        actions={
          <ButtonLink as={Link} size="sm" variant="ghost" to={paths.workflow(projectId, summary.id)}>
            Open in editor
          </ButtonLink>
        }
      />
      <KeyValueList
        items={[
          {
            id: 'version',
            term: 'Version',
            value: `${summary.name} · v${String(summary.latestValidatedVersion)} · pinned for this run`,
          },
          { id: 'hash', term: 'Snapshot', value: formatHash(contentHash ?? ''), mono: true },
        ]}
      />
      <p className="small muted">
        Profiles below are copied into the run snapshot. Later edits to profiles or the workflow do not change this run.
      </p>
      <ProfileAssignmentTable
        caption="Role to model profile snapshot"
        rows={rows}
        profiles={profiles}
        providers={providers}
        selected={selection}
        errors={profileErrors}
        selectId={FIELD.profile}
        onSelect={(stepKey, profileId) => {
          dispatch({ type: 'select-profile', stepKey, profileId });
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Limits

export interface LimitsCardProps {
  readonly texts: LimitTexts;
  readonly fieldErrors: FieldErrors;
  readonly dispatch: Dispatch;
}

export function LimitsCard({ texts, fieldErrors, dispatch }: LimitsCardProps) {
  const titleId = useId();
  const patch = (p: Partial<NewRunForm>) => {
    dispatch({ type: 'patch', patch: p });
  };
  return (
    <Card labelledBy={titleId}>
      <CardHeader title="Limits" titleId={titleId} />
      <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
        <MoneyInput
          id={FIELD.allowance}
          label="Run allowance (USD)"
          required
          value={texts.allowance}
          hint="Checked before every call. Tracked by Relay."
          error={fieldErrors[FIELD.allowance]}
          onValueChange={(t) => {
            patch({ allowanceText: t });
          }}
        />
        <LimitField
          id={FIELD.revisions}
          label="Revision cycles"
          hint="Then the run is marked incomplete."
          bounds={LIMIT_BOUNDS.maxRevisionCycles}
          value={texts.revisions}
          error={fieldErrors[FIELD.revisions]}
          onChange={(t) => {
            patch({ revisionText: t });
          }}
        />
        <LimitField
          id={FIELD.attempts}
          label="Max attempts (run)"
          hint="Across all steps."
          bounds={LIMIT_BOUNDS.maxAttempts}
          value={texts.attempts}
          error={fieldErrors[FIELD.attempts]}
          onChange={(t) => {
            patch({ attemptsText: t });
          }}
        />
        <LimitField
          id={FIELD.timeout}
          label="Timeout (minutes)"
          hint="Execution time only; waiting for your approval does not count."
          bounds={LIMIT_BOUNDS.timeoutMinutes}
          value={texts.timeout}
          error={fieldErrors[FIELD.timeout]}
          onChange={(t) => {
            patch({ timeoutText: t });
          }}
        />
      </div>
      <p className="small muted">Concurrency: one step at a time (fixed in this release).</p>
    </Card>
  );
}

interface LimitFieldProps {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly bounds: { readonly min: number; readonly max: number };
  readonly value: string;
  readonly error: string | undefined;
  readonly onChange: (text: string) => void;
}

/** A bounded whole-number limit (RUN_LIMIT_MAXIMUMS); the error shows as soon as the value is out of range. */
function LimitField({ id, label, hint, bounds, value, error, onChange }: LimitFieldProps) {
  return (
    <Field id={id} label={label} hint={`${hint} ${String(bounds.min)}–${String(bounds.max)}.`} error={error}>
      {(control) => (
        <NumberInput
          {...control}
          min={bounds.min}
          max={bounds.max}
          value={value}
          onValueChange={(t) => {
            onChange(t);
          }}
        />
      )}
    </Field>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Memory

export interface MemoryCardProps {
  readonly approved: { readonly data: readonly MemoryRecordView[] | undefined; readonly error: unknown; readonly refetch: () => void };
  readonly suggestions: number;
  readonly checked: readonly string[] | null;
  readonly fieldError: string | undefined;
  readonly dispatch: Dispatch;
}

export function MemoryCard({ approved, suggestions, checked, fieldError, dispatch }: MemoryCardProps) {
  const titleId = useId();
  return (
    <Card labelledBy={titleId}>
      <CardHeader title="Memory records to include" titleId={titleId} />
      <p className="small muted">
        Approved records only. All approved records are included unless you untick them; pinned rules are always included.
      </p>
      <MemoryPicker
        records={approved.data}
        error={approved.error}
        onRetry={approved.refetch}
        checked={checked}
        fieldError={fieldError}
        suggestions={suggestions}
        onToggle={(id, on) => {
          dispatch({
            type: 'toggle-memory',
            id,
            checked: on,
            defaults: (approved.data ?? []).filter((m) => !m.pinned).map((m) => m.id),
          });
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Input summary, providers and Start (the side column)

export interface InputSummaryCardProps {
  readonly preflight: RunPreflight | undefined;
  readonly fetching: boolean;
  readonly systemError: unknown;
  readonly hasDraft: boolean;
  readonly allowance: Parameters<typeof PreflightSummary>[0]['allowance'];
  readonly capBytes: number | undefined;
  readonly onRetry: () => void;
  readonly onErrorAction: (action: NextAction) => void;
}

export function InputSummaryCard({ preflight: pf, fetching, systemError, hasDraft, allowance, capBytes, onRetry, onErrorAction }: InputSummaryCardProps) {
  const titleId = useId();
  return (
    <Card labelledBy={titleId}>
      <CardHeader title="Input summary" titleId={titleId} />
      {systemError === null ? null : (
        <div className="stack">
          <ErrorView error={toViewError(systemError)} onAction={onErrorAction} />
          <div>
            <Button pending={fetching} onClick={onRetry}>
              Retry the check
            </Button>
          </div>
        </div>
      )}
      {pf === undefined ? (
        systemError !== null ? null : !hasDraft ? (
          <p className="small muted">Select the input to see what this run will send and reserve.</p>
        ) : (
          <div aria-busy="true">
            <Skeleton lines={5} />
          </div>
        )
      ) : (
        <div aria-busy={fetching || undefined} className="stack">
          <PreflightSummary preflight={pf} allowance={allowance} capBytes={capBytes} />
          <p className="small muted">
            Reservation = estimated input + configured max output for the first model call. Tracked by Relay; your
            provider bill may differ.
          </p>
        </div>
      )}
    </Card>
  );
}

export function ProvidersCard({ preflight: pf, systemError }: { readonly preflight: RunPreflight | undefined; readonly systemError: unknown }) {
  const titleId = useId();
  return (
    <Card labelledBy={titleId}>
      <CardHeader title="Providers that will receive this context" titleId={titleId} level={2} />
      {pf === undefined || systemError !== null ? (
        <p className="small muted">Shown after the check completes.</p>
      ) : (
        <ProvidersReceiving
          preflight={pf}
          footnote="Selected context leaves this computer only through these calls, and only to providers this project allows."
        />
      )}
    </Card>
  );
}

export interface StartPanelProps {
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly problemCount: number;
  readonly otherError: unknown;
  readonly onErrorAction: (action: NextAction) => void;
}

export function StartPanel({ pending, disabled, disabledReason, problemCount, otherError, onErrorAction }: StartPanelProps) {
  return (
    <div className="stack">
      <Button type="submit" variant="primary" icon={Play} pending={pending} disabled={disabled} aria-describedby="new-run-start-note">
        Start run
      </Button>
      <p id="new-run-start-note" className="small subtle">
        {disabledReason ??
          (problemCount > 0
            ? `Fix ${String(problemCount)} problem${problemCount === 1 ? '' : 's'} to start.`
            : 'Relay pauses for your approval before drafting a patch.')}
      </p>
      {otherError === null ? null : <ErrorView live="assertive" error={toViewError(otherError)} onAction={onErrorAction} />}
    </div>
  );
}
