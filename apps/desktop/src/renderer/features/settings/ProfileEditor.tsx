import { EFFORT_LEVELS, MAX_OUTPUT_TOKENS_CEILING } from '@relay/contracts';
import type { CatalogModel, Effort, ModelProfile, ProviderId } from '@relay/contracts';
import { Button, Field, InlineAlert, NumberInput, Select, TextInput } from '../../components/ui';
import { validationIssuesOf } from '../../api/errors';
import { PROVIDER_LABELS } from '../../lib/format';
import type { ProfileUse } from '../../hooks/useWorkflow';
import { MutationError } from '../common/MutationError';
import { conflictReason } from '../common/conflict';
import type { ConflictNames } from '../common/conflict';
import { UsageList } from './ProfileLists';

/** The profile form's values (text for the token count) and the revision it edits. */
export interface Draft {
  readonly id: ModelProfile['id'] | null;
  readonly expectedRevision: number | null;
  readonly name: string;
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly maxOutputTokens: string;
  readonly effort: Effort | '';
  readonly base: ModelProfile | null;
}

/** The draft of a saved profile (its revision is the expected one). */
export function draftOf(p: ModelProfile): Draft {
  return {
    id: p.id,
    expectedRevision: p.revision,
    name: p.name,
    providerId: p.providerId,
    modelId: p.modelId,
    maxOutputTokens: String(p.params.maxOutputTokens),
    effort: p.params.effort ?? '',
    base: p,
  };
}

/** A new profile on the first catalog model. */
export function newDraft(catalog: readonly CatalogModel[]): Draft {
  const first = catalog[0];
  return {
    id: null,
    expectedRevision: null,
    name: '',
    providerId: first?.providerId ?? 'anthropic',
    modelId: first?.modelId ?? '',
    maxOutputTokens: '8000',
    effort: '',
    base: null,
  };
}

/** The saved params minus `effort` (the form sets it, or leaves it out for the provider default). */
export function paramsWithoutEffort(base: ModelProfile | null): Omit<ModelProfile['params'], 'effort' | 'maxOutputTokens'> {
  if (base === null) return { refusalFallback: 'off' };
  const { refusalFallback, maxInputTokens } = base.params;
  return { refusalFallback, ...(maxInputTokens === undefined ? {} : { maxInputTokens }) };
}

const FIELD = {
  name: 'profile-field-name',
  model: 'profile-field-model',
  tokens: 'profile-field-max-output',
} as const;

/** Client checks of a draft (field id → message); the engine still validates on save. */
export function profileDraftErrors(draft: Draft, model: CatalogModel | undefined): Readonly<Record<string, string>> {
  const local: Record<string, string> = {};
  if (draft.name.trim() === '') local[FIELD.name] = 'Enter a profile name, for example Balanced.';
  else if (draft.name.trim().length > 40) local[FIELD.name] = 'Use at most 40 characters.';
  if (draft.modelId === '') local[FIELD.model] = 'Choose a model.';
  const tokens = /^\d+$/.test(draft.maxOutputTokens.trim()) ? Number.parseInt(draft.maxOutputTokens, 10) : NaN;
  const ceiling = model?.capabilities.maxOutputTokens ?? MAX_OUTPUT_TOKENS_CEILING;
  if (Number.isNaN(tokens) || tokens < 1) local[FIELD.tokens] = 'Enter a whole number of tokens.';
  else if (tokens > ceiling) local[FIELD.tokens] = `This model supports at most ${ceiling.toLocaleString()} output tokens.`;
  return local;
}

export interface ProfileEditorProps {
  readonly draft: Draft;
  readonly onChange: (draft: Draft) => void;
  readonly models: readonly CatalogModel[];
  /** Client errors, shown after the first submit. */
  readonly errors: Readonly<Record<string, string>>;
  readonly submitted: boolean;
  readonly pending: boolean;
  /** The `profiles.upsert` error. */
  readonly error: unknown;
  /** The old name while renaming (null otherwise), and the workflows that name it. */
  readonly renamedFrom: string | null;
  readonly renameUsage: readonly ProfileUse[] | null;
  readonly conflictNames: ConflictNames;
  readonly projectId: string | undefined;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  /** Reload of a stale CONFLICT (re-bases the draft on the saved revision). */
  readonly onReload: () => void;
}

/** Create / edit form of a model profile (`profiles.upsert` with the expected revision). */
export function ProfileEditor({
  draft,
  onChange,
  models,
  errors,
  submitted,
  pending,
  error,
  renamedFrom,
  renameUsage,
  conflictNames,
  projectId,
  onSubmit,
  onCancel,
  onReload,
}: ProfileEditorProps) {
  const providers = [...new Set(models.map((m) => m.providerId))];
  const providerModels = models.filter((m) => m.providerId === draft.providerId);
  const model = models.find((m) => m.providerId === draft.providerId && m.modelId === draft.modelId);
  const serverIssues = validationIssuesOf(error);
  const errorOf = (id: string) => (submitted ? errors[id] : undefined);
  return (
  <form
    className="card stack"
    aria-label={draft.id === null ? 'New profile' : `Edit ${draft.base?.name ?? 'profile'}`}
    noValidate
    onSubmit={(e) => {
      e.preventDefault();
      onSubmit();
    }}
  >
    <h3>{draft.id === null ? 'New profile' : `Edit ${draft.base?.name ?? 'profile'}`}</h3>
    <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
      <Field label="Name" id={FIELD.name} error={errorOf(FIELD.name)} required>
        {(control) => (
          <TextInput
            {...control}
            value={draft.name}
            onValueChange={(name) => {
              onChange({ ...draft, name });
            }}
          />
        )}
      </Field>
      <Field label="Provider">
        {(control) => (
          <Select
            {...control}
            value={draft.providerId}
            options={providers.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))}
            onValueChange={(v) => {
              const providerId = providers.find((p) => p === v);
              if (providerId === undefined) return;
              onChange({ ...draft, providerId, modelId: models.find((m) => m.providerId === providerId)?.modelId ?? '', effort: '' });
            }}
          />
        )}
      </Field>
      <Field label="Model" id={FIELD.model} error={errorOf(FIELD.model)} required>
        {(control) => (
          <Select
            {...control}
            value={draft.modelId}
            options={[
              ...(providerModels.some((m) => m.modelId === draft.modelId) || draft.modelId === ''
                ? []
                : [{ value: draft.modelId, label: `${draft.modelId} (not in the catalog)` }]),
              ...providerModels.map((m) => ({ value: m.modelId, label: `${m.displayName} (${m.modelId})` })),
            ]}
            onValueChange={(modelId) => {
              onChange({ ...draft, modelId, effort: '' });
            }}
          />
        )}
      </Field>
      <Field
        label="Default max output tokens"
        id={FIELD.tokens}
        hint={model?.capabilities.maxOutputTokens === undefined ? undefined : `This model supports up to ${model.capabilities.maxOutputTokens.toLocaleString()}.`}
        error={errorOf(FIELD.tokens)}
        required
      >
        {(control) => (
          <NumberInput
            {...control}
            value={draft.maxOutputTokens}
            min={1}
            max={model?.capabilities.maxOutputTokens ?? MAX_OUTPUT_TOKENS_CEILING}
            onValueChange={(text) => {
              onChange({ ...draft, maxOutputTokens: text });
            }}
          />
        )}
      </Field>
      <Field label="Reasoning effort" hint="Only levels the model supports are listed.">
        {(control) => (
          <Select
            {...control}
            value={draft.effort}
            options={[
              { value: '', label: 'Provider default' },
              ...EFFORT_LEVELS.filter((l) => model?.capabilities.effortLevels.includes(l) ?? false).map((l) => ({ value: l, label: l })),
            ]}
            onValueChange={(v) => {
              onChange({ ...draft, effort: EFFORT_LEVELS.find((l) => l === v) ?? '' });
            }}
          />
        )}
      </Field>
    </div>
    {serverIssues.length > 0 ? (
      <InlineAlert tone="danger" live="assertive" title="Relay could not save this profile">
        <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
          {serverIssues.map((i) => (
            <li key={`${i.path}:${i.message}`}>{i.message}</li>
          ))}
        </ul>
      </InlineAlert>
    ) : (
      <MutationError error={error} handlers={{ reload: onReload }} names={conflictNames} projectId={projectId} />
    )}
    {renamedFrom !== null && renameUsage !== null && renameUsage.length > 0 && conflictReason(error) !== 'profile_in_use' ? (
      <InlineAlert tone="warning" title={`Relay will refuse to rename “${renamedFrom}” while workflows use it`}>
        <p>These workflows name the profile; choose another profile in their steps first, or keep the name:</p>
        <UsageList usage={renameUsage} projectId={projectId} />
      </InlineAlert>
    ) : null}
    <div className="actions">
      <Button type="submit" variant="primary" pending={pending}>
        {draft.id === null ? 'Create profile' : `Save revision ${String((draft.expectedRevision ?? 0) + 1)}`}
      </Button>
      <Button disabled={pending} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  </form>
  );
}
