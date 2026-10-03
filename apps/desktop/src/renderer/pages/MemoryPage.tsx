import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { BookOpenCheck, Inbox, Plus } from 'lucide-react';
import type { MemoryRecordView } from '@relay/contracts';
import {
  Button,
  ButtonLink,
  EmptyState,
  ErrorView,
  InlineAlert,
  PageHeader,
  Skeleton,
  Tabs,
  useToast,
} from '../components/ui';
import { toViewError } from '../api/errors';
import { useRetryAction } from '../features/common/useNextAction';
import { AddRuleDialog } from '../features/memory/AddRuleDialog';
import { ConflictResolver } from '../features/memory/ConflictResolver';
import { MemoryDeleteDialog } from '../features/memory/MemoryDeleteDialog';
import type { DeleteTarget } from '../features/memory/MemoryDeleteDialog';
import { MemoryDetail } from '../features/memory/MemoryDetail';
import { MemoryEditForm } from '../features/memory/MemoryEditForm';
import { MemoryList } from '../features/memory/MemoryList';
import { SuggestionQueue } from '../features/memory/SuggestionQueue';
import { conflictPairs, MEMORY_TAB_LABELS, MEMORY_TABS, parseMemoryTab } from '../features/memory/memory-model';
import { useMemoryMutations } from '../features/memory/useMemoryMutations';
import { useMemorySelection } from '../features/memory/useMemorySelection';
import { paths } from '../features/shell/paths';
import type { MemoryTab } from '../features/shell/paths';
import { useMemoryList } from '../hooks/useMemoryList';
import { useMemoryRecord } from '../hooks/useMemoryRecord';
import { useNavPerf } from '../hooks/useNavPerf';
import { useProject } from '../hooks/useProject';

/** The open conflict panel: A and B (a suggestion is always A), and whether it came from "Combine with existing…". */
interface ConflictTarget {
  readonly a: string;
  readonly b: string;
  readonly combine: boolean;
}

type DetailCommand = 'archive' | 'restore' | 'pin' | 'confirm';

const EMPTY: Readonly<Record<MemoryTab, { readonly title: string; readonly body: string }>> = {
  approved: {
    title: 'No approved records yet',
    body: 'Add a project rule, or approve a suggestion from a run. Approved records are included in future runs within their scope.',
  },
  suggested: {
    title: 'No suggestions to review',
    body: 'Runs propose reusable rules and decisions here. Suggestions are never used by runs until you approve them.',
  },
  archived: {
    title: 'Nothing archived',
    body: 'Archived records stay here for reference and are not included in runs.',
  },
};

/**
 * Project memory (10 J9, memory.html): Approved / Suggested / Archived tabs (`?tab=`, `?record=`), a record list
 * with a detail panel, the suggestions queue, conflict resolution, editing with an expected revision, and delete
 * with its consequences. Mock states: approved, suggestions, conflict, edit, delete-confirm, stale-source.
 */
export function MemoryPage() {
  const { projectId = '' } = useParams();
  const { tab, recordParam, select } = useMemorySelection();
  const toast = useToast();
  const project = useProject(projectId);
  const approvedQ = useMemoryList(projectId, 'approved');
  const suggestedQ = useMemoryList(projectId, 'suggested');
  const mutations = useMemoryMutations(projectId);
  // PERF-05: the archived list is fetched once it is needed: its tab was opened, or something was archived here (its
  // count then changes in front of the user). Until then its tab shows no count.
  const [archivedSeen, setArchivedSeen] = useState(tab === 'archived');
  if (tab === 'archived' && !archivedSeen) setArchivedSeen(true);
  const archivedQ = useMemoryList(projectId, 'archived', { enabled: archivedSeen || mutations.archive.isSuccess });
  const lists = { approved: approvedQ, suggested: suggestedQ, archived: archivedQ } as const;
  const current = lists[tab];
  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [conflict, setConflict] = useState<ConflictTarget | null>(null);
  const [command, setCommand] = useState<DetailCommand | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const conflictHeading = useRef<HTMLHeadingElement>(null);
  const retry = useRetryAction(() => {
    void current.refetch();
  });

  useNavPerf('memory', current.data !== undefined || current.error !== null);

  const items = current.data ?? [];
  const selected: MemoryRecordView | undefined =
    tab === 'suggested' ? undefined : (items.find((r) => r.id === recordParam) ?? items[0]);
  const detail = useMemoryRecord(selected?.id);
  const record = detail.data !== undefined && detail.data.id === selected?.id ? detail.data : undefined;

  const listed = [...(approvedQ.data ?? []), ...(suggestedQ.data ?? [])];
  const pairs = conflictPairs(listed);
  const titleOf = (id: string) => [...listed, ...(archivedQ.data ?? [])].find((r) => r.id === id)?.title;

  /** Reload of a stale CONFLICT: the record detail and the list it was opened from (its revision). */
  const reloadRecord = () => {
    void current.refetch();
    void detail.refetch();
  };

  // Leaving a record (another selection, tab, or deletion) ends its edit.
  if (editingId !== null && selected !== undefined && editingId !== selected.id) setEditingId(null);

  useEffect(() => {
    if (conflict !== null) conflictHeading.current?.focus();
  }, [conflict]);

  const commandError = (() => {
    if (command === null || selected === undefined) return null;
    if (command === 'archive') return mutations.archive.variables?.recordId === selected.id ? mutations.archive.error : null;
    return mutations.update.variables?.recordId === selected.id ? mutations.update.error : null;
  })();
  const commandPending =
    command === null ? null : (command === 'archive' ? mutations.archive.isPending : mutations.update.isPending) ? command : null;

  const projectName = project.data?.name ?? 'Project';
  const header = (
    <PageHeader
      title="Project memory"
      breadcrumbs={[{ label: projectName }, { label: 'Approved knowledge persists across runs' }]}
      actions={
        <Button
          variant="primary"
          icon={Plus}
          onClick={() => {
            setAddOpen(true);
          }}
        >
          Add project rule
        </Button>
      }
    />
  );

  const suggestionCount = suggestedQ.data?.length ?? 0;
  const tabLabel = (t: MemoryTab): ReactNode => {
    const n = lists[t].data?.length;
    return (
      <>
        {MEMORY_TAB_LABELS[t]} {n === undefined ? null : <span className="num">({String(n)})</span>}
      </>
    );
  };

  const openConflict = (a: MemoryRecordView, b: MemoryRecordView, combine = false) => {
    setEditingId(null);
    setConflict({ a: a.id, b: b.id, combine });
  };

  const conflictA = conflict === null ? undefined : listed.find((r) => r.id === conflict.a);
  const conflictB = conflict === null ? undefined : listed.find((r) => r.id === conflict.b);
  const approvedList = approvedQ.data ?? [];

  const listBody = (t: MemoryTab) => {
    const q = lists[t];
    if (q.error !== null) return <ErrorView error={toViewError(q.error)} onAction={retry} />;
    if (q.data === undefined) {
      return (
        <div aria-busy="true">
          <Skeleton lines={6} />
        </div>
      );
    }
    if (q.data.length === 0) {
      return (
        <EmptyState
          icon={t === 'suggested' ? Inbox : BookOpenCheck}
          title={EMPTY[t].title}
          body={EMPTY[t].body}
          {...(t === 'approved'
            ? {
                actions: (
                  <Button
                    icon={Plus}
                    onClick={() => {
                      setAddOpen(true);
                    }}
                  >
                    Add project rule
                  </Button>
                ),
              }
            : {})}
        />
      );
    }
    if (t === 'suggested') {
      return (
        <SuggestionQueue
          projectId={projectId}
          suggestions={q.data}
          titleOf={titleOf}
          mutations={mutations}
          onCombine={(suggestion, withId) => {
            const first =
              (withId === undefined ? undefined : approvedList.find((r) => r.id === withId)) ??
              approvedList.find((r) => suggestion.conflictsWith.includes(r.id)) ??
              approvedList[0];
            if (first === undefined) {
              toast.show({ key: 'memory:combine-none', title: 'No approved record to combine with', tone: 'info' });
              return;
            }
            openConflict(suggestion, first, true);
          }}
        />
      );
    }
    return (
      <div className="grid grid-cols-[minmax(240px,1fr)_minmax(0,1.6fr)] items-start gap-5 max-[1024px]:grid-cols-1">
        <MemoryList
          label={`${MEMORY_TAB_LABELS[t]} records`}
          records={q.data}
          selectedId={selected?.id}
          onSelect={(id) => {
            select({ record: id });
          }}
        />
        {selected === undefined ? null : detail.error !== null ? (
          <ErrorView error={toViewError(detail.error)} onAction={() => void detail.refetch()} />
        ) : record === undefined ? (
          <div className="card" aria-busy="true">
            <Skeleton lines={8} />
          </div>
        ) : editingId === record.id ? (
          <section className="card stack" aria-labelledby="memory-edit-heading">
            <div className="card-header">
              <h2 id="memory-edit-heading">Edit: {record.title}</h2>
              <span className="badge info">Editing revision {String(record.currentRevision)}</span>
            </div>
            <MemoryEditForm
              record={record}
              mode="edit"
              pending={mutations.update.isPending}
              error={mutations.update.variables?.recordId === record.id ? mutations.update.error : null}
              onSubmit={(r) => {
                setCommand(null);
                mutations.update.mutate(
                  { recordId: record.id, ...r },
                  {
                    onSuccess: (saved) => {
                      setEditingId(null);
                      toast.show({
                        key: `memory:saved:${saved.id}`,
                        title: `Saved revision ${String(saved.currentRevision)}`,
                        body: 'Future runs use the new text; earlier runs keep the revision they used.',
                        tone: 'success',
                      });
                    },
                  },
                );
              }}
              onCancel={() => {
                mutations.update.reset();
                setEditingId(null);
              }}
              onReload={reloadRecord}
              titleOf={titleOf}
              onOpenConflict={(otherId) => {
                const other = listed.find((r) => r.id === otherId);
                if (other !== undefined) openConflict(selected, other);
              }}
            />
          </section>
        ) : (
          <MemoryDetail
            projectId={projectId}
            record={record}
            errorCommand={commandError === null ? null : command}
            headingRef={detailHeading}
            pending={commandPending}
            error={commandError}
            onReload={reloadRecord}
            titleOf={titleOf}
            onEdit={() => {
              mutations.update.reset();
              setEditingId(record.id);
            }}
            onDelete={() => {
              setDeleteTarget({ id: record.id, title: record.title, usedByRuns: record.usedByRuns, approved: record.status === 'approved' });
            }}
            onArchive={() => {
              setCommand('archive');
              mutations.archive.mutate(
                { recordId: record.id },
                {
                  onSuccess: () => {
                    toast.show({ key: `memory:archived:${record.id}`, title: `Archived “${record.title}”`, body: 'It is no longer included in runs.', tone: 'success' });
                  },
                },
              );
            }}
            onRestore={() => {
              setCommand('restore');
              mutations.update.mutate({ recordId: record.id, expectedRevision: record.currentRevision, unarchive: true });
            }}
            onTogglePinned={(pinned) => {
              setCommand('pin');
              mutations.update.mutate({ recordId: record.id, expectedRevision: record.currentRevision, pinned });
            }}
            onConfirmAccurate={() => {
              setCommand('confirm');
              mutations.update.mutate(
                { recordId: record.id, expectedRevision: record.currentRevision, confirmCurrent: true },
                {
                  onSuccess: () => {
                    toast.show({ key: `memory:reviewed:${record.id}`, title: 'Confirmed still accurate', tone: 'success' });
                  },
                },
              );
            }}
          />
        )}
      </div>
    );
  };

  return (
    <>
      {header}
      {tab !== 'suggested' && suggestionCount > 0 && conflict === null ? (
        <section className="card row" aria-labelledby="memory-suggest-bar" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div className="stack" style={{ gap: 4 }}>
            <h2 id="memory-suggest-bar">
              {String(suggestionCount)} suggested {suggestionCount === 1 ? 'memory needs' : 'memories need'} review
            </h2>
            <p className="muted">Suggestions are excluded from future runs until approved.</p>
          </div>
          <ButtonLink as={Link} to={paths.memory(projectId, { tab: 'suggested' })}>
            Review suggestions
          </ButtonLink>
        </section>
      ) : null}
      {pairs.length > 0 && conflict === null ? (
        <InlineAlert
          tone="warning"
          title={pairs.length === 1 ? 'Two records give incompatible instructions' : `${String(pairs.length)} conflicts need a decision`}
        >
          <p>Relay never combines conflicting instructions silently. Neither record changes until you choose.</p>
          <ul className="stack" style={{ margin: 0, paddingLeft: 16, gap: 4 }}>
            {pairs.map(([a, b]) => (
              <li key={`${a.id}|${b.id}`} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span>
                  “{a.title}” vs “{b.title}”
                </span>
                <Button
                  size="sm"
                  onClick={() => {
                    openConflict(a, b);
                  }}
                >
                  Resolve conflict
                </Button>
              </li>
            ))}
          </ul>
        </InlineAlert>
      ) : null}
      {conflict !== null && conflictA !== undefined && conflictB !== undefined ? (
        <ConflictResolver
          projectId={projectId}
          a={conflictA}
          b={conflictB}
          headingRef={conflictHeading}
          {...(conflict.combine
            ? {
                candidates: approvedList,
                onChangeB: (id: string) => {
                  setConflict({ ...conflict, b: id });
                },
              }
            : {})}
          onResolved={() => {
            setConflict(null);
            toast.show({ key: `memory:resolved:${conflict.a}`, title: 'Conflict resolved', body: 'Future runs use the result; earlier runs keep their copies.', tone: 'success' });
          }}
          onCancel={() => {
            setConflict(null);
          }}
        />
      ) : (
        <Tabs
          label="Filter records by status"
          value={tab}
          onValueChange={(id) => {
            select({ tab: parseMemoryTab(id), record: null });
          }}
          tabs={MEMORY_TABS.map((t) => ({ id: t, label: tabLabel(t), content: t === tab ? listBody(t) : null }))}
        />
      )}
      <AddRuleDialog
        projectId={projectId}
        open={addOpen}
        onOpenChange={setAddOpen}
        titleOf={titleOf}
        onCreated={(id) => {
          select({ tab: 'approved', record: id });
          toast.show({ key: `memory:created:${id}`, title: 'Rule added', body: 'Future runs include it within its scope.', tone: 'success' });
        }}
      />
      {deleteTarget === null ? null : (
        <MemoryDeleteDialog
          target={deleteTarget}
          projectId={projectId}
          mutations={mutations}
          archiveWasLast={command === 'archive'}
          returnFocusFallback={detailHeading}
          onClose={() => {
            setDeleteTarget(null);
          }}
          onArchiveStart={() => {
            setCommand('archive');
          }}
          onDeleted={() => {
            select({ record: null });
          }}
        />
      )}
    </>
  );
}
