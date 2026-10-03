// 07 G5: memory service (§10.4 lifecycle, §4.5, §5.5). The status state machine is the pure `transitionMemory`; the
// lifecycle operations below run inside the caller's transaction (memory-handlers.ts wraps them for the memory.* IPC
// ops). Suggestions never enter context: only approved records are snapshotted (`retrievable`, §10.1), and resolving a
// conflict never leaves a suggestion in `suggested`. The service never auto-merges (§5.5).
import { err, errors, idSchema, looksLikeSecret, memoryContentSchema, memoryTitleSchema, ok, redactDeep, ROLES } from '@relay/contracts';
import type {
  AppError,
  ArtifactId,
  Clock,
  EpochMs,
  IdGen,
  MemoryEventType,
  MemoryId,
  MemoryRecordScope,
  MemorySourceRef,
  MemoryStatus,
  MemoryType,
  ProjectId,
  PushEvent,
  Result,
  RunId,
  SourceRef,
} from '@relay/contracts';
import type { Db, MemoryItem, Repos, RunRow } from '@relay/storage';
import type { ArtifactStore } from '@relay/tools';
import { latestOutputStep, readOutput } from './context.js';
import { isMandatory } from './memory-retrieval.js';
import type { Logger, MemoryServicePort } from './ports.js';

/** Dependencies of the memory service. */
interface MemoryServiceDeps {
  readonly db: Db;
  readonly artifacts: ArtifactStore;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
  readonly emit?: ((e: PushEvent) => void) | undefined;
}

/** §10.4 lifecycle actions (one per row of the 07 G5 table; conflict resolution composes them). */
export type MemoryAction = 'create' | 'propose' | 'record_summary' | 'approve' | 'reject' | 'edit' | 'archive' | 'unarchive' | 'delete';

const TRANSITIONS: Readonly<Record<MemoryAction, { readonly from: readonly (MemoryStatus | null)[]; readonly to: MemoryStatus }>> = {
  create: { from: [null], to: 'approved' },
  propose: { from: [null], to: 'suggested' },
  record_summary: { from: [null], to: 'approved' },
  approve: { from: ['suggested'], to: 'approved' },
  reject: { from: ['suggested'], to: 'rejected' },
  edit: { from: ['approved'], to: 'approved' },
  archive: { from: ['approved'], to: 'archived' },
  unarchive: { from: ['archived'], to: 'approved' },
  delete: { from: ['approved', 'archived'], to: 'deleted' },
};

const EVENT_OF: Readonly<Record<MemoryAction, MemoryEventType>> = {
  create: 'approved', propose: 'suggested', record_summary: 'approved', approve: 'approved', reject: 'rejected',
  edit: 'edited', archive: 'archived', unarchive: 'unarchived', delete: 'deleted',
};

/** Pure G5 state machine: the target status, or null when `action` is illegal from `from` (`null` = no record yet). */
export function transitionMemory(from: MemoryStatus | null, action: MemoryAction): MemoryStatus | null {
  const t = TRANSITIONS[action];
  return t.from.includes(from) ? t.to : null;
}

/** §5.5 user message for the secret guard. */
const SECRET_MESSAGE = "Provider credentials and secrets don't belong in memory";
/** At most this many suggestions per run (07 G5). */
const MAX_SUGGESTIONS_PER_RUN = 3;
const ALL_ROLES: MemoryRecordScope = { roles: 'all' };

/** Secret guard (§5.5): VALIDATION_FAILED when any text looks like a credential. */
export function guardSecrets(fields: Readonly<Record<string, string | undefined>>): Result<void> {
  const hits = Object.entries(fields).filter(([, v]) => v !== undefined && looksLikeSecret(v));
  if (hits.length === 0) return ok(undefined);
  return err(errors.validationFailed(hits.map(([path]) => ({ path, message: SECRET_MESSAGE, code: 'secret_detected' })), { userMessage: SECRET_MESSAGE }));
}

/** Lowercase, punctuation-insensitive title used for duplicate / conflict detection. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Whether two role scopes share a role (`all` overlaps everything). */
export function scopesOverlap(a: MemoryRecordScope, b: MemoryRecordScope): boolean {
  if (a.roles === 'all' || b.roles === 'all') return true;
  const bs = b.roles;
  return a.roles.some((r) => bs.includes(r));
}

function sameScope(a: MemoryRecordScope, b: MemoryRecordScope): boolean {
  if (a.roles === 'all' || b.roles === 'all') return a.roles === b.roles;
  return [...a.roles].sort().join(',') === [...b.roles].sort().join(',');
}

/** Context of one lifecycle operation (inside the caller's tx). */
export interface MemoryEnv {
  readonly ids: IdGen;
  readonly now: EpochMs;
  /** `user` or `run:<runId>`. */
  readonly actor: string;
}

function illegal(item: MemoryItem, action: MemoryAction): AppError {
  return errors.conflict({ reason: 'invalid_memory_transition', status: item.record.status, action });
}

function getItem(r: Repos, id: MemoryId): Result<MemoryItem> {
  const item = r.memory.get(id);
  return item === undefined ? err(errors.notFound('memory')) : ok(item);
}

/** Applies `action` to the record (CAS on status) and records its event row. */
function moveMemory(r: Repos, env: MemoryEnv, item: MemoryItem, action: MemoryAction, detail?: unknown): Result<MemoryStatus> {
  const from = item.record.status;
  const to = transitionMemory(from, action);
  if (to === null) return err(illegal(item, action));
  if (to !== from && !r.memory.setStatus(item.record.id, [from], to, env.now)) return err(illegal(item, action));
  const current = r.memory.get(item.record.id)?.record.currentRevision ?? item.record.currentRevision;
  r.memory.recordEvent({ recordId: item.record.id, event: EVENT_OF[action], revision: current, actor: env.actor, createdAt: env.now,
    ...(detail === undefined ? {} : { detail }) });
  return ok(to);
}

/** A new record (create / propose / record_summary). */
interface NewRecord {
  readonly projectId: ProjectId;
  readonly type: MemoryType;
  readonly title: string;
  readonly content: string;
  readonly scope: MemoryRecordScope;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly pinned?: boolean | undefined;
  readonly expiresAt?: EpochMs | null | undefined;
  readonly reviewAt?: EpochMs | null | undefined;
  readonly sourceRunId?: RunId | null | undefined;
  readonly proposal?: unknown;
}

/** Inserts a record + revision 1 + its first event. */
function insertMemory(r: Repos, env: MemoryEnv, action: 'create' | 'propose' | 'record_summary', rec: NewRecord): MemoryItem {
  const status = transitionMemory(null, action) ?? 'suggested';
  const item = r.memory.insertRecord(
    { id: env.ids.next('memory'), projectId: rec.projectId, type: rec.type, status, scope: rec.scope, pinned: rec.pinned ?? false,
      expiresAt: rec.expiresAt ?? null, reviewAt: rec.reviewAt ?? null, sourceRunId: rec.sourceRunId ?? null, proposal: rec.proposal, createdAt: env.now },
    { id: env.ids.next('memoryRevision'), title: rec.title, content: rec.content, sourceRefs: rec.sourceRefs, author: env.actor, createdAt: env.now },
  );
  r.memory.recordEvent({ recordId: item.record.id, event: EVENT_OF[action], revision: 1, actor: env.actor, createdAt: env.now });
  return item;
}

function checkRevision(item: MemoryItem, expectedRevision: number): Result<void> {
  return item.record.currentRevision === expectedRevision
    ? ok(undefined)
    : err(errors.conflict({ entity: 'memory', expectedRevision, currentRevision: item.record.currentRevision }));
}

/** Writes a new revision (title/content) when either changed; returns whether one was written. */
function revise(r: Repos, env: MemoryEnv, item: MemoryItem, next: { title: string; content: string }, force: boolean): Result<boolean> {
  const cur = item.current;
  if (!force && next.title === cur.title && next.content === cur.content) return ok(false);
  const added = r.memory.addRevision(item.record.id, { id: env.ids.next('memoryRevision'), title: next.title, content: next.content,
    sourceRefs: cur.sourceRefs, author: env.actor, createdAt: env.now }, item.record.currentRevision);
  return added.ok ? ok(true) : added;
}

/** Approved records of the project with the same normalized title in an overlapping scope (07 G5 conflict detection). */
export function titleConflicts(r: Repos, projectId: ProjectId, title: string, scope: MemoryRecordScope, exclude?: MemoryId): MemoryId[] {
  const norm = normalizeTitle(title);
  return r.memory.list({ projectId, statuses: ['approved'] })
    .filter((x) => x.record.id !== exclude && normalizeTitle(x.current.title) === norm && scopesOverlap(x.record.scope, scope))
    .map((x) => x.record.id);
}

/** CONFLICT for an operation that would leave two approved records in conflict (never silent coexistence, §5.5). */
function memoryConflict(conflictsWith: readonly MemoryId[]): AppError {
  return errors.conflict({ reason: 'memory_conflict', conflictsWith: [...conflictsWith] });
}

const memoryIdSchema = idSchema('memory');

/** The ids a suggestion's `proposal_json.conflictsWith` lists (malformed entries ignored; never trusted blindly). */
function proposalConflictIds(item: MemoryItem): MemoryId[] {
  const p = item.record.proposal;
  if (p === null || typeof p !== 'object') return [];
  const list = (p as Record<string, unknown>)['conflictsWith'];
  return Array.isArray(list) ? list.flatMap((c) => { const id = memoryIdSchema.safeParse(c); return id.success ? [id.data] : []; }) : [];
}

/** The proposal's listed conflicts that are still approved records of the same project (a resolution retires them). */
function liveProposalConflicts(r: Repos, item: MemoryItem): MemoryId[] {
  return proposalConflictIds(item).filter((id) => {
    const other = r.memory.get(id);
    return id !== item.record.id && other?.record.status === 'approved' && other.record.projectId === item.record.projectId;
  });
}

/** `memory.create` (user-authored → approved): CONFLICT with `conflictsWith` when an approved record would conflict. */
export function createRecord(r: Repos, env: MemoryEnv, rec: NewRecord): Result<MemoryItem> {
  const conflictsWith = titleConflicts(r, rec.projectId, rec.title, rec.scope);
  if (conflictsWith.length > 0) return err(memoryConflict(conflictsWith));
  return ok(insertMemory(r, env, 'create', rec));
}

/** `memory.approve`: suggested → approved (optional edits → rev 2). CONFLICT on a stale revision or a title conflict. */
export function approveSuggestion(r: Repos, env: MemoryEnv, i: {
  readonly suggestionId: MemoryId; readonly expectedRevision: number; readonly finalTitle?: string | undefined;
  readonly finalContent?: string | undefined; readonly scope?: MemoryRecordScope | undefined; readonly pinned?: boolean | undefined;
}): Result<MemoryItem> {
  const got = getItem(r, i.suggestionId);
  if (!got.ok) return got;
  const item = got.value;
  if (transitionMemory(item.record.status, 'approve') === null) return err(illegal(item, 'approve'));
  const rev = checkRevision(item, i.expectedRevision);
  if (!rev.ok) return rev;
  const next = { title: i.finalTitle ?? item.current.title, content: i.finalContent ?? item.current.content };
  const guard = guardSecrets({ title: next.title, content: next.content });
  if (!guard.ok) return guard;
  const scope = i.scope ?? item.record.scope;
  // Both the title rule and the proposing model's own `conflictsWith` block a plain approve; memory.resolveConflict
  // is the only way to approve a conflicting suggestion (it retires the other side).
  const conflictsWith = [...new Set([...titleConflicts(r, item.record.projectId, next.title, scope, item.record.id), ...liveProposalConflicts(r, item)])];
  if (conflictsWith.length > 0) return err(memoryConflict(conflictsWith));
  const edited = revise(r, env, item, next, false);
  if (!edited.ok) return edited;
  if (edited.value) r.memory.recordEvent({ recordId: item.record.id, event: 'edited', revision: item.record.currentRevision + 1, actor: env.actor, createdAt: env.now });
  if (i.scope !== undefined || i.pinned !== undefined) r.memory.setAttributes(item.record.id, { scope: i.scope, pinned: i.pinned }, env.now);
  const moved = moveMemory(r, env, item, 'approve');
  return moved.ok ? getItem(r, item.record.id) : moved;
}

/** `memory.update` input (02). */
interface UpdateInput {
  readonly recordId: MemoryId;
  readonly expectedRevision: number;
  readonly title?: string | undefined;
  readonly content?: string | undefined;
  readonly scope?: MemoryRecordScope | undefined;
  readonly expiresAt?: EpochMs | null | undefined;
  readonly reviewAt?: EpochMs | null | undefined;
  readonly pinned?: boolean | undefined;
  readonly unarchive?: true | undefined;
  /** Handled by {@link confirmRecord} (memory-handlers.ts runs it after this update, in the same transaction). */
  readonly confirmCurrent?: true | undefined;
}

/**
 * `memory.update`: approved → approved (rev n+1 when title/content/scope change); archived + `unarchive` → approved.
 * A title/scope change or an unarchive that would leave two approved records in conflict → CONFLICT (`conflictsWith`).
 * A superseded record (retired by memory.resolveConflict) cannot be unarchived → CONFLICT: only an explicit
 * resolution decides between it and its successor.
 */
export function updateRecord(r: Repos, env: MemoryEnv, i: UpdateInput): Result<MemoryItem> {
  const got = getItem(r, i.recordId);
  if (!got.ok) return got;
  const item = got.value;
  const action = i.unarchive === true ? 'unarchive' : 'edit';
  if (transitionMemory(item.record.status, action) === null) return err(illegal(item, action));
  const rev = checkRevision(item, i.expectedRevision);
  if (!rev.ok) return rev;
  const guard = guardSecrets({ title: i.title, content: i.content });
  if (!guard.ok) return guard;
  const superseded = item.record.supersededById;
  if (action === 'unarchive' && superseded !== null) {
    return err(errors.conflict({ reason: 'memory_superseded', supersededById: superseded, conflictsWith: [superseded] }));
  }
  const scopeChanged = i.scope !== undefined && !sameScope(i.scope, item.record.scope);
  const titleChanged = i.title !== undefined && normalizeTitle(i.title) !== normalizeTitle(item.current.title);
  if (action === 'unarchive' || scopeChanged || titleChanged) {
    const conflictsWith = titleConflicts(r, item.record.projectId, i.title ?? item.current.title, i.scope ?? item.record.scope, item.record.id);
    if (conflictsWith.length > 0) return err(memoryConflict(conflictsWith));
  }
  if (action === 'unarchive') {
    const moved = moveMemory(r, env, item, 'unarchive');
    if (!moved.ok) return moved;
  }
  const revised = revise(r, env, item, { title: i.title ?? item.current.title, content: i.content ?? item.current.content }, scopeChanged);
  if (!revised.ok) return revised;
  const attrs = { scope: i.scope, pinned: i.pinned, expiresAt: i.expiresAt, reviewAt: i.reviewAt };
  const attrChanged = Object.values(attrs).some((v) => v !== undefined);
  if (attrChanged) r.memory.setAttributes(item.record.id, attrs, env.now);
  if (revised.value || attrChanged) {
    r.memory.recordEvent({ recordId: item.record.id, event: 'edited', revision: item.record.currentRevision + (revised.value ? 1 : 0), actor: env.actor, createdAt: env.now });
  }
  return getItem(r, item.record.id);
}

/**
 * "Confirm still accurate" (E2 #16): records that the user reviewed an approved record. When the live hashes of its
 * `file` source refs (`freshRefs`, read by the caller) differ from the current revision's, a new revision with the same
 * title / content and the refreshed refs is written (revisions are immutable), which clears `stale`. Always writes a
 * `reviewed` event. `reviewAt` is never touched (a future review date stays; a past one stops being due because the
 * review is newer than it). CONFLICT on a stale `expectedRevision` or a non-approved record.
 */
export function confirmRecord(r: Repos, env: MemoryEnv, recordId: MemoryId, expectedRevision: number,
  freshRefs: readonly Extract<MemorySourceRef, { kind: 'file' }>[]): Result<MemoryItem> {
  const got = getItem(r, recordId);
  if (!got.ok) return got;
  const item = got.value;
  if (transitionMemory(item.record.status, 'edit') === null) return err(illegal(item, 'edit'));
  const rev = checkRevision(item, expectedRevision);
  if (!rev.ok) return rev;
  const fresh = new Map(freshRefs.map((f) => [f.relPath as string, f.sha256]));
  let refreshed = 0;
  const refs = item.current.sourceRefs.map((s): MemorySourceRef => {
    const sha = s.kind === 'file' ? fresh.get(s.relPath) : undefined;
    if (s.kind !== 'file' || sha === undefined || sha === s.sha256) return s;
    refreshed += 1;
    return { ...s, sha256: sha };
  });
  let revision = item.record.currentRevision;
  if (refreshed > 0) {
    const added = r.memory.addRevision(item.record.id, { id: env.ids.next('memoryRevision'), title: item.current.title, content: item.current.content,
      sourceRefs: refs, author: env.actor, createdAt: env.now }, item.record.currentRevision);
    if (!added.ok) return added;
    revision = added.value.revision;
  }
  r.memory.recordEvent({ recordId: item.record.id, event: 'reviewed', revision, actor: env.actor, createdAt: env.now,
    detail: { fileRefs: freshRefs.length, refreshed } });
  return getItem(r, item.record.id);
}

/** E2 #16: a review is due once `reviewAt` has passed and no `reviewed` event is at or after it. Pure. */
export function isReviewDue(reviewAt: EpochMs | null, lastReviewedAt: EpochMs | null | undefined, now: EpochMs): boolean {
  if (reviewAt === null || reviewAt > now) return false;
  return lastReviewedAt === null || lastReviewedAt === undefined || lastReviewedAt < reviewAt;
}

/** Applies a single-record lifecycle action (`memory.reject` / `archive` / `delete`). */
export function applyAction(r: Repos, env: MemoryEnv, id: MemoryId, action: 'reject' | 'archive' | 'delete', detail?: unknown): Result<MemoryItem> {
  const got = getItem(r, id);
  if (!got.ok) return got;
  const moved = moveMemory(r, env, got.value, action, detail);
  return moved.ok ? getItem(r, id) : moved;
}

/** `memory.resolveConflict` resolution (02). */
export type Resolution =
  | { readonly keep: MemoryId }
  | { readonly rewrite: { readonly title: string; readonly content: string; readonly scope: MemoryRecordScope; readonly pinned?: boolean | undefined } }
  | { readonly keepBothWithScopes: readonly [{ readonly recordId: MemoryId; readonly scope: MemoryRecordScope }, { readonly recordId: MemoryId; readonly scope: MemoryRecordScope }] };

function invalid(path: string, message: string, code: string): AppError {
  return errors.validationFailed([{ path, message, code }]);
}

/** Retires the losing side: an approved record is archived and superseded by `winner`; a suggestion is rejected. */
function retire(r: Repos, env: MemoryEnv, item: MemoryItem, winner: MemoryId): Result<void> {
  if (item.record.status === 'suggested') {
    const moved = moveMemory(r, env, item, 'reject', { reason: 'conflict_resolved' });
    return moved.ok ? ok(undefined) : moved;
  }
  const moved = moveMemory(r, env, item, 'archive', { supersededById: winner });
  if (!moved.ok) return moved;
  r.memory.setSupersededBy(item.record.id, winner, env.now);
  return ok(undefined);
}

function approveForResolution(r: Repos, env: MemoryEnv, item: MemoryItem): Result<void> {
  if (item.record.status !== 'suggested') return ok(undefined);
  const guard = guardSecrets({ title: item.current.title, content: item.current.content });
  if (!guard.ok) return guard;
  const moved = moveMemory(r, env, item, 'approve');
  return moved.ok ? ok(undefined) : moved;
}

function resolveKeep(r: Repos, env: MemoryEnv, pair: readonly [MemoryItem, MemoryItem], keep: MemoryId): Result<MemoryId[]> {
  const [kept, other] = pair[0].record.id === keep ? pair : [pair[1], pair[0]];
  const approved = approveForResolution(r, env, kept);
  if (!approved.ok) return approved;
  const retired = retire(r, env, other, kept.record.id);
  return retired.ok ? ok([kept.record.id, other.record.id]) : retired;
}

function resolveRewrite(r: Repos, env: MemoryEnv, pair: readonly [MemoryItem, MemoryItem], rw: Extract<Resolution, { rewrite: unknown }>['rewrite']): Result<MemoryId[]> {
  const guard = guardSecrets({ title: rw.title, content: rw.content });
  if (!guard.ok) return guard;
  const base = pair.find((p) => p.record.status === 'approved') ?? pair[0];
  const created = insertMemory(r, env, 'create', { projectId: base.record.projectId, type: base.record.type, title: rw.title, content: rw.content,
    scope: rw.scope, pinned: rw.pinned, sourceRefs: [] });
  for (const p of pair) {
    const retired = retire(r, env, p, created.record.id);
    if (!retired.ok) return retired;
  }
  return ok([pair[0].record.id, pair[1].record.id, created.record.id]);
}

function resolveBoth(r: Repos, env: MemoryEnv, pair: readonly [MemoryItem, MemoryItem], scopes: Extract<Resolution, { keepBothWithScopes: unknown }>['keepBothWithScopes']): Result<MemoryId[]> {
  if (scopesOverlap(scopes[0].scope, scopes[1].scope)) {
    return err(invalid('resolution.keepBothWithScopes', 'The two scopes must not share a role.', 'scopes_overlap'));
  }
  for (const s of scopes) {
    const item = pair.find((p) => p.record.id === s.recordId);
    if (item === undefined) return err(invalid('resolution.keepBothWithScopes', 'Must list both records.', 'unknown_record'));
    const approved = approveForResolution(r, env, item);
    if (!approved.ok) return approved;
    r.memory.setAttributes(item.record.id, { scope: s.scope }, env.now);
  }
  return ok([pair[0].record.id, pair[1].record.id]);
}

/**
 * `memory.resolveConflict` (07 G5): two approved records, or one suggestion + one approved. Two suggestions →
 * VALIDATION_FAILED; any other status → CONFLICT. Returns the affected record ids (inputs first).
 */
export function resolveConflict(r: Repos, env: MemoryEnv, recordIds: readonly [MemoryId, MemoryId], resolution: Resolution): Result<MemoryId[]> {
  const a = getItem(r, recordIds[0]);
  if (!a.ok) return a;
  const b = getItem(r, recordIds[1]);
  if (!b.ok) return b;
  const pair = [a.value, b.value] as const;
  if (pair[0].record.projectId !== pair[1].record.projectId) return err(invalid('recordIds', 'Both records must belong to the same project.', 'cross_project'));
  const statuses = pair.map((p) => p.record.status);
  if (statuses.every((s) => s === 'suggested')) return err(invalid('recordIds', 'At most one record may be a suggestion.', 'two_suggestions'));
  const bad = pair.find((p) => p.record.status !== 'approved' && p.record.status !== 'suggested');
  if (bad !== undefined) return err(illegal(bad, 'edit'));
  let res: Result<MemoryId[]>;
  if ('keep' in resolution) res = resolveKeep(r, env, pair, resolution.keep);
  else if ('rewrite' in resolution) res = resolveRewrite(r, env, pair, resolution.rewrite);
  else res = resolveBoth(r, env, pair, resolution.keepBothWithScopes);
  if (!res.ok) return res;
  const kind = Object.keys(resolution)[0] ?? 'keep';
  for (const [n, p] of pair.entries()) {
    const other = pair[1 - n]?.record.id;
    r.memory.recordEvent({ recordId: p.record.id, event: 'conflict_resolved', revision: p.record.currentRevision, actor: env.actor, createdAt: env.now,
      detail: { resolution: kind, with: other } });
  }
  return res;
}

// ---------------------------------------------------------------- engine-side operations (MemoryServicePort)

/** Approved, retrievable records of a project for any role (the union of `retrievable` over every role). */
function retrievableForProject(r: Repos, projectId: ProjectId, now: EpochMs): MemoryItem[] {
  const byId = new Map<MemoryId, MemoryItem>();
  for (const role of ROLES) for (const item of r.memory.retrievable(projectId, role, now)) byId.set(item.record.id, item);
  return [...byId.values()].sort((x, y) => (x.record.id < y.record.id ? -1 : 1));
}

/**
 * The records a run snapshots at intake (shared with `runs.preflight`, so the preview IS the selection). Every
 * candidate is approved and retrievable for this project. `includeIds` (= `RunStartInput.memoryRecordIds`):
 * - absent (`null` / `undefined`) → every approved retrievable record (spec §4.5 default context);
 * - `[]` → pinned user_rules only;
 * - a list → pinned user_rules + those records (an id that is not approved + retrievable here → VALIDATION_FAILED).
 */
export function selectRunMemory(r: Repos, projectId: ProjectId, now: EpochMs, includeIds: readonly MemoryId[] | null | undefined): Result<MemoryItem[]> {
  const candidates = retrievableForProject(r, projectId, now);
  const known = new Set(candidates.map((c) => c.record.id));
  const unknown = (includeIds ?? []).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return err(errors.validationFailed(unknown.map((id) => ({ path: 'memoryRecordIds', message: `Memory record ${id} is not approved for this project.`, code: 'memory_not_approved' }))));
  }
  if (includeIds === null || includeIds === undefined) return ok(candidates);
  const wanted = new Set(includeIds);
  return ok(candidates.filter((c) => wanted.has(c.record.id) || isMandatory(c.record)));
}

/** Options of {@link snapshotMemoryForRun}. */
export interface SnapshotMemoryOptions {
  /**
   * Intake (E2 #15): drop ticked records that are no longer approved / retrievable (archived, deleted, expired, …
   * since `runs.start`) instead of failing — a failure here could only pause the run as setup_blocked with no action
   * that fixes it. Each dropped record gets a `skipped` memory event (detail `{ runId }`) and is returned.
   */
  readonly dropUnavailable?: boolean;
  /** Actor of the `skipped` events (`run:<id>`). */
  readonly actor?: string;
}

/**
 * Intake: copies the {@link selectRunMemory} records into `run_memory_snapshot` with their current revision AND their
 * attributes (type, pinned, role scope) as of now, so later edits never reach this run's context or manifest.
 * Idempotent: a retried intake keeps the first snapshot. Returns the ids dropped under `dropUnavailable`.
 */
export function snapshotMemoryForRun(r: Repos, runId: RunId, projectId: ProjectId, now: EpochMs, includeIds?: readonly MemoryId[] | null,
  o: SnapshotMemoryOptions = {}): Result<{ readonly skipped: readonly MemoryId[] }> {
  if (r.memory.runSnapshot(runId).length > 0) return ok({ skipped: [] });
  let wanted = includeIds;
  let skipped: MemoryId[] = [];
  if (o.dropUnavailable === true && includeIds !== null && includeIds !== undefined) {
    const known = new Set(retrievableForProject(r, projectId, now).map((c) => c.record.id));
    skipped = includeIds.filter((id) => !known.has(id));
    wanted = includeIds.filter((id) => known.has(id));
  }
  const selected = selectRunMemory(r, projectId, now, wanted);
  if (!selected.ok) return selected;
  const rows = selected.value.map((c) => ({ recordId: c.record.id, revision: c.current.revision, title: c.current.title, content: c.current.content,
    type: c.record.type, pinned: c.record.pinned, scope: c.record.scope, included: true }));
  if (rows.length > 0) r.memory.snapshotForRun(runId, rows);
  for (const id of skipped) {
    const item = r.memory.get(id);
    if (item === undefined) continue; // never existed: nothing to attach an event to
    r.memory.recordEvent({ recordId: id, event: 'skipped', revision: item.record.currentRevision, actor: o.actor ?? `run:${runId}`, createdAt: now,
      detail: { runId, status: item.record.status } });
  }
  return ok({ skipped });
}

/** One memory candidate from a run's outputs. */
export interface Proposal {
  readonly type: 'user_rule' | 'project_decision';
  readonly title: string;
  readonly content: string;
  readonly rationale: string;
  readonly conflictsWith: readonly string[];
  readonly artifactId: ArtifactId;
  readonly sourceRefs: readonly SourceRef[];
}

/** A kept proposal plus the approved records it conflicts with (same normalized title, different content). */
interface ChosenProposal extends Proposal {
  readonly detectedConflicts: readonly MemoryId[];
}

/** A path-like token (`src/lib/validate.ts`, `./a/b`): only its last segment is kept for duplicate detection. */
const PATH_TOKEN = /[\w.@~-]*(?:\/[\w.@~-]+)+/g;

function stripPathQualifiers(text: string): string {
  return text.replace(PATH_TOKEN, (m) => m.slice(m.lastIndexOf('/') + 1));
}

/** Duplicate key of a title: normalized, path qualifiers dropped ("src/lib/validate.ts" ≡ "validate.ts"). */
export function proposalTitleKey(title: string): string {
  return normalizeTitle(stripPathQualifiers(title));
}

/** Duplicate key of content: case- and whitespace-insensitive, path qualifiers and trailing punctuation dropped. */
export function proposalContentKey(content: string): string {
  return stripPathQualifiers(content).toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!;:,\s]+$/, '');
}

async function collectProposals(deps: MemoryServiceDeps, run: RunRow): Promise<Proposal[]> {
  const r = deps.db.repos;
  const out: Proposal[] = [];
  const reviewStep = latestOutputStep(r, run, 'review.v1');
  const review = reviewStep === undefined ? null : await readOutput(deps, reviewStep, 'review.v1');
  if (review !== null) {
    for (const p of review.value.memoryProposals) out.push({ ...p, artifactId: review.artifactId, sourceRefs: review.value.sourceRefs });
  }
  const planStep = latestOutputStep(r, run, 'plan.v1');
  const plan = planStep === undefined ? null : await readOutput(deps, planStep, 'plan.v1');
  if (plan !== null) {
    for (const d of plan.value.decisions) {
      out.push({ type: 'project_decision', title: d.title, content: d.content, rationale: 'Recorded by the planner as a lasting project decision.',
        conflictsWith: [], artifactId: plan.artifactId, sourceRefs: plan.value.sourceRefs });
    }
  }
  return out;
}

/** Why {@link chooseProposals} skipped a proposal. */
type ProposalSkipReason = 'invalid' | 'secret_detected' | 'duplicate';

/**
 * Keeps valid, secret-free, non-duplicate proposals (≤ 3). Pure. A duplicate has the same title key AND
 * near-identical content ({@link proposalTitleKey} / {@link proposalContentKey}) as an existing suggestion/approved
 * record or an earlier proposal of this run. A proposal with the same normalized title as an approved record but
 * different content is KEPT and carries that record in `detectedConflicts` (surfaced as `proposal.conflictsWith`),
 * never silently dropped.
 */
export function chooseProposals<P extends Proposal>(existing: readonly MemoryItem[], proposals: readonly P[]): {
  readonly chosen: (P & { readonly detectedConflicts: readonly MemoryId[] })[];
  readonly skipped: readonly ProposalSkipReason[];
} {
  const live = existing.filter((x) => x.record.status === 'suggested' || x.record.status === 'approved');
  const seen = live.map((x) => ({ titleKey: proposalTitleKey(x.current.title), contentKey: proposalContentKey(x.current.content) }));
  const chosen: (P & { readonly detectedConflicts: readonly MemoryId[] })[] = [];
  const skipped: ProposalSkipReason[] = [];
  for (const p of proposals) {
    if (chosen.length === MAX_SUGGESTIONS_PER_RUN) break;
    const valid = memoryTitleSchema.safeParse(p.title).success && memoryContentSchema.safeParse(p.content).success;
    const secret = looksLikeSecret(p.title) || looksLikeSecret(p.content) || looksLikeSecret(p.rationale);
    const key = { titleKey: proposalTitleKey(p.title), contentKey: proposalContentKey(p.content) };
    if (!valid || secret || seen.some((k) => k.titleKey === key.titleKey && k.contentKey === key.contentKey)) {
      skipped.push(!valid ? 'invalid' : secret ? 'secret_detected' : 'duplicate');
      continue;
    }
    const norm = normalizeTitle(p.title);
    const detectedConflicts = live.filter((x) => x.record.status === 'approved' && normalizeTitle(x.current.title) === norm).map((x) => x.record.id);
    seen.push(key);
    chosen.push({ ...p, detectedConflicts });
  }
  return { chosen, skipped };
}

function selectProposals(deps: MemoryServiceDeps, run: RunRow, proposals: readonly Proposal[]): ChosenProposal[] {
  const { chosen, skipped } = chooseProposals(deps.db.repos.memory.list({ projectId: run.projectId, statuses: ['suggested', 'approved'] }), proposals);
  for (const reason of skipped) deps.logger.warn('memory.proposal_skipped', { runId: run.id, reason });
  return chosen;
}

/** Finalize: ≤ 3 suggestions from review.v1 memoryProposals + plan.v1 decisions; never auto-approved. Idempotent. */
async function proposeFromRun(deps: MemoryServiceDeps, runId: RunId): Promise<Result<void>> {
  const r = deps.db.repos;
  const run = r.runs.get(runId);
  const own = r.memory.list({ projectId: run.projectId, sourceRunId: runId }).filter((x) => x.record.type !== 'run_summary');
  if (own.length > 0) return ok(undefined);
  const chosen = selectProposals(deps, run, await collectProposals(deps, run));
  if (chosen.length === 0) return ok(undefined);
  const env: MemoryEnv = { ids: deps.ids, now: deps.clock.now(), actor: `run:${runId}` };
  const event = deps.db.tx('immediate', (tx) => {
    const approved = new Set<string>(tx.memory.list({ projectId: run.projectId, statuses: ['approved'] }).map((x) => x.record.id));
    const ids = chosen.map((p) => insertMemory(tx, env, 'propose', {
      projectId: run.projectId, type: p.type, title: p.title, content: p.content, scope: ALL_ROLES, sourceRunId: runId,
      sourceRefs: [{ kind: 'run', runId, artifactId: p.artifactId }],
      proposal: { rationale: p.rationale, sourceRefs: p.sourceRefs.slice(0, 10), suggestedScope: ALL_ROLES,
        conflictsWith: [...new Set([...p.conflictsWith, ...p.detectedConflicts])].filter((c) => approved.has(c)) },
    }).record.id);
    return tx.events.append(runId, 'memory.suggested', redactDeep({ recordIds: ids, count: ids.length }));
  });
  deps.emit?.({ type: 'run.event', event });
  deps.emit?.({ type: 'memory.changed', projectId: run.projectId });
  return ok(undefined);
}

/** Deterministic run-summary text from typed data (goal, outcome, verdict, fileScope). */
export function runSummaryText(i: { readonly goal: string; readonly verdict: string | null; readonly fileScope: readonly string[] }): { title: string; content: string } {
  const outcome = i.verdict === 'revise' || i.verdict === 'incomplete' ? 'incomplete' : 'completed';
  const goal = i.goal.replace(/\s+/g, ' ').trim();
  const title = `Run summary: ${goal}`.slice(0, 120).trimEnd();
  const content = [`Goal: ${goal}`, `Outcome: ${outcome}`, `Verdict: ${i.verdict ?? 'none'}`, `File scope: ${i.fileScope.length === 0 ? 'none' : i.fileScope.join(', ')}`]
    .join('\n').slice(0, 4000);
  return { title, content };
}

/** Finalize: one approved run_summary (author `run:<id>`), idempotent; a summary that looks like a secret is skipped. */
async function recordRunSummary(deps: MemoryServiceDeps, runId: RunId): Promise<Result<void>> {
  const r = deps.db.repos;
  const run = r.runs.get(runId);
  if (r.memory.list({ projectId: run.projectId, types: ['run_summary'], sourceRunId: runId }).length > 0) return ok(undefined);
  const verdict = latestOutputStep(r, run, 'review.v1')?.outcome ?? null;
  const planStep = latestOutputStep(r, run, 'plan.v1');
  const plan = planStep === undefined ? null : await readOutput(deps, planStep, 'plan.v1');
  const fileScope = plan?.value.fileScope ?? [];
  const text = runSummaryText({ goal: run.goal, verdict, fileScope });
  if (looksLikeSecret(text.title) || looksLikeSecret(text.content)) {
    deps.logger.warn('memory.run_summary_skipped', { runId, reason: 'secret_detected' });
    return ok(undefined);
  }
  const inScope = new Set(fileScope);
  const files: MemorySourceRef[] = r.runs.inputFiles(runId).filter((f) => inScope.has(f.relPath)).map((f) => ({ kind: 'file', relPath: f.relPath, sha256: f.sha256 }));
  const env: MemoryEnv = { ids: deps.ids, now: deps.clock.now(), actor: `run:${runId}` };
  deps.db.tx('immediate', (tx) => insertMemory(tx, env, 'record_summary', {
    projectId: run.projectId, type: 'run_summary', ...text, scope: ALL_ROLES, sourceRunId: runId,
    sourceRefs: [...files, { kind: 'run', runId, artifactId: plan?.artifactId ?? null }],
  }));
  deps.emit?.({ type: 'memory.changed', projectId: run.projectId });
  return ok(undefined);
}

/** Creates the memory service (07 G5). */
export function createMemoryService(deps: MemoryServiceDeps): MemoryServicePort {
  return {
    snapshotForRun: (runId, projectId, o) => {
      const res = deps.db.txResult('immediate', (tx) => snapshotMemoryForRun(tx, runId, projectId, deps.clock.now(), o.includeIds, { dropUnavailable: true }));
      if (!res.ok) return res;
      for (const recordId of res.value.skipped) deps.logger.warn('memory_record_skipped', { runId, recordId, reason: 'not_approved' });
      if (res.value.skipped.length > 0) deps.emit?.({ type: 'memory.changed', projectId });
      return ok(undefined);
    },
    proposeFromRun: (runId) => proposeFromRun(deps, runId),
    recordRunSummary: (runId) => recordRunSummary(deps, runId),
  };
}
