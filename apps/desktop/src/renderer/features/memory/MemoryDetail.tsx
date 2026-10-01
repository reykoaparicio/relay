import { useId } from 'react';
import type { RefObject } from 'react';
import { Link } from 'react-router';
import { Archive, ArchiveRestore, Pencil, Pin, Trash2, TriangleAlert } from 'lucide-react';
import type { MemoryRecordDetail } from '@relay/contracts';
import { Button, ButtonLink, Checkbox, Hash, InlineAlert, KeyValueList, StatusBadge } from '../../components/ui';
import type { KeyValueItem } from '../../components/ui';
import { formatAbsoluteTime, formatDate, MEMORY_TYPE_LABELS } from '../../lib/format';
import { useMemoryRecord } from '../../hooks/useMemoryRecord';
import { runLabel } from '../runs/run-display';
import { paths } from '../shell/paths';
import { MutationError } from '../common/MutationError';
import { actorText, isReviewDue, latestFileRef, scopeText, tabOfStatus } from './memory-model';

export interface MemoryDetailProps {
  readonly projectId: string;
  readonly record: MemoryRecordDetail;
  readonly now: number;
  readonly headingRef?: RefObject<HTMLHeadingElement | null>;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onArchive: () => void;
  readonly onRestore: () => void;
  readonly onTogglePinned: (pinned: boolean) => void;
  /** "Confirm still accurate": `memory.update` with unchanged content and `reviewAt = now` (§5.5). */
  readonly onConfirmAccurate: () => void;
  /** The pending command, for button spinners. */
  readonly pending: 'archive' | 'restore' | 'pin' | 'confirm' | null;
  /** The last failed command of this panel (pin / archive / restore / confirm). */
  readonly error: unknown;
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

/** Detail panel of one record (memory `approved` / `stale-source` states, §5.5 record fields). */
export function MemoryDetail(props: MemoryDetailProps) {
  const { projectId, record, now, headingRef, pending, error } = props;
  const titleId = useId();
  const due = isReviewDue(record, now);
  const fileRef = latestFileRef(record);
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
          <p>
            {fileRef === null ? 'A source this record cites' : <>Source file <span className="mono">{fileRef.relPath}</span></>}{' '}
            changed since this record was approved
            {fileRef === null || fileRef.sha256 === '' ? null : (
              <>
                {' '}
                (approved at <Hash value={fileRef.sha256} />)
              </>
            )}
            . The record is still included in runs and is marked stale in each context manifest.
          </p>
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
              {r.revision === record.currentRevision ? <span className="subtle"> · current</span> : null}
            </li>
          ))}
        </ol>
      </div>
      <p className="subtle small">No secrets or provider credentials belong in memory.</p>
      <MutationError
        error={error}
        {...(props.onReload === undefined ? {} : { handlers: { reload: props.onReload } })}
        {...(props.titleOf === undefined ? {} : { names: { recordTitle: props.titleOf } })}
      />
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
        <p className="subtle small">Confirming records a review event with today&apos;s date; the text stays the same.</p>
      ) : null}
    </section>
  );
}
