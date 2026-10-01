import { useId, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Combine, Pencil, X } from 'lucide-react';
import type { MemoryRecordView } from '@relay/contracts';
import { Button, ErrorView, Field, Hash, KeyValueList, Select, Skeleton } from '../../components/ui';
import { toViewError } from '../../api/errors';
import { qk } from '../../api/keys';
import { MEMORY_TYPE_LABELS } from '../../lib/format';
import { useMemoryRecord } from '../../hooks/useMemoryRecord';
import { conflictCopy } from '../common/conflict';
import { MutationError } from '../common/MutationError';
import { runLabel } from '../runs/run-display';
import { paths } from '../shell/paths';
import { MemoryEditForm } from './MemoryEditForm';
import type { MemoryEditResult } from './MemoryEditForm';
import { choiceFromScope, SCOPE_CHOICES, scopeFromChoice } from './memory-model';
import type { ScopeChoice } from './memory-model';
import type { useMemoryMutations } from './useMemoryMutations';

export interface SuggestionCardProps {
  readonly projectId: string;
  readonly suggestion: MemoryRecordView;
  /** Titles of records this suggestion overlaps with (by id), for the overlap note. */
  readonly titleOf: (id: string) => string | undefined;
  readonly mutations: ReturnType<typeof useMemoryMutations>;
  /** Opens Combine with an approved record: the one named (e.g. by a memory_conflict), else the page's best match. */
  readonly onCombine: (suggestionId: string, withId?: string) => void;
}

/**
 * One item of the suggestions queue (memory `suggestions` state): proposed text, why it is reusable, source refs,
 * scope, and Approve / Edit then approve / Combine with existing / Reject.
 */
export function SuggestionCard({ projectId, suggestion, titleOf, mutations, onCombine }: SuggestionCardProps) {
  const headingId = useId();
  const scopeId = useId();
  const detail = useMemoryRecord(suggestion.id);
  const [scope, setScope] = useState<ScopeChoice>(() => choiceFromScope(suggestion.scope));
  const [editing, setEditing] = useState(false);
  const [lastAction, setLastAction] = useState<'approve' | 'edit' | 'reject' | null>(null);
  const queryClient = useQueryClient();
  const { approve, reject } = mutations;
  /** Reload refetches what Approve depends on: the suggestion list (its revision) and the suggestion's detail. */
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: qk.memory(projectId, 'suggested') });
    void detail.refetch();
  };
  const approvePending = approve.isPending && approve.variables.suggestionId === suggestion.id;
  const rejectPending = reject.isPending && reject.variables.suggestionId === suggestion.id;
  const busy = approvePending || rejectPending;
  const record = detail.data;
  const rationale = record?.proposal?.rationale;
  const overlaps = (record?.proposal?.conflictsWith ?? suggestion.conflictsWith)
    .map((id) => titleOf(id))
    .filter((t): t is string => t !== undefined);
  const error =
    lastAction === 'reject'
      ? reject.variables?.suggestionId === suggestion.id
        ? reject.error
        : null
      : approve.variables?.suggestionId === suggestion.id
        ? approve.error
        : null;

  const doApprove = () => {
    setLastAction('approve');
    approve.mutate({
      suggestionId: suggestion.id,
      expectedRevision: suggestion.currentRevision,
      ...(scope === choiceFromScope(suggestion.scope) ? {} : { scope: scopeFromChoice(scope) }),
    });
  };

  const doApproveEdited = (r: MemoryEditResult) => {
    setLastAction('edit');
    approve.mutate(
      {
        suggestionId: suggestion.id,
        expectedRevision: r.expectedRevision,
        ...(r.title === undefined ? {} : { finalTitle: r.title }),
        ...(r.content === undefined ? {} : { finalContent: r.content }),
        ...(r.scope === undefined ? {} : { scope: r.scope }),
      },
      {
        onSuccess: () => {
          setEditing(false);
        },
      },
    );
  };

  const fileRefs = (record?.revisions.at(-1)?.sourceRefs ?? []).flatMap((r) => (r.kind === 'file' ? [r] : []));
  const items = [
    { id: 'why', term: 'Why reusable', value: rationale ?? (detail.isPending ? 'Loading…' : 'No reason was given.') },
    {
      id: 'source',
      term: 'Source references',
      value: (
        <span>
          {suggestion.source.kind === 'run' ? (
            <Link to={paths.run(projectId, suggestion.source.runId)}>{runLabel(suggestion.source.runId)}</Link>
          ) : suggestion.source.kind === 'file' ? (
            <span className="mono">{suggestion.source.relPath}</span>
          ) : (
            'Added by you'
          )}
          {fileRefs.map((r) => (
            <span key={r.relPath}>
              {' '}
              · <span className="mono">{r.relPath}</span> <Hash value={r.sha256} label={`${r.relPath} hash`} />
            </span>
          ))}
        </span>
      ),
    },
    { id: 'type', term: 'Type', value: MEMORY_TYPE_LABELS[suggestion.type] },
  ];

  return (
    <article className="card stack" aria-labelledby={headingId}>
      <div className="card-header">
        <h3 id={headingId}>{suggestion.title}</h3>
        <span className="badge warning">Suggested, not used by runs</span>
      </div>
      {detail.error === null ? null : <ErrorView error={toViewError(detail.error)} onAction={() => void detail.refetch()} />}
      {editing && record !== undefined ? (
        <MemoryEditForm
          record={record}
          mode="approve"
          pending={approvePending}
          error={lastAction === 'edit' && approve.variables?.suggestionId === suggestion.id ? approve.error : null}
          onSubmit={doApproveEdited}
          onCancel={() => {
            setEditing(false);
          }}
          onReload={reload}
          titleOf={titleOf}
          onOpenConflict={(id) => {
            onCombine(suggestion.id, id);
          }}
        />
      ) : (
        <>
          <div className="stack" style={{ gap: 4 }}>
            <span className="section-label">Proposed text</span>
            {record === undefined ? (
              detail.isPending ? (
                <Skeleton lines={2} />
              ) : (
                <p className="prewrap">{suggestion.excerpt}</p>
              )
            ) : (
              <p className="prewrap" style={{ margin: 0 }}>
                {record.content}
              </p>
            )}
          </div>
          <KeyValueList items={items} />
          <Field label="Scope" id={scopeId}>
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
          {overlaps.length === 0 ? null : (
            <p className="small muted">
              Overlaps with <strong>{overlaps.join(', ')}</strong>. Combine opens both texts side by side; nothing is
              merged automatically.
            </p>
          )}
          {error === null || error === undefined ? null : (
            <MutationError
              error={error}
              names={{ recordTitle: titleOf }}
              handlers={{ reload }}
              conflictActions={(conflictCopy(error)?.conflictsWith ?? []).map((id) => (
                <Button
                  key={id}
                  size="sm"
                  variant="primary"
                  icon={Combine}
                  onClick={() => {
                    onCombine(suggestion.id, id);
                  }}
                >
                  {`Combine with “${titleOf(id) ?? 'the approved record'}”`}
                </Button>
              ))}
            />
          )}
          <div className="actions" style={{ flexWrap: 'wrap' }}>
            <Button variant="primary" icon={Check} pending={approvePending && lastAction === 'approve'} disabled={busy} onClick={doApprove}>
              Approve
            </Button>
            <Button
              icon={Pencil}
              disabled={busy || record === undefined}
              onClick={() => {
                setEditing(true);
              }}
            >
              Edit then approve
            </Button>
            <Button
              icon={Combine}
              disabled={busy}
              onClick={() => {
                onCombine(suggestion.id);
              }}
            >
              Combine with existing…
            </Button>
            <Button
              variant="danger"
              icon={X}
              pending={rejectPending}
              disabled={busy}
              onClick={() => {
                setLastAction('reject');
                reject.mutate({ suggestionId: suggestion.id });
              }}
            >
              Reject
            </Button>
          </div>
        </>
      )}
    </article>
  );
}
