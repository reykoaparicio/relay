import { useId, useState } from 'react';
import { ROLES } from '@relay/contracts';
import type { MemoryRecordDetail, MemoryRecordScope, Role } from '@relay/contracts';
import { Button, Checkbox, Field, InlineAlert, TextInput, Textarea } from '../../components/ui';
import { isAppErrorException } from '../../api/client';
import { validationIssuesOf } from '../../api/errors';
import { MEMORY_TYPE_LABELS } from '../../lib/format';
import { ErrorSummary } from '../common/ErrorSummary';
import type { FormProblem } from '../common/ErrorSummary';
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
}

const TITLE_MAX = 120;
const CONTENT_MAX = 4000;

function sameScope(a: MemoryRecordScope, b: MemoryRecordScope): boolean {
  return scopeText(a) === scopeText(b);
}

function isConflict(e: unknown): boolean {
  return isAppErrorException(e) && e.appError.code === 'CONFLICT';
}

/**
 * Edit form of a memory record (memory `edit` state). The record's current revision is the expected revision; if
 * the record changed elsewhere the runner answers CONFLICT, and the form shows the saved text next to the user's
 * edit instead of overwriting it.
 */
export function MemoryEditForm({ record, mode, pending, error, onSubmit, onCancel }: MemoryEditFormProps) {
  const formId = useId();
  const [title, setTitle] = useState(record.title);
  const [content, setContent] = useState(record.content);
  const [roles, setRoles] = useState<ReadonlySet<Role>>(() => rolesOfScope(record.scope));
  const [review, setReview] = useState(dateInputValue(record.reviewAt));
  const [expires, setExpires] = useState(dateInputValue(record.expiresAt));
  const [submitted, setSubmitted] = useState(false);
  /** The revision this edit is based on: the opened record, or the latest one the user chose to save over. */
  const [baseRevision, setBaseRevision] = useState(record.currentRevision);
  const conflict = isConflict(error) && record.currentRevision !== baseRevision;
  const conflictPending = isConflict(error) && record.currentRevision === baseRevision;

  const scope = scopeFromRoles(roles);
  const reviewAt = parseDateInput(review);
  const expiresAt = parseDateInput(expires);
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
  const nextRevision = baseRevision + 1;
  const isEdit = mode === 'edit';

  const submit = (expectedRevision: number) => {
    setSubmitted(true);
    if (Object.keys(local).length > 0 || scope === null || reviewAt === undefined || expiresAt === undefined) return;
    setBaseRevision(expectedRevision);
    onSubmit({
      expectedRevision,
      ...(title === record.title ? {} : { title }),
      ...(content === record.content ? {} : { content }),
      ...(sameScope(scope, record.scope) ? {} : { scope }),
      ...(isEdit && reviewAt !== record.reviewAt ? { reviewAt } : {}),
      ...(isEdit && expiresAt !== record.expiresAt ? { expiresAt } : {}),
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
        submit(baseRevision);
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
          <p>Relay did not overwrite it. The saved text is:</p>
          <blockquote className="prewrap" style={{ margin: 0 }}>
            {record.content}
          </blockquote>
          <p>Your edit is still in the form above.</p>
          <div className="actions">
            <Button
              variant="primary"
              pending={pending}
              onClick={() => {
                submit(record.currentRevision);
              }}
            >
              Keep my edit and save over revision {String(record.currentRevision)}
            </Button>
          </div>
        </InlineAlert>
      ) : conflictPending ? (
        <InlineAlert tone="warning" title="This record changed since you opened it">
          <p>Loading the saved version…</p>
        </InlineAlert>
      ) : error !== null && error !== undefined && Object.keys(server).length === 0 ? (
        <MutationError error={error} unavailableHint="Your text is still in the form; nothing was saved." />
      ) : null}
      {isEdit ? (
        <InlineAlert tone="info" title={`Saving creates revision ${String(nextRevision)}; runs that already used revision ${String(baseRevision)} keep it.`}>
          <p className="subtle">
            Expected revision: <span className="num">{String(baseRevision)}</span>. If the record changed elsewhere
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
