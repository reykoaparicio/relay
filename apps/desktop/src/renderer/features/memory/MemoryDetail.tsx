import { useId } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Link } from 'react-router';
import { Archive, ArchiveRestore, Pencil, Pin, Trash2, TriangleAlert } from 'lucide-react';
import type { MemoryRecordDetail } from '@relay/contracts';
import { Button, ButtonLink, Checkbox, Hash, InlineAlert, KeyValueList, StatusBadge } from '../../components/ui';
import type { KeyValueItem } from '../../components/ui';
import { formatAbsoluteTime, formatDate, MEMORY_TYPE_LABELS } from '../../lib/format';
import { isAppErrorException } from '../../api/client';
import { useMemoryRecord } from '../../hooks/useMemoryRecord';
import { runLabel } from '../runs/run-display';
import { paths } from '../shell/paths';
import { MutationError } from '../common/MutationError';
import { memoryEventActorText, memoryEventText } from './memory-events';
import { actorText, latestFileRef, revisionUsageText, scopeText, staleFileRefs, tabOfStatus } from './memory-model';
import type { StaleFileRef } from './memory-model';

export interface MemoryDetailProps {
  readonly projectId: string;
  readonly record: MemoryRecordDetail;
  readonly headingRef?: RefObject<HTMLHeadingElement | null>;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onArchive: () => void;
  readonly onRestore: () => void;
  readonly onTogglePinned: (pinned: boolean) => void;
  /** "Confirm still accurate": `memory.update` with `confirmCurrent: true` (E2 #16; the review date is kept). */
  readonly onConfirmAccurate: () => void;
  /** The pending command, for button spinners. */
  readonly pending: 'archive' | 'restore' | 'pin' | 'confirm' | null;
  /** The last failed command of this panel (pin / archive / restore / confirm). */
  readonly error: unknown;
  /** Which command `error` came from (a failed confirmation of a missing / unreadable source has its own copy). */
  readonly errorCommand?: 'archive' | 'restore' | 'pin' | 'confirm' | null;
  /** Refetches this record (the "Reload" of a stale CONFLICT). */
  readonly onReload?: () => void;
  /** Titles of other records (by id), for a memory conflict. */
  readonly titleOf?: (id: string) => string | undefined;
}

/** "Superseded by <title>" linking to the record that replaced this one (`?tab=…&record=<id>`). */
function SupersededLink({ projectId, id }: { readonly projectId: string; readonly id: string }) {
  const target = useMemoryRecord(id);
  const tab = target.data === undefined ? 'approved' : (tabOfStatus(target.data.status) ?? 'approved');
  return (
    <span>
      Superseded by{' '}
      <Link to={paths.memory(projectId, { tab, record: id })}>{target.data?.title ?? 'the record that replaced it'}</Link>
    </span>
  );
}

function sourceItem(projectId: string, record: MemoryRecordDetail): KeyValueItem {
  const ref = latestFileRef(record);
  const file =
    ref === null ? null : (
      <>
        <span className="mono small">{ref.relPath}</span>
        {ref.sha256 === '' ? null : (
          <>
            {' '}
            <Hash value={ref.sha256} />
          </>
        )}
      </>
    );
  let value;
  switch (record.source.kind) {
    case 'run':
      value = (
        <>
          <Link to={paths.run(projectId, record.source.runId)}>{runLabel(record.source.runId)}</Link>
          {file === null ? null : <> · {file}</>}
        </>
      );
      break;
    case 'file':
      value = <>Project file {file}</>;
      break;
    case 'user':
      value = file === null ? 'Added by you' : <>Added by you · {file}</>;
      break;
  }
  return { id: 'source', term: 'Source', value };
}

/** Paths of the files a failed confirmation names: `details.relPath` when the error carries one, else the record's. */
function failedPaths(details: Readonly<Record<string, unknown>> | undefined, refs: readonly StaleFileRef[]): string[] {
  const relPath = details?.['relPath'];
  if (typeof relPath === 'string' && relPath !== '') return [relPath];
  return refs.map((r) => r.relPath);
}

/**
 * E2 #16: "Confirm still accurate" re-reads the record's source files; a missing (NOT_FOUND, not the record itself) or
 * unreadable (PERMISSION_DENIED) file fails it and nothing is written. Plain copy instead of the generic error.
 */
function confirmSourceAlert(error: unknown, refs: readonly StaleFileRef[]): ReactNode {
  if (!isAppErrorException(error)) return null;
  const { code, details } = error.appError;
  const missing = code === 'NOT_FOUND' && details?.['entity'] !== 'memory';
  if (!missing && code !== 'PERMISSION_DENIED') return null;
  const files = failedPaths(details, refs);
  const names =
    files.length === 0 ? null : (
      <>
        {' '}
        (
        {files.map((f, i) => (
          <span key={f}>
            {i === 0 ? null : ', '}
            <span className="mono">{f}</span>
          </span>
        ))}
        )
      </>
    );
  return (
    <InlineAlert
      tone="danger"
      live="assertive"
      title={missing ? 'A source file could not be found' : 'A source file could not be read'}
    >
      <p>
        {missing ? (
          <>
            Relay could not find this record&apos;s source file{names}. It may have been moved or deleted. Nothing was
            changed: edit the record to point at the right file, or archive it if it no longer applies.
          </>
        ) : (
          <>
            Relay could not read this record&apos;s source file{names}. Check that the file can be opened, then try again.
            Nothing was changed.
          </>
        )}
      </p>
    </InlineAlert>
  );
}

/** Stale-source banner text (E2 #16): which file changed and the hash recorded for it (no live hash is available). */
function StaleSource({ refs }: { readonly refs: readonly StaleFileRef[] }) {
  if (refs.length === 0) {
    return <p>A source this record cites changed since it was approved.</p>;
  }
  return (
    <>
      <p>
        {refs.length === 1 ? (
          <>
            Source file <span className="mono">{refs[0]?.relPath}</span> changed since this record was approved.
          </>
        ) : (
          <>One of this record&apos;s {String(refs.length)} source files changed since it was approved.</>
        )}
      </p>
      <ul className="stack small" style={{ margin: 0, paddingLeft: 16, gap: 4 }} aria-label="Changed source files">
        {refs.map((r) => (
          <li key={r.relPath}>
            <span className="mono">{r.relPath}</span>
            {r.sha256 === '' ? (
              <> · no hash was recorded</>
            ) : r.previous === null ? (
              <>
                {' '}
                · hash when approved <Hash value={r.sha256} label={`${r.relPath} hash when approved`} />
              </>
            ) : (
              <>
                {' '}
                · hash when last confirmed (revision {String(r.revision)}){' '}
                <Hash value={r.sha256} label={`${r.relPath} hash at revision ${String(r.revision)}`} />, before that
                (revision {String(r.previous.revision)}){' '}
                <Hash value={r.previous.sha256} label={`${r.relPath} hash at revision ${String(r.previous.revision)}`} />
              </>
            )}
          </li>
        ))}
      </ul>
      <p>The file&apos;s current hash is checked again when you confirm.</p>
    </>
  );
}

/** Detail panel of one record (memory `approved` / `stale-source` states, §5.5 record fields). */
export function MemoryDetail(props: MemoryDetailProps) {
  const { projectId, record, headingRef, pending, error } = props;
  const titleId = useId();
  // E2 #16: due/last-review come from the runner (optional fields: absent = not due / never confirmed).
  const due = record.reviewDue === true;
  const lastReviewedAt = record.lastReviewedAt ?? null;
  const staleRefs = record.stale ? staleFileRefs(record) : [];
  const confirmError = props.errorCommand === 'confirm' ? confirmSourceAlert(error, staleFileRefs(record)) : null;
  const approved = record.status === 'approved';
  const archived = record.status === 'archived';

  const statusParts = [
    `Revision ${String(record.currentRevision)}`,
    record.expiresAt === null ? 'No expiry' : `Expires ${formatDate(record.expiresAt)}`,
  ];
  const items: KeyValueItem[] = [
    { id: 'content', term: 'Content', value: <span className="prewrap">{record.content}</span> },
    { id: 'type', term: 'Type', value: MEMORY_TYPE_LABELS[record.type] },
    sourceItem(projectId, record),
    { id: 'scope', term: 'Scope', value: `This project only / ${scopeText(record.scope)}` },
    {
      id: 'status',
      term: 'Status',
      value: (
        <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <StatusBadge kind="memory" value={record.status} />
          <span>{statusParts.join(' / ')}</span>
        </span>
      ),
    },
    {
      id: 'review',
      term: 'Review date',
      value:
        record.reviewAt === null ? (
          'None scheduled'
        ) : (
          <span>
            {formatDate(record.reviewAt)}
            {due ? (
              <>
                {' '}
                <span className="badge warning">
                  <TriangleAlert aria-hidden="true" /> Review due
                </span>
              </>
            ) : null}
          </span>
        ),
    },
    {
      id: 'reviewed',
      term: 'Last confirmed',
      value: lastReviewedAt === null ? 'Never' : formatDate(lastReviewedAt),
    },
    ...(record.supersededById === null
      ? []
      : [{ id: 'superseded', term: 'Superseded', value: <SupersededLink projectId={projectId} id={record.supersededById} /> }]),
    {
      id: 'dates',
      term: 'Created / updated',
      value: (
        <span>
          <span className="num">{formatAbsoluteTime(record.createdAt)}</span> /{' '}
          <span className="num">{formatAbsoluteTime(record.updatedAt)}</span>
        </span>
      ),
    },
    {
      id: 'used',
      term: 'Used by runs',
      value: record.usedByRuns === 0 ? 'Not used by any run yet' : `${String(record.usedByRuns)} run snapshot${record.usedByRuns === 1 ? '' : 's'}`,
    },
  ];

  return (
    <section className="card stack" aria-labelledby={titleId}>
      <div className="card-header">
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>
          {record.title}
        </h2>
        <span className="row" style={{ gap: 6 }}>
          <StatusBadge kind="memory" value={record.status} />
          {record.pinned ? (
            <span className="tag">
              <Pin aria-hidden="true" width={12} height={12} /> Pinned
            </span>
          ) : null}
          {record.stale ? (
            <span className="badge warning">
              <TriangleAlert aria-hidden="true" /> Source changed
            </span>
          ) : null}
        </span>
      </div>
      {record.stale ? (
        <InlineAlert tone="warning" title="Source changed since approval">
          <StaleSource refs={staleRefs} />
          <p>The record is still included in runs and is marked stale in each context manifest.</p>
        </InlineAlert>
      ) : due ? (
        <InlineAlert tone="info" title="Review date reached">
          <p>Confirm the record is still accurate, edit it, or archive it.</p>
        </InlineAlert>
      ) : null}
      <KeyValueList items={items} />
      {approved ? (
        <div className="stack" style={{ gap: 4 }}>
          <Checkbox
            label="Pinned: always included in runs within its scope"
            checked={record.pinned}
            disabled={pending === 'pin'}
            onCheckedChange={props.onTogglePinned}
          />
        </div>
      ) : null}
      <div className="stack" style={{ gap: 4 }}>
        <span className="section-label">Revision history</span>
        <ol className="stack small" reversed style={{ margin: 0, paddingLeft: 20, gap: 4 }}>
          {[...record.revisions].reverse().map((r) => (
            <li key={r.revision}>
              <span className="mono">rev {String(r.revision)}</span> · {r.title === record.title ? null : <>“{r.title}” · </>}
              by {actorText(r.author)} · <span className="subtle">{formatDate(r.createdAt)}</span>
              {revisionUsageText(r.usedByRuns) === null ? null : <span className="subtle"> · {revisionUsageText(r.usedByRuns)}</span>}
              {r.revision === record.currentRevision ? <span className="subtle"> · current</span> : null}
            </li>
          ))}
        </ol>
      </div>
      {record.events.length === 0 ? null : (
        <div className="stack" style={{ gap: 4 }}>
          <span className="section-label" id={`${titleId}-events`}>
            Events
          </span>
          <ol className="stack small" reversed aria-labelledby={`${titleId}-events`} style={{ margin: 0, paddingLeft: 20, gap: 4 }}>
            {[...record.events].reverse().map((e, i) => (
              <li key={`${e.event}-${String(e.createdAt)}-${String(i)}`}>
                {memoryEventText(e, props.titleOf === undefined ? {} : { titleOf: props.titleOf })}
                {/* A run's own "left out" event already names the run. */}
                {e.event === 'skipped' && e.actor.startsWith('run:') ? null : <> · {memoryEventActorText(e.actor)}</>}
                {' · '}
                <span className="subtle">
                  revision {String(e.revision)} · {formatDate(e.createdAt)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <p className="subtle small">No secrets or provider credentials belong in memory.</p>
      {confirmError ?? (
        <MutationError
          error={error}
        {...(props.onReload === undefined ? {} : { handlers: { reload: props.onReload } })}
          {...(props.titleOf === undefined ? {} : { names: { recordTitle: props.titleOf } })}
        />
      )}
      <div className="actions" style={{ flexWrap: 'wrap' }}>
        {approved && (record.stale || due) ? (
          <Button variant="primary" pending={pending === 'confirm'} onClick={props.onConfirmAccurate}>
            Confirm still accurate
          </Button>
        ) : null}
        {approved ? (
          <Button icon={Pencil} onClick={props.onEdit}>
            Edit
          </Button>
        ) : null}
        {approved ? (
          <Button icon={Archive} pending={pending === 'archive'} onClick={props.onArchive}>
            Archive
          </Button>
        ) : null}
        {archived ? (
          <Button icon={ArchiveRestore} pending={pending === 'restore'} onClick={props.onRestore}>
            Restore to approved
          </Button>
        ) : null}
        <Button variant="danger" icon={Trash2} onClick={props.onDelete}>
          Delete…
        </Button>
        {record.source.kind === 'run' ? (
          <ButtonLink as={Link} variant="ghost" to={paths.run(projectId, record.source.runId)}>
            Open source run
          </ButtonLink>
        ) : null}
      </div>
      {approved && (record.stale || due) ? (
        <p className="subtle small">Confirming re-checks the source files and records that you reviewed it today; the text and the review date stay the same.</p>
      ) : null}
    </section>
  );
}
