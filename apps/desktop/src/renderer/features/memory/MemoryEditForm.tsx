import { useId, useState } from 'react';
import { ROLES } from '@relay/contracts';
import type { MemoryRecordDetail, MemoryRecordScope, Role } from '@relay/contracts';
import { Button, Checkbox, Field, InlineAlert, TextInput, Textarea } from '../../components/ui';
import { validationIssuesOf } from '../../api/errors';
import { MEMORY_TYPE_LABELS } from '../../lib/format';
import { ErrorSummary } from '../common/ErrorSummary';
import type { FormProblem } from '../common/ErrorSummary';
import { conflictCopy } from '../common/conflict';
import { MutationError } from '../common/MutationError';
import { ROLE_LABELS } from '../run-setup/model-steps';
import {
  dateInputValue,
  MEMORY_FIELD,
  memoryFieldOfPath,
  parseDateInput,
  rolesOfScope,
  scopeFromRoles,
  scopeText,
} from './memory-model';

const FIELD_LABELS: Readonly<Record<'title' | 'content' | 'scope' | 'review' | 'expires', string>> = {
  title: 'Title',
  content: 'Content',
  scope: 'Scope',
  review: 'Review date',
  expires: 'Expiry date',
};


/** What the form submits: only the fields the user changed, plus the revision it was based on. */
export interface MemoryEditResult {
  readonly expectedRevision: number;
  readonly title?: string;
  readonly content?: string;
  readonly scope?: MemoryRecordScope;
  readonly reviewAt?: number | null;
  readonly expiresAt?: number | null;
}

export interface MemoryEditFormProps {
  readonly record: MemoryRecordDetail;
  /** `edit`: save a new revision of an approved record. `approve`: "Edit then approve" a suggestion. */
  readonly mode: 'edit' | 'approve';
  readonly pending: boolean;
  readonly error: unknown;
  readonly onSubmit: (result: MemoryEditResult) => void;
  readonly onCancel: () => void;
  /** Refetches the record this form edits (the "Reload" of a stale CONFLICT). */
  readonly onReload?: () => void;
  /** Titles of other records (by id), for a memory conflict. */
  readonly titleOf?: (id: string) => string | undefined;
  /** Opens Combine / Resolve with the approved record this edit conflicts with (`details.conflictsWith`). */
  readonly onOpenConflict?: (otherId: string) => void;
}

const TITLE_MAX = 120;
const CONTENT_MAX = 4000;

function sameScope(a: MemoryRecordScope, b: MemoryRecordScope): boolean {
  return scopeText(a) === scopeText(b);
}

/** The editable fields of a record, as compared field by field after a revision CONFLICT. */
interface EditValues {
  readonly title: string;
  readonly content: string;
  readonly scope: MemoryRecordScope | null;
  /** Date input text ('' = none). */
  readonly review: string;
  readonly expires: string;
}

function valuesOf(r: MemoryRecordDetail): EditValues {
  return {
    title: r.title,
    content: r.content,
    scope: r.scope,
    review: dateInputValue(r.reviewAt),
    expires: dateInputValue(r.expiresAt),
  };
}

type EditField = keyof EditValues;

function fieldText(field: EditField, v: EditValues): string {
  if (field === 'scope') return v.scope === null ? 'No role' : scopeText(v.scope);
  if (field === 'review' || field === 'expires') return v[field] === '' ? 'None' : v[field];
  return v[field];
}

function sameField(field: EditField, a: EditValues, b: EditValues): boolean {
  if (field === 'scope') return a.scope !== null && b.scope !== null ? sameScope(a.scope, b.scope) : a.scope === b.scope;
  return a[field] === b[field];
}

/**
 * Edit form of a memory record (memory `edit` state). The record the user opened is the *base*: the form sends only
 * the fields the user changed against it, with the revision it was based on as the expected revision. If the record
 * changed elsewhere the runner answers CONFLICT, and the form compares the saved revision with the user's edit field by
 * field; "save over" still sends only the user's own changes, so fields the user did not touch keep the saved values.
 */
export function MemoryEditForm({ record, mode, pending, error, onSubmit, onCancel, onReload, titleOf, onOpenConflict }: MemoryEditFormProps) {
  const formId = useId();
  /** The record as the user opened it: "my changes" are always computed against this, never against a newer save. */
  const [base] = useState(record);
  const [title, setTitle] = useState(record.title);
  const [content, setContent] = useState(record.content);
  const [roles, setRoles] = useState<ReadonlySet<Role>>(() => rolesOfScope(record.scope));
  const [review, setReview] = useState(dateInputValue(record.reviewAt));
  const [expires, setExpires] = useState(dateInputValue(record.expiresAt));
  const [submitted, setSubmitted] = useState(false);
  /** The revision the next save expects: the opened record, or the latest one the user chose to save over. */
  const [expectedRevision, setExpectedRevision] = useState(record.currentRevision);
  const isEdit = mode === 'edit';
  const copy = conflictCopy(error, { ...(titleOf === undefined ? {} : { recordTitle: titleOf }) });
  const stale = copy !== null && copy.stale;
  /** The saved version is newer than the one this edit expects: compare field by field. */
  const conflict = stale && record.currentRevision !== expectedRevision;
  /** The CONFLICT names a newer revision that has not loaded yet. */
  const conflictPending =
    stale && !conflict && copy.currentRevision !== null && copy.currentRevision > record.currentRevision;

  const scope = scopeFromRoles(roles);
  const reviewAt = parseDateInput(review);
  const expiresAt = parseDateInput(expires);
  const mine: EditValues = { title, content, scope, review, expires };
  const baseValues = valuesOf(base);
  const savedValues = valuesOf(record);
  const fields: readonly EditField[] = isEdit ? ['title', 'content', 'scope', 'review', 'expires'] : ['title', 'content', 'scope'];
  const changedByMe = fields.filter((f) => !sameField(f, mine, baseValues));
  const changedElsewhere = fields.filter((f) => !sameField(f, savedValues, baseValues));
  const local: Record<string, string> = {};
  if (title.trim() === '') local[MEMORY_FIELD.title] = 'Enter a title.';
  else if (title.length > TITLE_MAX) local[MEMORY_FIELD.title] = `Use at most ${String(TITLE_MAX)} characters.`;
  if (content.trim() === '') local[MEMORY_FIELD.content] = 'Enter the instruction or fact.';
  else if (content.length > CONTENT_MAX) {
    local[MEMORY_FIELD.content] = `Use at most ${String(CONTENT_MAX)} characters. Longer knowledge belongs in a source reference.`;
  }
  if (scope === null) local[MEMORY_FIELD.roles] = 'Choose at least one role.';
  if (reviewAt === undefined) local[MEMORY_FIELD.reviewAt] = 'Enter a date like 2026-12-31, or leave it empty.';
  if (expiresAt === undefined) local[MEMORY_FIELD.expiresAt] = 'Enter a date like 2026-12-31, or leave it empty.';
  const server: Record<string, string> = {};
  for (const issue of validationIssuesOf(error)) {
    const field = memoryFieldOfPath(issue.path);
    if (field !== null) server[field] ??= issue.message;
  }
  const fieldError = (id: string) => (submitted ? local[id] : undefined) ?? server[id];
  const problems: FormProblem[] = submitted
    ? Object.entries(local).map(([fieldId, message]) => ({ fieldId, message }))
    : [];
  const nextRevision = expectedRevision + 1;

  const submit = (revision: number) => {
    setSubmitted(true);
    if (Object.keys(local).length > 0 || scope === null || reviewAt === undefined || expiresAt === undefined) return;
    setExpectedRevision(revision);
    const changed = (f: EditField) => changedByMe.includes(f);
    onSubmit({
      expectedRevision: revision,
      ...(changed('title') ? { title } : {}),
      ...(changed('content') ? { content } : {}),
      ...(changed('scope') ? { scope } : {}),
      ...(isEdit && changed('review') ? { reviewAt } : {}),
      ...(isEdit && changed('expires') ? { expiresAt } : {}),
    });
  };

  const toggleRole = (role: Role, on: boolean) => {
    const next = new Set(roles);
    if (on) next.add(role);
    else next.delete(role);
    setRoles(next);
  };

  return (
    <form
      id={formId}
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit(expectedRevision);
      }}
    >
      <ErrorSummary
        problems={problems}
        focusOnMount
        title={(n) => `${String(n)} ${n === 1 ? 'problem prevents' : 'problems prevent'} saving this record`}
      />
      <Field label="Title" id={MEMORY_FIELD.title} error={fieldError(MEMORY_FIELD.title)} required>
        {(control) => <TextInput {...control} value={title} onValueChange={setTitle} maxLength={TITLE_MAX + 20} />}
      </Field>
      <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
        <div className="field">
          <span className="label">Type</span>
          <span>{MEMORY_TYPE_LABELS[record.type]}</span>
          <span className="hint">The type is fixed once a record exists.</span>
        </div>
        {isEdit ? (
          <Field
            label="Review date (optional)"
            id={MEMORY_FIELD.reviewAt}
            hint="Relay asks you to confirm the record is still accurate on this date."
            error={fieldError(MEMORY_FIELD.reviewAt)}
          >
            {(control) => (
              <input
                {...control}
                className="input mono"
                type="date"
                value={review}
                onChange={(e) => {
                  setReview(e.target.value);
                }}
              />
            )}
          </Field>
        ) : null}
      </div>
      <Field
        label="Content"
        id={MEMORY_FIELD.content}
        hint="Plain instructions or facts. No secrets or provider credentials belong in memory."
        error={fieldError(MEMORY_FIELD.content)}
        required
      >
        {(control) => <Textarea {...control} value={content} onValueChange={setContent} rows={5} />}
      </Field>
      <fieldset className="fieldset field" aria-describedby={fieldError(MEMORY_FIELD.roles) === undefined ? undefined : `${MEMORY_FIELD.roles}-error`}>
        <legend>Roles in scope (this project only)</legend>
        <div className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
          {ROLES.map((r, i) => (
            <Checkbox
              key={r}
              {...(i === 0 ? { id: MEMORY_FIELD.roles } : {})}
              label={ROLE_LABELS[r]}
              checked={roles.has(r)}
              onCheckedChange={(on) => {
                toggleRole(r, on);
              }}
            />
          ))}
        </div>
        {fieldError(MEMORY_FIELD.roles) === undefined ? null : (
          <span className="error" id={`${MEMORY_FIELD.roles}-error`}>
            {fieldError(MEMORY_FIELD.roles)}
          </span>
        )}
      </fieldset>
      {isEdit ? (
        <Field
          label="Expiry date (optional)"
          id={MEMORY_FIELD.expiresAt}
          hint="After this date the record is no longer included in runs."
          error={fieldError(MEMORY_FIELD.expiresAt)}
        >
          {(control) => (
            <input
              {...control}
              className="input mono"
              type="date"
              value={expires}
              onChange={(e) => {
                setExpires(e.target.value);
              }}
            />
          )}
        </Field>
      ) : null}
      {conflict ? (
        <InlineAlert tone="warning" title={`This record changed since you opened it (now revision ${String(record.currentRevision)})`}>
          <p>Relay did not overwrite it. Compare the saved revision with your edit:</p>
          <div className="table-wrap" style={{ overflowX: 'auto' }}>
            <table className="table">
              <caption className="sr-only">Saved revision compared with your edit</caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">{`Saved (revision ${String(record.currentRevision)})`}</th>
                  <th scope="col">Yours</th>
                  <th scope="col">Changed by</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => {
                  const me = changedByMe.includes(f);
                  const them = changedElsewhere.includes(f);
                  return (
                    <tr key={f}>
                      <th scope="row">{FIELD_LABELS[f]}</th>
                      <td className="prewrap">{fieldText(f, savedValues)}</td>
                      <td className="prewrap">{fieldText(f, mine)}</td>
                      <td>{me && them ? 'You and another session' : me ? 'You' : them ? 'Another session' : 'Unchanged'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p>
            {changedByMe.length === 0
              ? 'You have not changed any field.'
              : `Saving over sends only your changes (${changedByMe.map((f) => FIELD_LABELS[f].toLowerCase()).join(', ')}); the other fields keep the saved values.`}
          </p>
          <div className="actions">
            <Button
              variant="primary"
              pending={pending}
              disabled={changedByMe.length === 0}
              onClick={() => {
                submit(record.currentRevision);
              }}
            >
              Keep my changes and save over revision {String(record.currentRevision)}
            </Button>
          </div>
        </InlineAlert>
      ) : conflictPending ? (
        <InlineAlert tone="warning" title="This record changed since you opened it">
          <p>Loading the saved version…</p>
        </InlineAlert>
      ) : copy !== null && (copy.kind === 'memory_conflict' || copy.kind === 'memory_superseded') ? (
        <MutationError
          error={error}
          names={titleOf === undefined ? {} : { recordTitle: titleOf }}
          {...(onOpenConflict === undefined || copy.conflictsWith.length === 0
            ? {}
            : {
                conflictActions: copy.conflictsWith.map((id) => (
                  <Button
                    key={id}
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      onOpenConflict(id);
                    }}
                  >
                    {`${isEdit ? 'Resolve with' : 'Combine with'} “${titleOf?.(id) ?? 'the approved record'}”`}
                  </Button>
                )),
              })}
        />
      ) : error !== null && error !== undefined && Object.keys(server).length === 0 ? (
        <MutationError
          error={error}
          {...(onReload === undefined ? {} : { handlers: { reload: onReload } })}
        />
      ) : null}
      {isEdit ? (
        <InlineAlert tone="info" title={`Saving creates revision ${String(nextRevision)}; runs that already used revision ${String(expectedRevision)} keep it.`}>
          <p className="subtle">
            Expected revision: <span className="num">{String(expectedRevision)}</span>. If the record changed elsewhere
            since you opened it, Relay shows both versions instead of overwriting.
          </p>
        </InlineAlert>
      ) : (
        <p className="small muted">
          Approving creates a durable record that future runs include within its scope. Suggestions are never used by
          runs until approved.
        </p>
      )}
      <div className="actions">
        <Button type="submit" variant="primary" pending={pending} disabled={conflict}>
          {isEdit ? `Save revision ${String(nextRevision)}` : 'Approve edited text'}
        </Button>
        <Button onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
