// 07 G5: memory service (§10.4 lifecycle, §4.5, §5.5). The status state machine is the pure `transitionMemory`; the
// lifecycle operations below run inside the caller's transaction (memory-handlers.ts wraps them for the memory.* IPC
// ops). Suggestions never enter context: only approved records are snapshotted (`retrievable`, §10.1), and resolving a
// conflict never leaves a suggestion in `suggested`. The service never auto-merges (§5.5).
import { err, errors, looksLikeSecret, memoryContentSchema, memoryTitleSchema, ok, redactDeep, ROLES } from '@relay/contracts';
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
import type { Logger, MemoryServicePort } from './ports.js';

/** Dependencies of the memory service. */
export interface MemoryServiceDeps {
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
export const SECRET_MESSAGE = "Provider credentials and secrets don't belong in memory";
/** At most this many suggestions per run (07 G5). */
export const MAX_SUGGESTIONS_PER_RUN = 3;
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
export function moveMemory(r: Repos, env: MemoryEnv, item: MemoryItem, action: MemoryAction, detail?: unknown): Result<MemoryStatus> {
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
export interface NewRecord {
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
export function insertMemory(r: Repos, env: MemoryEnv, action: 'create' | 'propose' | 'record_summary', rec: NewRecord): MemoryItem {
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
export function titleConflicts(r: Repos, projectId: ProjectId, title: string, scope: MemoryRecordScope, exclude: MemoryId): MemoryId[] {
  const norm = normalizeTitle(title);
  return r.memory.list({ projectId, statuses: ['approved'] })
    .filter((x) => x.record.id !== exclude && normalizeTitle(x.current.title) === norm && scopesOverlap(x.record.scope, scope))
    .map((x) => x.record.id);
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
  const conflictsWith = titleConflicts(r, item.record.projectId, next.title, scope, item.record.id);
  if (conflictsWith.length > 0) return err(errors.conflict({ reason: 'memory_conflict', conflictsWith }));
  const edited = revise(r, env, item, next, false);
  if (!edited.ok) return edited;
  if (edited.value) r.memory.recordEvent({ recordId: item.record.id, event: 'edited', revision: item.record.currentRevision + 1, actor: env.actor, createdAt: env.now });
  if (i.scope !== undefined || i.pinned !== undefined) r.memory.setAttributes(item.record.id, { scope: i.scope, pinned: i.pinned }, env.now);
  const moved = moveMemory(r, env, item, 'approve');
  return moved.ok ? getItem(r, item.record.id) : moved;
}

/** `memory.update` input (02). */
export interface UpdateInput {
  readonly recordId: MemoryId;
  readonly expectedRevision: number;
  readonly title?: string | undefined;
  readonly content?: string | undefined;
  readonly scope?: MemoryRecordScope | undefined;
  readonly expiresAt?: EpochMs | null | undefined;
  readonly reviewAt?: EpochMs | null | undefined;
  readonly pinned?: boolean | undefined;
  readonly unarchive?: true | undefined;
}

/** `memory.update`: approved → approved (rev n+1 when title/content/scope change); archived + `unarchive` → approved. */
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
  if (action === 'unarchive') {
    const moved = moveMemory(r, env, item, 'unarchive');
    if (!moved.ok) return moved;
  }
  const scopeChanged = i.scope !== undefined && !sameScope(i.scope, item.record.scope);
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
 * Intake: copies approved, retrievable records with their current revision into `run_memory_snapshot`. Pinned
 * user_rules are always included; a non-empty `includeIds` limits the others (an id that is not approved + retrievable for this
 * project → VALIDATION_FAILED). Idempotent: a retried intake keeps the first snapshot.
 */
export function snapshotMemoryForRun(r: Repos, runId: RunId, projectId: ProjectId, now: EpochMs, includeIds?: readonly MemoryId[]): Result<void> {
  if (r.memory.runSnapshot(runId).length > 0) return ok(undefined);
  const candidates = retrievableForProject(r, projectId, now);
  const known = new Set(candidates.map((c) => c.record.id));
  const unknown = (includeIds ?? []).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return err(errors.validationFailed(unknown.map((id) => ({ path: 'memoryRecordIds', message: `Memory record ${id} is not approved for this project.`, code: 'memory_not_approved' }))));
  }
  // The run snapshot stores `memoryRecordIds ?? []`, so an empty list means "not given" (every approved record).
  const wanted = includeIds === undefined || includeIds.length === 0 ? null : new Set(includeIds);
  const rows = candidates
    .filter((c) => wanted === null || wanted.has(c.record.id) || (c.record.pinned && c.record.type === 'user_rule'))
    .map((c) => ({ recordId: c.record.id, revision: c.current.revision, title: c.current.title, content: c.current.content, included: true }));
  if (rows.length > 0) r.memory.snapshotForRun(runId, rows);
  return ok(undefined);
}

/** One memory candidate from a run's outputs. */
interface Proposal {
  readonly type: 'user_rule' | 'project_decision';
  readonly title: string;
  readonly content: string;
  readonly rationale: string;
  readonly conflictsWith: readonly string[];
  readonly artifactId: ArtifactId;
  readonly sourceRefs: readonly SourceRef[];
}

async function collectProposals(deps: MemoryServiceDeps, run: RunRow): Promise<Proposal[]> {
  const r = deps.db.repos;
  const out: Proposal[] = [];
  const reviewStep = latestOutputStep(r, run, 'review.v1');
  const review = reviewStep === undefined ? null : await readOutput(deps, reviewStep, 'review.v1');
  for (const p of review?.value.memoryProposals ?? []) {
    out.push({ ...p, artifactId: review?.artifactId ?? ('' as ArtifactId), sourceRefs: review?.value.sourceRefs ?? [] });
  }
  const planStep = latestOutputStep(r, run, 'plan.v1');
  const plan = planStep === undefined ? null : await readOutput(deps, planStep, 'plan.v1');
  for (const d of plan?.value.decisions ?? []) {
    out.push({ type: 'project_decision', title: d.title, content: d.content, rationale: 'Recorded by the planner as a lasting project decision.',
      conflictsWith: [], artifactId: plan?.artifactId ?? ('' as ArtifactId), sourceRefs: plan?.value.sourceRefs ?? [] });
  }
  return out;
}

/** Keeps valid, secret-free, non-duplicate proposals (≤ 3). */
function selectProposals(deps: MemoryServiceDeps, run: RunRow, proposals: readonly Proposal[]): Proposal[] {
  const seen = new Set(deps.db.repos.memory.list({ projectId: run.projectId, statuses: ['suggested', 'approved'] }).map((x) => normalizeTitle(x.current.title)));
  const out: Proposal[] = [];
  for (const p of proposals) {
    const valid = memoryTitleSchema.safeParse(p.title).success && memoryContentSchema.safeParse(p.content).success;
    const secret = looksLikeSecret(p.title) || looksLikeSecret(p.content) || looksLikeSecret(p.rationale);
    const norm = normalizeTitle(p.title);
    if (!valid || secret || seen.has(norm)) {
      deps.logger.warn('memory.proposal_skipped', { runId: run.id, reason: !valid ? 'invalid' : secret ? 'secret_detected' : 'duplicate' });
      continue;
    }
    seen.add(norm);
    out.push(p);
    if (out.length === MAX_SUGGESTIONS_PER_RUN) break;
  }
  return out;
}

/** Finalize: ≤ 3 suggestions from review.v1 memoryProposals + plan.v1 decisions; never auto-approved. Idempotent. */
async function proposeFromRun(deps: MemoryServiceDeps, runId: RunId): Promise<Result<void>> {
  const r = deps.db.repos;
  const run = r.runs.get(runId);
  const own = r.memory.list({ projectId: run.projectId }).filter((x) => x.record.sourceRunId === runId && x.record.type !== 'run_summary');
  if (own.length > 0) return ok(undefined);
  const chosen = selectProposals(deps, run, await collectProposals(deps, run));
  if (chosen.length === 0) return ok(undefined);
  const env: MemoryEnv = { ids: deps.ids, now: deps.clock.now(), actor: `run:${runId}` };
  const event = deps.db.tx('immediate', (tx) => {
    const approved = new Set<string>(tx.memory.list({ projectId: run.projectId, statuses: ['approved'] }).map((x) => x.record.id));
    const ids = chosen.map((p) => insertMemory(tx, env, 'propose', {
      projectId: run.projectId, type: p.type, title: p.title, content: p.content, scope: ALL_ROLES, sourceRunId: runId,
      sourceRefs: [{ kind: 'run', runId, artifactId: p.artifactId }],
      proposal: { rationale: p.rationale, sourceRefs: p.sourceRefs.slice(0, 10), suggestedScope: ALL_ROLES, conflictsWith: p.conflictsWith.filter((c) => approved.has(c)) },
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
  if (r.memory.list({ projectId: run.projectId, types: ['run_summary'] }).some((x) => x.record.sourceRunId === runId)) return ok(undefined);
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
    snapshotForRun: (runId, projectId, o) =>
      deps.db.tx('immediate', (tx) => snapshotMemoryForRun(tx, runId, projectId, deps.clock.now(), o.includeIds)),
    proposeFromRun: (runId) => proposeFromRun(deps, runId),
    recordRunSummary: (runId) => recordRunSummary(deps, runId),
  };
}
