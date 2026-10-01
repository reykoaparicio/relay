// 07 G5 / 02 memory ops: the memory.* runner handlers. Writes run in one immediate transaction through the lifecycle
// functions of memory.ts (pure state machine + secret guard); views add the live-file stale flag (§10.5 "Source
// changed") and the suggestion's conflicts. Every successful write emits `memory.changed` for the project.
import { err, errors, idSchema, ok } from '@relay/contracts';
import type {
  INTERNAL_RUNNER_OPS,
  MemoryId,
  MemoryRecordDetail,
  MemoryRecordScope,
  MemoryRecordView,
  MemorySource,
  MemorySourceRef,
  OPERATIONS,
  ProjectId,
  Result,
  RunnerChannel,
  RunnerOutputOf,
  Sha256,
} from '@relay/contracts';
import type { MemoryItem, Repos } from '@relay/storage';
import { requestHash } from './hash.js';
import { applyAction, approveSuggestion, guardSecrets, insertMemory, resolveConflict as resolveMemoryConflict, updateRecord } from './memory.js';
import type { MemoryEnv } from './memory.js';
import type { EngineCtx } from './ports.js';

type Out<C extends RunnerChannel> = Promise<Result<RunnerOutputOf<C>>>;
type Ops = typeof OPERATIONS & typeof INTERNAL_RUNNER_OPS;
/** Parsed input of a runner channel (same as services.ts `ParsedInputOf`; restated to avoid an import cycle). */
type ParsedInputOf<C extends RunnerChannel> = Extract<Ops[keyof Ops], { channel: C }>['input']['_zod']['output'];

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

/** The suggestion's proposal (`proposal_json`), tolerant of malformed JSON (never trusted blindly, 00b §4). */
function proposalOf(item: MemoryItem): MemoryRecordDetail['proposal'] {
  const p = item.record.proposal;
  if (p === null || typeof p !== 'object') return undefined;
  const v = p as Record<string, unknown>;
  const scope = v['suggestedScope'] as MemoryRecordScope | undefined;
  return {
    rationale: typeof v['rationale'] === 'string' ? v['rationale'] : '',
    suggestedScope: scope !== undefined && (scope.roles === 'all' || Array.isArray(scope.roles)) ? scope : { roles: 'all' },
    conflictsWith: Array.isArray(v['conflictsWith']) ? v['conflictsWith'].flatMap((c) => (memoryIdSchema.safeParse(c).success ? [c as MemoryId] : [])) : [],
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

function toView(item: MemoryItem, stale: boolean): MemoryRecordView {
  const rec = item.record;
  return {
    id: rec.id, projectId: rec.projectId, type: rec.type, status: rec.status, title: item.current.title, excerpt: excerpt(item.current.content),
    scope: rec.scope, pinned: rec.pinned, currentRevision: rec.currentRevision, source: sourceOf(item), createdAt: rec.createdAt, updatedAt: rec.updatedAt,
    expiresAt: rec.expiresAt, reviewAt: rec.reviewAt, supersededById: rec.supersededById, stale, conflictsWith: proposalOf(item)?.conflictsWith ?? [],
  };
}

async function views(ctx: EngineCtx, items: readonly MemoryItem[]): Promise<MemoryRecordView[]> {
  const first = items[0];
  if (first === undefined) return [];
  const stale = await staleIds(ctx, first.record.projectId, items);
  return items.map((i) => toView(i, stale.has(i.record.id)));
}

async function detail(ctx: EngineCtx, id: MemoryId): Promise<Result<MemoryRecordDetail>> {
  const r = ctx.db.repos;
  const got = r.memory.getWithRevisions(id);
  if (got === undefined) return err(errors.notFound('memory'));
  const [view] = await views(ctx, [got.item]);
  if (view === undefined) return err(errors.notFound('memory'));
  const proposal = got.item.record.status === 'suggested' || got.item.record.sourceRunId !== null ? proposalOf(got.item) : undefined;
  return ok({
    ...view,
    content: got.item.current.content,
    revisions: got.revisions.map((v) => ({ revision: v.revision, title: v.title, content: v.content, author: v.author, createdAt: v.createdAt, sourceRefs: [...v.sourceRefs] })),
    events: got.events.map((e) => ({ event: e.event, revision: Math.max(1, e.revision), actor: e.actor, createdAt: e.createdAt })),
    usedByRuns: r.memory.countRunSnapshots(id),
    ...(proposal === undefined ? {} : { proposal }),
  });
}

/** Runs a lifecycle write in one transaction, then emits `memory.changed` and returns the record detail. */
async function write(ctx: EngineCtx, f: (r: Repos, env: MemoryEnv) => Result<MemoryItem>): Promise<Result<MemoryRecordDetail>> {
  const res = ctx.db.tx('immediate', (r) => f(r, userEnv(ctx)));
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

function replayCreate(r: Repos, key: string, hash: string): Result<MemoryId> | null {
  const stored = r.idempotency.get(CREATE_OP, key);
  if (stored === undefined) return null;
  if (stored.requestHash !== hash) return err(errors.conflict({ reason: 'idempotency_key_reused', op: CREATE_OP }));
  return ok(stored.result.ids['recordId'] as MemoryId);
}

/** `memory.create`: user-authored → approved immediately (author `user`, §10.1). Secrets rejected (§5.5). Idempotent. */
export async function create(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/memory.create'>): Out<'relay/v1/memory.create'> {
  const hash = requestHash({ ...input });
  const early = replayCreate(ctx.db.repos, input.idempotencyKey, hash);
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
  const res = ctx.db.tx('immediate', (r): Result<MemoryId> => {
    const again = replayCreate(r, input.idempotencyKey, hash);
    if (again !== null) return again;
    const item = insertMemory(r, userEnv(ctx), 'create', { projectId: input.projectId, type: input.type, title: input.title, content: input.content,
      scope: input.scope, pinned: input.pinned, expiresAt: input.expiresAt, reviewAt: input.reviewAt, sourceRefs: refs });
    r.idempotency.put(CREATE_OP, input.idempotencyKey, hash, { ids: { recordId: item.record.id } });
    return ok(item.record.id);
  });
  if (!res.ok) return res;
  changed(ctx, input.projectId);
  return detail(ctx, res.value);
}

/** `memory.update` (expectedRevision CAS; `unarchive`, `reviewAt`, `pinned`, scope, title/content). */
export function update(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/memory.update'>): Out<'relay/v1/memory.update'> {
  return write(ctx, (r, env) => updateRecord(r, env, input));
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
  const res = ctx.db.tx('immediate', (r) => applyAction(r, userEnv(ctx), input.recordId, 'delete'));
  if (!res.ok) return Promise.resolve(res);
  changed(ctx, res.value.record.projectId);
  return Promise.resolve(ok({ deleted: true as const, retainedInRunSnapshots: ctx.db.repos.memory.countRunSnapshots(input.recordId) }));
}

const RESOLVE_OP = 'memory.resolveConflict';

function replayResolve(r: Repos, key: string, hash: string): Result<MemoryId[]> | null {
  const stored = r.idempotency.get(RESOLVE_OP, key);
  if (stored === undefined) return null;
  if (stored.requestHash !== hash) return err(errors.conflict({ reason: 'idempotency_key_reused', op: RESOLVE_OP }));
  return ok((stored.result.ids['recordIds'] ?? '').split(',').filter((s) => s !== '') as MemoryId[]);
}

/** `memory.resolveConflict` (never auto-merges; 07 G5 rules). Idempotent. */
export async function resolveConflict(ctx: EngineCtx, input: ParsedInputOf<'relay/v1/memory.resolveConflict'>): Out<'relay/v1/memory.resolveConflict'> {
  const hash = requestHash({ ...input });
  const res = ctx.db.tx('immediate', (r): Result<MemoryId[]> => {
    const again = replayResolve(r, input.idempotencyKey, hash);
    if (again !== null) return again;
    const done = resolveMemoryConflict(r, userEnv(ctx), input.recordIds, input.resolution);
    if (done.ok) r.idempotency.put(RESOLVE_OP, input.idempotencyKey, hash, { ids: { recordIds: done.value.join(',') } });
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
  return ok({ purgedSnapshots: res.purgedSnapshots });
}
