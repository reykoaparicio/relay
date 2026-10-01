import { useId, useState } from 'react';
import { Checkbox, Dialog, DialogFooter, Field, Select, TextInput, Textarea } from '../../components/ui';
import { validationIssuesOf } from '../../api/errors';
import { MEMORY_TYPE_LABELS } from '../../lib/format';
import { MutationError } from '../common/MutationError';
import { MEMORY_FIELD, memoryFieldOfPath, parseDateInput, SCOPE_CHOICES, scopeFromChoice } from './memory-model';
import type { ScopeChoice } from './memory-model';
import { useCreateMemory } from './useMemoryMutations';

type CreatableType = 'user_rule' | 'project_decision' | 'source_reference';

const TYPE_OPTIONS: ReadonlyArray<{ readonly value: CreatableType; readonly label: string }> = [
  { value: 'user_rule', label: MEMORY_TYPE_LABELS.user_rule },
  { value: 'project_decision', label: MEMORY_TYPE_LABELS.project_decision },
  { value: 'source_reference', label: MEMORY_TYPE_LABELS.source_reference },
];

const SOURCE_FIELD = 'memory-field-source';

export interface AddRuleDialogProps {
  readonly projectId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (recordId: string) => void;
}

/** "Add project rule" (`memory.create`): user-authored records are approved immediately (§10.1). */
export function AddRuleDialog({ projectId, open, onOpenChange, onCreated }: AddRuleDialogProps) {
  const formId = useId();
  const [type, setType] = useState<CreatableType>('user_rule');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [scope, setScope] = useState<ScopeChoice>('all');
  const [pinned, setPinned] = useState(false);
  const [review, setReview] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const create = useCreateMemory(projectId, (id) => {
    onOpenChange(false);
    onCreated(id);
  });

  const reviewAt = parseDateInput(review);
  const local: Record<string, string> = {};
  if (title.trim() === '') local[MEMORY_FIELD.title] = 'Enter a short title.';
  if (content.trim() === '') local[MEMORY_FIELD.content] = 'Enter the rule or decision.';
  if (reviewAt === undefined) local[MEMORY_FIELD.reviewAt] = 'Enter a date like 2026-12-31, or leave it empty.';
  if (type === 'source_reference' && sourcePath.trim() === '') local[SOURCE_FIELD] = 'Enter the project-relative path of the file.';
  const server: Record<string, string> = {};
  for (const issue of validationIssuesOf(create.error)) {
    const field = issue.path.startsWith('sourceFile') ? SOURCE_FIELD : memoryFieldOfPath(issue.path);
    if (field !== null) server[field] ??= issue.message;
  }
  const errorOf = (id: string) => (submitted ? local[id] : undefined) ?? server[id];
  const unmappedError = create.error !== null && Object.keys(server).length === 0 ? create.error : null;

  const reset = () => {
    setType('user_rule');
    setTitle('');
    setContent('');
    setScope('all');
    setPinned(false);
    setReview('');
    setSourcePath('');
    setSubmitted(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Add project rule"
      description="Rules you add are approved immediately and included in future runs within their scope."
      footer={<DialogFooter primaryLabel="Add rule" formId={formId} pending={create.isPending} />}
    >
      <form
        id={formId}
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (Object.keys(local).length > 0 || reviewAt === undefined) return;
          create.mutate({
            projectId,
            type,
            title: title.trim(),
            content: content.trim(),
            scope: scopeFromChoice(scope),
            ...(pinned ? { pinned: true } : {}),
            ...(reviewAt === null ? {} : { reviewAt }),
            ...(type === 'source_reference' ? { sourceFile: { relPath: sourcePath.trim() } } : {}),
          });
        }}
      >
        <Field label="Type">
          {(control) => (
            <Select
              {...control}
              value={type}
              onValueChange={(v) => {
                setType(v as CreatableType);
              }}
              options={TYPE_OPTIONS}
            />
          )}
        </Field>
        <Field label="Title" id={MEMORY_FIELD.title} error={errorOf(MEMORY_FIELD.title)} required>
          {(control) => (
            <TextInput {...control} value={title} onValueChange={setTitle} placeholder="Response format" maxLength={120} />
          )}
        </Field>
        <Field
          label="Rule"
          id={MEMORY_FIELD.content}
          hint="Plain instructions or facts. No secrets or provider credentials belong in memory."
          error={errorOf(MEMORY_FIELD.content)}
          required
        >
          {(control) => (
            <Textarea
              {...control}
              value={content}
              onValueChange={setContent}
              rows={4}
              placeholder="Preserve the existing public response format"
            />
          )}
        </Field>
        {type === 'source_reference' ? (
          <Field
            label="Source file"
            id={SOURCE_FIELD}
            hint="A file inside the project, for example docs/architecture.md. Relay records its hash to notice changes."
            error={errorOf(SOURCE_FIELD)}
            required
          >
            {(control) => <TextInput {...control} mono value={sourcePath} onValueChange={setSourcePath} />}
          </Field>
        ) : null}
        <Field label="Scope">
          {(control) => (
            <Select
              {...control}
              value={scope}
              onValueChange={(v) => {
                setScope(v as ScopeChoice);
              }}
              options={SCOPE_CHOICES}
            />
          )}
        </Field>
        <Field
          label="Review date (optional)"
          id={MEMORY_FIELD.reviewAt}
          hint="Relay asks you to confirm the rule is still accurate on this date."
          error={errorOf(MEMORY_FIELD.reviewAt)}
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
        <Checkbox label="Pin: always include this rule in runs within its scope" checked={pinned} onCheckedChange={setPinned} />
        {unmappedError === null ? null : (
          <MutationError error={unmappedError} unavailableHint="Nothing was saved. You can add rules once memory is available." />
        )}
      </form>
    </Dialog>
  );
}
