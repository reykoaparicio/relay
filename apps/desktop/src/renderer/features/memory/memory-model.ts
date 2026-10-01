// Memory page model (10 J9, §5.5): display text for records, role scopes, review dates, and the mapping of
// `memory.*` validation issues to form fields. Pure functions only; the page and its panels render from these.
import { ROLES } from '@relay/contracts';
import type { MemoryRecordDetail, MemoryRecordScope, MemoryRecordView, Role } from '@relay/contracts';
import type { MemoryTab } from '../shell/paths';
import { ROLE_LABELS } from '../run-setup/model-steps';

export const MEMORY_TABS: readonly MemoryTab[] = ['approved', 'suggested', 'archived'];

export const MEMORY_TAB_LABELS: Readonly<Record<MemoryTab, string>> = {
  approved: 'Approved',
  suggested: 'Suggested',
  archived: 'Archived',
};

/** `?tab=` value → tab (unknown values fall back to Approved). */
export function parseMemoryTab(value: string | null): MemoryTab {
  return value === 'suggested' || value === 'archived' ? value : 'approved';
}

/** The tab a record is listed under, or null when it is not listed (rejected, deleted). */
export function tabOfStatus(status: MemoryRecordView['status']): MemoryTab | null {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'suggested':
      return 'suggested';
    case 'archived':
      return 'archived';
    case 'rejected':
    case 'deleted':
      return null;
  }
}

/** "All workflow roles" or "Reviewer, Planner". */
export function scopeText(scope: MemoryRecordScope): string {
  if (scope.roles === 'all') return 'All workflow roles';
  return scope.roles.map((r) => ROLE_LABELS[r]).join(', ');
}

/** Scope picker values: every role, or exactly one role. */
export type ScopeChoice = 'all' | Role;

/** The typed option whose value is `v` (a native select reports a plain string), or undefined. */
export function optionValue<T extends string>(options: ReadonlyArray<{ readonly value: T }>, v: string): T | undefined {
  return options.find((o) => o.value === v)?.value;
}

export const SCOPE_CHOICES: ReadonlyArray<{ readonly value: ScopeChoice; readonly label: string }> = [
  { value: 'all', label: 'This project / All workflow roles' },
  ...ROLES.map((r) => ({ value: r, label: `This project / ${ROLE_LABELS[r]} only` })),
];

export function scopeFromChoice(choice: ScopeChoice): MemoryRecordScope {
  return choice === 'all' ? { roles: 'all' } : { roles: [choice] };
}

/** The picker value of a scope; a multi-role scope has no single choice and shows as "all" until changed. */
export function choiceFromScope(scope: MemoryRecordScope): ScopeChoice {
  if (scope.roles === 'all') return 'all';
  return scope.roles.length === 1 && scope.roles[0] !== undefined ? scope.roles[0] : 'all';
}

/** Role checkboxes → scope: every role checked means `all`; none checked is invalid (null). */
export function scopeFromRoles(roles: ReadonlySet<Role>): MemoryRecordScope | null {
  if (roles.size === 0) return null;
  if (roles.size === ROLES.length) return { roles: 'all' };
  return { roles: ROLES.filter((r) => roles.has(r)) };
}

export function rolesOfScope(scope: MemoryRecordScope): Set<Role> {
  return new Set(scope.roles === 'all' ? ROLES : scope.roles);
}

/**
 * True when the review date has passed and the record was not touched since (§5.5 "review date": offer "Confirm
 * still accurate"). Confirming writes `reviewAt = now`, which also moves `updatedAt`, so a confirmed record is not due.
 */
export function isReviewDue(record: Pick<MemoryRecordView, 'reviewAt' | 'updatedAt'>, now: number): boolean {
  return record.reviewAt !== null && record.reviewAt <= now && record.updatedAt < record.reviewAt;
}

/** "you" / "run 0023": the author of a revision or event. */
export function actorText(actor: string): string {
  if (actor === 'user') return 'you';
  return actor.startsWith('run:') ? `Run ${actor.slice(-4)}` : actor;
}

/** The most recent file hash recorded for a record's source (stale-source banner). */
export function latestFileRef(record: MemoryRecordDetail): { readonly relPath: string; readonly sha256: string } | null {
  for (let i = record.revisions.length - 1; i >= 0; i -= 1) {
    const ref = record.revisions[i]?.sourceRefs.find((r) => r.kind === 'file');
    if (ref?.kind === 'file') return { relPath: ref.relPath, sha256: ref.sha256 };
  }
  return record.source.kind === 'file' ? { relPath: record.source.relPath, sha256: '' } : null;
}

/** Pairs of records that conflict (each pair once), in list order. Only listed (approved/suggested) records count. */
export function conflictPairs(records: readonly MemoryRecordView[]): Array<readonly [MemoryRecordView, MemoryRecordView]> {
  const byId = new Map(records.map((r) => [r.id as string, r]));
  const seen = new Set<string>();
  const out: Array<readonly [MemoryRecordView, MemoryRecordView]> = [];
  for (const r of records) {
    for (const otherId of r.conflictsWith) {
      const other = byId.get(otherId);
      if (other === undefined) continue;
      const key = [r.id, other.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      // A suggestion always goes first: `memory.resolveConflict` takes [suggestionId, approvedId] (02).
      out.push(other.status === 'suggested' && r.status !== 'suggested' ? [other, r] : [r, other]);
    }
  }
  return out;
}

/** Field ids of the memory forms (error anchors). */
export const MEMORY_FIELD = {
  title: 'memory-field-title',
  content: 'memory-field-content',
  roles: 'memory-field-roles',
  reviewAt: 'memory-field-review',
  expiresAt: 'memory-field-expires',
} as const;

/** `memory.*` issue path → field id (`finalContent` and `content` share the content field). */
export function memoryFieldOfPath(path: string): string | null {
  const head = path.split(/[.[]/)[0] ?? '';
  switch (head) {
    case 'title':
    case 'finalTitle':
      return MEMORY_FIELD.title;
    case 'content':
    case 'finalContent':
      return MEMORY_FIELD.content;
    case 'scope':
      return MEMORY_FIELD.roles;
    case 'reviewAt':
      return MEMORY_FIELD.reviewAt;
    case 'expiresAt':
      return MEMORY_FIELD.expiresAt;
    default:
      return null;
  }
}
