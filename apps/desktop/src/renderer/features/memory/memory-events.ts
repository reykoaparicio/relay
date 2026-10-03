// Memory audit trail (E2 #17): plain-language text for every `MemoryRecordDetail.events[]` entry, including the
// stored `detail`. Only known detail keys are read (and only when they have the expected type); anything else is
// ignored, never shown raw. Pure functions only.
import type { MemoryEventType, MemoryRecordDetail } from '@relay/contracts';
import { runLabel } from '../../lib/format';
import { actorText } from './memory-model';

export type MemoryEvent = MemoryRecordDetail['events'][number];

/** What happened, by event type. */
export const MEMORY_EVENT_LABELS: Readonly<Record<MemoryEventType, string>> = {
  suggested: 'Suggested',
  approved: 'Approved',
  edited: 'Edited',
  archived: 'Archived',
  rejected: 'Rejected',
  deleted: 'Deleted',
  conflict_resolved: 'Conflict resolved',
  unarchived: 'Restored to approved',
  history_purged: 'Earlier revisions purged (the current text was kept)',
  reviewed: 'Confirmed still accurate',
  skipped: 'Left out of a run',
};

/** Why a run left a record out, by the record's status at the time (`skipped` detail.status). */
const SKIPPED_BECAUSE: Readonly<Partial<Record<string, string>>> = {
  archived: 'it was archived',
  deleted: 'it was deleted',
  rejected: 'it was rejected',
  suggested: 'it was not approved yet',
  approved: 'it was no longer available (expired)',
};

const RESOLUTION_TEXT: Readonly<Partial<Record<string, string>>> = {
  keep: 'one record was kept',
  rewrite: 'combined into a new record',
  keepBothWithScopes: 'both kept for different roles',
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

export interface MemoryEventTextOptions {
  /** Title of another record (by id), for `with` / `supersededById`. */
  readonly titleOf?: ((id: string) => string | undefined) | undefined;
}

/** A record named by id: its title in quotes when known, else "another record". */
function recordName(id: string, titleOf: MemoryEventTextOptions['titleOf']): string {
  const title = titleOf?.(id);
  return title === undefined ? 'another record' : `“${title}”`;
}

/**
 * The plain sentence of one event, e.g. "Confirmed still accurate · 1 source file checked, 1 hash refreshed" or
 * "Left out of Run 0022 because it was archived".
 */
export function memoryEventText(e: MemoryEvent, opts: MemoryEventTextOptions = {}): string {
  const d = e.detail ?? {};
  switch (e.event) {
    case 'reviewed': {
      const files = count(d['fileRefs']);
      const refreshed = count(d['refreshed']);
      const parts: string[] = [];
      if (files !== null && files > 0) parts.push(`${plural(files, 'source file', 'source files')} checked`);
      if (refreshed !== null && refreshed > 0) parts.push(`${plural(refreshed, 'hash', 'hashes')} refreshed`);
      else if (refreshed === 0 && files !== null && files > 0) parts.push('no change found');
      return parts.length === 0 ? MEMORY_EVENT_LABELS.reviewed : `${MEMORY_EVENT_LABELS.reviewed} · ${parts.join(', ')}`;
    }
    case 'skipped': {
      const runId = str(d['runId']);
      const status = str(d['status']);
      const because = status === null ? undefined : SKIPPED_BECAUSE[status];
      const base = runId === null ? 'Left out of a run' : `Left out of ${runLabel(runId)}`;
      return because === undefined ? base : `${base} because ${because}`;
    }
    case 'rejected': {
      const reason = str(d['reason']);
      return reason === null ? MEMORY_EVENT_LABELS.rejected : `${MEMORY_EVENT_LABELS.rejected} · reason: ${reason}`;
    }
    case 'archived': {
      const by = str(d['supersededById']);
      return by === null ? MEMORY_EVENT_LABELS.archived : `${MEMORY_EVENT_LABELS.archived} · replaced by ${recordName(by, opts.titleOf)}`;
    }
    case 'conflict_resolved': {
      const resolution = str(d['resolution']);
      const how = resolution === null ? undefined : RESOLUTION_TEXT[resolution];
      const other = str(d['with']);
      const withText = other === null ? '' : ` with ${recordName(other, opts.titleOf)}`;
      return `${MEMORY_EVENT_LABELS.conflict_resolved}${withText}${how === undefined ? '' : `: ${how}`}`;
    }
    case 'suggested':
    case 'approved':
    case 'edited':
    case 'deleted':
    case 'unarchived':
    case 'history_purged':
      return MEMORY_EVENT_LABELS[e.event];
  }
}

/** "by you" / "by Run 0023". */
export function memoryEventActorText(actor: string): string {
  return `by ${actorText(actor)}`;
}
