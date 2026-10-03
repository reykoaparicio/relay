// 07 G5 / 02 memory ops: the memory.* runner handlers. Writes run in one immediate transaction through the lifecycle
// functions of memory.ts (pure state machine + secret guard); views add the live-file stale flag (§10.5 "Source
// changed") and the suggestion's conflicts. Every successful write emits `memory.changed` for the project.
import { err, errors, idSchema, ok, sourceRefSchema } from '@relay/contracts';
import type {
  EpochMs,
  MemoryId,
  MemoryRecordDetail,
  MemoryRecordScope,
  MemoryRecordView,
  MemorySource,
  MemorySourceRef,
  ProjectId,
  Result,
  RunnerChannel,
  RunnerOutputOf,
  Sha256,
} from '@relay/contracts';
import type { MemoryItem, Repos } from '@relay/storage';
import { requestHash } from './hash.js';
import type { IdempotentRequest } from './idempotency.js';
import { recordResult, replayId, replayStoredId, storedResult } from './idempotency.js';
import { applyAction, approveSuggestion, confirmRecord, createRecord, guardSecrets, isReviewDue, resolveConflict as resolveMemoryConflict, updateRecord } from './memory.js';
import type { MemoryEnv } from './memory.js';
import type { ParsedInputOf } from './handler-types.js';
import type { EngineCtx } from './ports.js';

type Out<C extends RunnerChannel> = Promise<Result<RunnerOutputOf<C>>>;

/** Excerpt length of a list row. */
const EXCERPT_CHARS = 160;
const memoryIdSchema = idSchema('memory');

function userEnv(ctx: Pick<EngineCtx, 'ids' | 'clock'>): MemoryEnv {
  return { ids: ctx.ids, now: ctx.clock.now(), actor: 'user' };
}

function changed(ctx: EngineCtx, projectId: ProjectId): void {
  ctx.emit({ type: 'memory.changed', projectId });
}

function excerpt(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS - 1)}…`;
}

function fileRefs(item: MemoryItem): Extract<MemorySourceRef, { kind: 'file' }>[] {
  return item.current.sourceRefs.flatMap((s) => (s.kind === 'file' ? [s] : []));
}

function sourceOf(item: MemoryItem): MemorySource {
  const runRef = item.current.sourceRefs.find((s) => s.kind === 'run');
  if (item.record.sourceRunId !== null) {
    const artifactId = runRef?.kind === 'run' ? runRef.artifactId : null;
    return { kind: 'run', runId: item.record.sourceRunId, ...(artifactId === null ? {} : { artifactId }) };
  }
  const file = fileRefs(item)[0];
  return file === undefined ? { kind: 'user' } : { kind: 'file', relPath: file.relPath };
}

/** Proposal source refs shown to the renderer (E2 #17): only well-formed entries, at most 10. */
const PROPOSAL_SOURCE_REFS_MAX = 10;

/** The suggestion's proposal (`proposal_json`), tolerant of malformed JSON (never trusted blindly, 00b §4). */
function proposalOf(item: MemoryItem): MemoryRecordDetail['proposal'] {
  const p = item.record.proposal;
  if (p === null || typeof p !== 'object') return undefined;
  const v = p as Record<string, unknown>;
  const scope = v['suggestedScope'] as MemoryRecordScope | undefined;
  const refs = Array.isArray(v['sourceRefs']) ? v['sourceRefs'].flatMap((x) => { const r = sourceRefSchema.safeParse(x); return r.success ? [r.data] : []; }) : [];
  return {
    rationale: typeof v['rationale'] === 'string' ? v['rationale'] : '',
    suggestedScope: scope !== undefined && (scope.roles === 'all' || Array.isArray(scope.roles)) ? scope : { roles: 'all' },
    conflictsWith: Array.isArray(v['conflictsWith']) ? v['conflictsWith'].flatMap((c) => (memoryIdSchema.safeParse(c).success ? [c as MemoryId] : [])) : [],
    sourceRefs: refs.slice(0, PROPOSAL_SOURCE_REFS_MAX),
  };
}

/** Records whose `file` source refs no longer match the live file (null root → every record with refs is stale). */
async function staleIds(ctx: EngineCtx, projectId: ProjectId, items: readonly MemoryItem[]): Promise<Set<MemoryId>> {
  const refs = items.flatMap((i) => fileRefs(i).map((f) => ({ id: i.record.id, relPath: f.relPath, sha256: f.sha256 })));
  if (refs.length === 0) return new Set();
  const project = ctx.db.repos.projects.find(projectId);
  const root = project === undefined ? null : await ctx.projectFs.openRoot(ctx.db.repos.projects.getWithRoot(projectId).rootRealpath);
  const live = root?.ok === true ? await ctx.projectFs.hashFiles(root.value, [...new Set(refs.map((r) => r.relPath))]) : null;
  const byPath = new Map<string, Sha256 | null>(live?.ok === true ? live.value.map((h) => [h.relPath, h.sha256]) : []);
  return new Set(refs.filter((r) => byPath.get(r.relPath) !== r.sha256).map((r) => r.id));
}

function toView(item: MemoryItem, stale: boolean, lastReviewedAt: EpochMs | null, now: EpochMs): MemoryRecordView {
  const rec = item.record;
  return {
    id: rec.id, projectId: rec.projectId, type: rec.type, status: rec.status, title: item.current.title, excerpt: excerpt(item.current.content),
    scope: rec.scope, pinned: rec.pinned, currentRevision: rec.currentRevision, source: sourceOf(item), createdAt: rec.createdAt, updatedAt: rec.updatedAt,
    expiresAt: rec.expiresAt, reviewAt: rec.reviewAt, supersededById: rec.supersededById, stale, conflictsWith: proposalOf(item)?.conflictsWith ?? [],
    // E2 #16: due is decided by the last `reviewed` event, not `updatedAt` (an unrelated edit no longer hides it).
    lastReviewedAt, reviewDue: rec.status === 'approved' && isReviewDue(rec.reviewAt, lastReviewedAt, now),
  };
}

async function views(ctx: EngineCtx, items: readonly MemoryItem[]): Promise<MemoryRecordView[]> {
  const first = items[0];
  if (first === undefined) return [];
  const stale = await staleIds(ctx, first.record.projectId, items);
  const reviewed = ctx.db.repos.memory.lastEventAt(items.map((i) => i.record.id), 'reviewed'); // one statement
  const now = ctx.clock.now();
  return items.map((i) => toView(i, stale.has(i.record.id), reviewed.get(i.record.id) ?? null, now));
}

async function detail(ctx: EngineCtx, id: MemoryId): Promise<Result<MemoryRecordDetail>> {
  const r = ctx.db.repos;
  const got = r.memory.getWithRevisions(id);
  if (got === undefined) return err(errors.notFound('memory'));
  const [view] = await views(ctx, [got.item]);
  if (view === undefined) return err(errors.notFound('memory'));
  const proposal = got.item.record.status === 'suggested' || got.item.record.sourceRunId !== null ? proposalOf(got.item) : undefined;
  const usage = r.memory.countRunSnapshotsByRevision(id);
  return ok({
    ...view,
    content: got.item.current.content,
    revisions: got.revisions.map((v) => ({ revision: v.revision, title: v.title, content: v.content, author: v.author, createdAt: v.createdAt, sourceRefs: [...v.sourceRefs],
      usedByRuns: usage.get(v.revision) ?? 0 })),
    // E2 #17: the stored detail is the audit trail (who superseded whom, why rejected, which run skipped it, …).
    events: got.events.map((e) => ({ event: e.event, revision: Math.max(1, e.revision), actor: e.actor, createdAt: e.createdAt, detail: eventDetail(e.detail) })),
    usedByRuns: r.memory.countRunSnapshots(id),
    ...(proposal === undefined ? {} : { proposal }),
  });
}

/** A stored event detail as a plain JSON object for the renderer (anything else → null). */
function eventDetail(detail: unknown): Record<string, unknown> | null {
  return typeof detail === 'object' && detail !== null && !Array.isArray(detail) ? { ...(detail as Record<string, unknown>) } : null;
}

/** Runs a lifecycle write in one transaction (rolled back on an error result), then emits `memory.changed` and returns the record detail. */
async function write(ctx: EngineCtx, f: (r: Repos, env: MemoryEnv) => Result<MemoryItem>): Promise<Result<MemoryRecordDetail>> {
  const res = ctx.db.txResult('immediate', (r) => f(r, userEnv(ctx)));
  if (!res.ok) return res;
  changed(ctx, res.value.record.projectId);
  return detail(ctx, res.value.record.id);
}

// ---------------------------------------------------------------- handlers

/** `memory.list`: project-scoped (§10.5), optional status/type/text filters. */
export async function list(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/memory.list'>): Out<'relay/v1/memory.list'> {
  const items = ctx.db.repos.memory.list({ projectId: input.projectId, statuses: input.status, types: input.type, query: input.query });
  return ok(await views(ctx, items));
}

/** `memory.get`: the record with all revisions, events, and usage. */
export function get(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/memory.get'>): Out<'relay/v1/memory.get'> {
  return detail(ctx, input.recordId);
}

/** Reads `relPath` path-confined (05 E4) and returns its `file` source ref (`source_reference`, §10.1). */
async function sourceFileRef(ctx: EngineCtx, projectId: ProjectId, relPath: string): Promise<Result<MemorySourceRef>> {
  const project = ctx.db.repos.projects.find(projectId);
  if (project === undefined) return err(errors.notFound('project'));
  const root = await ctx.projectFs.openRoot(ctx.db.repos.projects.getWithRoot(projectId).rootRealpath);
  if (!root.ok) return root;
  const read = await ctx.projectFs.readSelected(root.value, [relPath], { exclusions: project.exclusions });
  if (!read.ok) return read;
  const file = read.value.files[0];
  return file === undefined ? err(errors.notFound('file')) : ok({ kind: 'file', relPath: file.relPath, sha256: file.sha256 });
}

const CREATE_OP = 'memory.create';

function replayCreate(ctx: EngineCtx, r: Repos, req: IdempotentRequest): Result<MemoryId> | null {
  const stored = replayStoredId(ctx, r, req, 'recordId', 'memory');
  return stored === null || !stored.ok ? stored : ok(stored.value.id);
}

/**
 * `memory.create`: user-authored → approved immediately (author `user`, §10.1). Secrets rejected (§5.5). A record that
 * would conflict with an approved one (same normalized title, overlapping scope) → CONFLICT `conflictsWith`. Idempotent.
 */
export async function create(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/memory.create'>): Out<'relay/v1/memory.create'> {
  const req: IdempotentRequest = { op: CREATE_OP, key: input.idempotencyKey, hash: requestHash({ ...input }) };
  const early = replayCreate(ctx, ctx.db.repos, req);
  if (early !== null) return early.ok ? detail(ctx, early.value) : early;
  const guard = guardSecrets({ title: input.title, content: input.content });
  if (!guard.ok) return guard;
  if (ctx.db.repos.projects.find(input.projectId) === undefined) return err(errors.notFound('project'));
  const refs: MemorySourceRef[] = [];
  if (input.sourceFile !== undefined) {
    const ref = await sourceFileRef(ctx, input.projectId, input.sourceFile.relPath);
    if (!ref.ok) return ref;
    refs.push(ref.value);
  }
  const res = ctx.db.txResult('immediate', (r): Result<MemoryId> => {
    const again = replayCreate(ctx, r, req);
    if (again !== null) return again;
    const item = createRecord(r, userEnv(ctx), { projectId: input.projectId, type: input.type, title: input.title, content: input.content,
      scope: input.scope, pinned: input.pinned, expiresAt: input.expiresAt, reviewAt: input.reviewAt, sourceRefs: refs });
    if (!item.ok) return item;
    recordResult(r, req, { ids: { recordId: item.value.record.id } });
    return ok(item.value.record.id);
  });
  if (!res.ok) return res;
  changed(ctx, input.projectId);
  return detail(ctx, res.value);
}

/** Fresh `file` source refs of a record, re-hashed through the confined reader (E2 #16). */
async function freshFileRefs(ctx: EngineCtx, item: MemoryItem): Promise<Result<Extract<MemorySourceRef, { kind: 'file' }>[]>> {
  const out: Extract<MemorySourceRef, { kind: 'file' }>[] = [];
  for (const f of fileRefs(item)) {
    const ref = await sourceFileRef(ctx, item.record.projectId, f.relPath);
    if (!ref.ok) return ref;
    if (ref.value.kind === 'file') out.push(ref.value);
  }
  return ok(out);
}

/**
 * `memory.update` (expectedRevision CAS; `unarchive`, `reviewAt`, `pinned`, scope, title/content). With
 * `confirmCurrent` (E2 #16) the file source refs are re-hashed first, then the update and the confirmation (new
 * revision only when a hash changed + `reviewed` event) commit in ONE transaction.
 */
export async function update(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/memory.update'>): Out<'relay/v1/memory.update'> {
  if (input.confirmCurrent !== true) return write(ctx, (r, env) => updateRecord(r, env, input));
  const item = ctx.db.repos.memory.get(input.recordId);
  if (item === undefined) return err(errors.notFound('memory'));
  const fresh = await freshFileRefs(ctx, item);
  if (!fresh.ok) return fresh;
  return write(ctx, (r, env) => {
    const updated = updateRecord(r, env, input);
    if (!updated.ok) return updated;
    return confirmRecord(r, env, input.recordId, updated.value.record.currentRevision, fresh.value);
  });
}

/** `memory.approve`: suggested → approved (optional edits). */
export function approve(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/memory.approve'>): Out<'relay/v1/memory.approve'> {
  return write(ctx, (r, env) => approveSuggestion(r, env, input));
}

/** `memory.reject`: suggested → rejected. */
export async function reject(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/memory.reject'>): Out<'relay/v1/memory.reject'> {
  const res = await write(ctx, (r, env) => applyAction(r, env, input.suggestionId, 'reject', input.reason === undefined ? undefined : { reason: input.reason }));
  return res.ok ? ok({ status: 'rejected' as const }) : res;
}

/** `memory.archive`: approved → archived. */
export function archive(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/memory.archive'>): Out<'relay/v1/memory.archive'> {
  return write(ctx, (r, env) => applyAction(r, env, input.recordId, 'archive'));
}

/** `memory.delete`: approved/archived → deleted; run snapshots keep their copies (§10.4 consequences). */
export function remove(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/memory.delete'>): Out<'relay/v1/memory.delete'> {
  const res = ctx.db.txResult('immediate', (r) => applyAction(r, userEnv(ctx), input.recordId, 'delete'));
  if (!res.ok) return Promise.resolve(res);
  changed(ctx, res.value.record.projectId);
  return Promise.resolve(ok({ deleted: true as const, retainedInRunSnapshots: ctx.db.repos.memory.countRunSnapshots(input.recordId) }));
}

const RESOLVE_OP = 'memory.resolveConflict';

function replayResolve(ctx: EngineCtx, r: Repos, req: IdempotentRequest): Result<MemoryId[]> | null {
  const stored = storedResult(r, req);
  if (stored === null || !stored.ok) return stored;
  const ids: MemoryId[] = [];
  for (const raw of (stored.value.ids['recordIds'] ?? '').split(',').filter((s) => s !== '')) {
    const id = replayId(ctx, raw, 'memory', 'recordIds');
    if (!id.ok) return id;
    ids.push(id.value);
  }
  return ok(ids);
}

/** `memory.resolveConflict` (never auto-merges; 07 G5 rules). Idempotent. */
export async function resolveConflict(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/memory.resolveConflict'>): Out<'relay/v1/memory.resolveConflict'> {
  const req: IdempotentRequest = { op: RESOLVE_OP, key: input.idempotencyKey, hash: requestHash({ ...input }) };
  // txResult: a resolution that fails half-way (e.g. rewrite inserted, then a retire failed) leaves no partial writes.
  const res = ctx.db.txResult('immediate', (r): Result<MemoryId[]> => {
    const again = replayResolve(ctx, r, req);
    if (again !== null) return again;
    const done = resolveMemoryConflict(r, userEnv(ctx), input.recordIds, input.resolution);
    if (done.ok) recordResult(r, req, { ids: { recordIds: done.value.join(',') } });
    return done;
  });
  if (!res.ok) return res;
  const items = res.value.flatMap((id) => {
    const item = ctx.db.repos.memory.get(id);
    return item === undefined ? [] : [item];
  });
  const first = items[0];
  if (first !== undefined) changed(ctx, first.record.projectId);
  return ok(await views(ctx, items));
}

/** `memory.purgeProjectHistory`: storage C8 purge (snapshot copies + raw responses + context manifests). */
export async function purgeProjectHistory(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/memory.purgeProjectHistory'>): Out<'relay/v1/memory.purgeProjectHistory'> {
  if (ctx.db.repos.projects.find(input.projectId) === undefined) return err(errors.notFound('project'));
  const res = await ctx.maintenance.purgeProjectHistory(input.projectId);
  changed(ctx, input.projectId);
  // Every count is returned: `failed` artifacts stay unpurged (retried by the next sweep) and must not be hidden (03 C8).
  return ok({ purgedSnapshots: res.purgedSnapshots, purgedArtifacts: res.purgedArtifacts, failed: res.failed });
}
