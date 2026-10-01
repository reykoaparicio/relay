import { useId, useState } from 'react';
import type { RefObject } from 'react';
import { ROLES } from '@relay/contracts';
import type { MemoryRecordView, Role } from '@relay/contracts';
import { Button, ConflictCompare, Field, InlineAlert, Select, Skeleton, TextInput, Textarea } from '../../components/ui';
import type { ConflictResolution } from '../../components/ui';
import { validationIssuesOf } from '../../api/errors';
import { useMemoryRecord } from '../../hooks/useMemoryRecord';
import { MutationError } from '../common/MutationError';
import { ROLE_LABELS } from '../run-setup/model-steps';
import { MEMORY_FIELD, SCOPE_CHOICES, scopeFromChoice } from './memory-model';
import type { ScopeChoice } from './memory-model';
import { useResolveConflict } from './useMemoryMutations';

export interface ConflictResolverProps {
  readonly projectId: string;
  /** Record A. When one record is a suggestion it is A: `recordIds` is `[suggestionId, approvedId]` (02). */
  readonly a: MemoryRecordView;
  readonly b: MemoryRecordView;
  /**
   * "Combine with existing…" from a suggestion: the approved records the user may combine with. A select picks B;
   * the change is reported through `onChangeB`.
   */
  readonly candidates?: readonly MemoryRecordView[];
  readonly onChangeB?: (id: string) => void;
  readonly headingRef?: RefObject<HTMLHeadingElement | null>;
  readonly onResolved: () => void;
  readonly onCancel: () => void;
}

const ROLE_CHOICES = ROLES.map((r) => ({ value: r, label: `${ROLE_LABELS[r]} only` }));

/**
 * Memory `conflict` state (§5.5): both texts side by side (`ConflictCompare`) with four choices. Relay never merges
 * silently: Combine asks for the rewritten text, and "keep both" asks for two scopes that do not share a role.
 */
export function ConflictResolver({ projectId, a, b, candidates, onChangeB, headingRef, onResolved, onCancel }: ConflictResolverProps) {
  const headingId = useId();
  const pickId = useId();
  const aDetail = useMemoryRecord(a.id);
  const bDetail = useMemoryRecord(b.id);
  const resolve = useResolveConflict(projectId, onResolved);
  const [choice, setChoice] = useState<ConflictResolution | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [scope, setScope] = useState<ScopeChoice>('all');
  const [scopeA, setScopeA] = useState<Role>('reviewer');
  const [scopeB, setScopeB] = useState<Role>('implementer');
  const [submitted, setSubmitted] = useState(false);
  const fromSuggestion = a.status === 'suggested' || b.status === 'suggested';
  const recordIds = [a.id, b.id] as [string, string];

  // The rewrite starts from both texts; the user edits it into one instruction (nothing is merged automatically).
  const approvedTitle = (b.status === 'approved' ? b : a).title;
  const rewriteTitle = title ?? approvedTitle;
  const rewriteContent =
    content ?? [aDetail.data?.content ?? a.excerpt, bDetail.data?.content ?? b.excerpt].join('\n\n');
  const titleError = submitted && rewriteTitle.trim() === '' ? 'Enter a title.' : undefined;
  const contentError = submitted && rewriteContent.trim() === '' ? 'Enter the combined text.' : undefined;
  const scopesError = scopeA === scopeB ? 'The two records must not apply to the same role.' : undefined;
  const server = validationIssuesOf(resolve.error);

  const apply = (resolution: ConflictResolution) => {
    switch (resolution) {
      case 'keep_a':
        resolve.mutate({ recordIds, resolution: { keep: a.id } });
        return;
      case 'keep_b':
        resolve.mutate({ recordIds, resolution: { keep: b.id } });
        return;
      case 'combine':
        setSubmitted(true);
        if (rewriteTitle.trim() === '' || rewriteContent.trim() === '') return;
        resolve.mutate({
          recordIds,
          resolution: { rewrite: { title: rewriteTitle.trim(), content: rewriteContent.trim(), scope: scopeFromChoice(scope) } },
        });
        return;
      case 'keep_both_scoped':
        if (scopesError !== undefined) return;
        resolve.mutate({
          recordIds,
          resolution: {
            keepBothWithScopes: [
              { recordId: a.id, scope: { roles: [scopeA] } },
              { recordId: b.id, scope: { roles: [scopeB] } },
            ],
          },
        });
        return;
    }
  };

  return (
    <section className="card stack" aria-labelledby={headingId}>
      <h2 id={headingId} ref={headingRef} tabIndex={-1}>
        {candidates === undefined ? 'Resolve conflict' : `Combine “${a.title}” with an approved record`}
      </h2>
      <InlineAlert tone="warning" title={fromSuggestion ? 'A suggestion overlaps an approved record' : 'Two approved records give incompatible instructions'}>
        <p>
          Relay never combines instructions silently. Neither record changes until you choose
          {fromSuggestion ? '; the suggestion stays excluded from runs' : '. Until then, each run context manifest flags the conflict'}.
        </p>
      </InlineAlert>
      {candidates === undefined || onChangeB === undefined ? null : (
        <Field label="Approved record to combine with" id={pickId}>
          {(control) => (
            <Select
              {...control}
              value={b.id}
              onValueChange={onChangeB}
              options={candidates.map((c) => ({ value: c.id, label: c.title }))}
              style={{ maxWidth: 420 }}
            />
          )}
        </Field>
      )}
      {aDetail.isPending || bDetail.isPending ? (
        <Skeleton lines={4} />
      ) : (
        <ConflictCompare
          key={`${a.id}|${b.id}`}
          a={{ ...a, ...(aDetail.data === undefined ? {} : { content: aDetail.data.content }) }}
          b={{ ...b, ...(bDetail.data === undefined ? {} : { content: bDetail.data.content }) }}
          pending={resolve.isPending && (choice === 'keep_a' || choice === 'keep_b')}
          onResolve={(r) => {
            setChoice(r);
            setSubmitted(false);
            if (r === 'keep_a' || r === 'keep_b') apply(r);
          }}
        />
      )}
      {choice === 'combine' ? (
        <form
          className="stack"
          aria-label="Combined record"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            apply('combine');
          }}
        >
          <p className="small muted">
            Write the combined record. It becomes a new approved record; {fromSuggestion ? 'the approved record is archived as superseded and the suggestion is rejected' : 'A and B are archived as superseded'}.
          </p>
          <Field label="Title" id={MEMORY_FIELD.title} error={titleError ?? server.find((i) => i.path.includes('title'))?.message} required>
            {(control) => <TextInput {...control} value={rewriteTitle} onValueChange={setTitle} />}
          </Field>
          <Field
            label="Rewritten text"
            id={MEMORY_FIELD.content}
            hint="No secrets or provider credentials belong in memory."
            error={contentError ?? server.find((i) => i.path.includes('content'))?.message}
            required
          >
            {(control) => <Textarea {...control} value={rewriteContent} onValueChange={setContent} rows={5} />}
          </Field>
          <Field label="Scope" id={MEMORY_FIELD.roles}>
            {(control) => (
              <Select
                {...control}
                value={scope}
                onValueChange={(v) => {
                  setScope(v as ScopeChoice);
                }}
                options={SCOPE_CHOICES}
                style={{ maxWidth: 340 }}
              />
            )}
          </Field>
          <div className="actions">
            <Button type="submit" variant="primary" pending={resolve.isPending}>
              Apply resolution
            </Button>
          </div>
        </form>
      ) : null}
      {choice === 'keep_both_scoped' ? (
        <form
          className="stack"
          aria-label="Separate scopes"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            apply('keep_both_scoped');
          }}
        >
          <p className="small muted">Each record applies to a different role, so the two never meet in one request.</p>
          <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
            <Field label={`Scope for A: ${a.title}`}>
              {(control) => (
                <Select
                  {...control}
                  value={scopeA}
                  onValueChange={(v) => {
                    setScopeA(v as Role);
                  }}
                  options={ROLE_CHOICES}
                />
              )}
            </Field>
            <Field label={`Scope for B: ${b.title}`} error={scopesError}>
              {(control) => (
                <Select
                  {...control}
                  value={scopeB}
                  onValueChange={(v) => {
                    setScopeB(v as Role);
                  }}
                  options={ROLE_CHOICES}
                />
              )}
            </Field>
          </div>
          <div className="actions">
            <Button type="submit" variant="primary" pending={resolve.isPending} disabled={scopesError !== undefined}>
              Apply resolution
            </Button>
          </div>
        </form>
      ) : null}
      {server.length > 0 && choice !== 'combine' ? (
        <InlineAlert tone="danger" title="Relay could not apply this resolution">
          <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
            {server.map((i) => (
              <li key={`${i.path}:${i.message}`}>{i.message}</li>
            ))}
          </ul>
        </InlineAlert>
      ) : server.length === 0 ? (
        <MutationError error={resolve.error} unavailableHint="Both records are unchanged." />
      ) : null}
      <div className="actions">
        <Button variant="ghost" onClick={onCancel} disabled={resolve.isPending}>
          Decide later
        </Button>
      </div>
    </section>
  );
}
