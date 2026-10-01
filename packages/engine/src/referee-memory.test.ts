// Referee memory/context fixes: BH-2 (absent vs empty memoryRecordIds), BH-3 (preflight = intake selection),
// BH-6 (no silent coexistence of conflicting approved records), BH-7 (conflicting proposals surfaced, path-aware
// dedupe), and the txResult rollback of memory lifecycle writes. BH-1/BH-4/BH-5 live in context.test.ts and
// memory-retrieval.test.ts; the storage half of BH-1 and txResult itself in @relay/storage.
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryId, MemoryRecordScope, MemoryType, RunId, RunStartInput } from '@relay/contracts';
import type { MemoryItem } from '@relay/storage';
import { chooseProposals, createMemoryService, proposalContentKey, proposalTitleKey, selectRunMemory } from './memory.js';
import type { Proposal } from './memory.js';
import { snapshotOf } from './snapshot.js';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function harness(): Promise<Harness> {
  h = await createHarness();
  return h;
}

let keySeq = 0;
async function create(x: Harness, o: { title: string; content?: string; type?: Exclude<MemoryType, 'run_summary'>; scope?: MemoryRecordScope; pinned?: boolean }) {
  keySeq += 1;
  return x.engine.handle('relay/v1/memory.create', {
    idempotencyKey: `referee-memory-key-${String(keySeq).padStart(4, '0')}`, projectId: x.projectId, type: o.type ?? 'project_decision', title: o.title,
    content: o.content ?? `Content of ${o.title}.`, scope: o.scope ?? { roles: 'all' }, ...(o.pinned === undefined ? {} : { pinned: o.pinned }),
  });
}

async function created(x: Harness, o: Parameters<typeof create>[1]): Promise<MemoryId> {
  const res = await create(x, o);
  if (!res.ok) throw new Error(`memory.create: ${res.error.code}`);
  return res.data.id;
}

function startInput(x: Harness, over: Partial<RunStartInput> = {}): RunStartInput {
  const wf = x.db.repos.workflows.listWorkflows()[0];
  return { idempotencyKey: `referee-run-${String((keySeq += 1)).padStart(4, '0')}`, projectId: x.projectId, workflowId: wf?.id ?? ('' as never), workflowVersion: 1,
    goal: 'Fix the defects in the handlers.', input: { kind: 'files', relPaths: ['src/lib/format.ts' as never] }, ...over };
}

const ids = (items: readonly { readonly record: { readonly id: MemoryId } }[]) => new Set(items.map((i) => i.record.id));
const conflictOf = (r: { readonly ok: boolean; readonly error?: { readonly code: string; readonly details?: object | undefined } }) => {
  const d = r.error?.details as Record<string, unknown> | undefined;
  return r.ok ? null : [r.error?.code, d?.['reason'], d?.['conflictsWith']];
};

describe('BH-2: absent vs empty memoryRecordIds', () => {
  it('absent → every approved record; [] → pinned rules only; a list → pinned + those; the run snapshot persists null vs []', async () => {
    const x = await harness();
    const pinned = await created(x, { title: 'Pinned rule', type: 'user_rule', pinned: true });
    const a = await created(x, { title: 'Decision A' });
    const b = await created(x, { title: 'Decision B' });
    const select = (o: readonly MemoryId[] | null) => {
      const res = selectRunMemory(x.db.repos, x.projectId, x.clock.now(), o);
      if (!res.ok) throw new Error(res.error.code);
      return ids(res.value);
    };

    const absent = await x.engine.handle('relay/v1/runs.start', startInput(x));
    const empty = await x.engine.handle('relay/v1/runs.start', startInput(x, { memoryRecordIds: [] }));
    if (!absent.ok || !empty.ok) throw new Error('runs.start');
    const service = createMemoryService({ db: x.db, artifacts: x.ctx.artifacts, clock: x.clock, ids: x.ids, logger: x.logger });
    const snapshotAs = (runId: RunId) => {
      const includeIds = snapshotOf(x.db.repos.runs.get(runId)).memoryIncludeIds;
      expect(service.snapshotForRun(runId, x.projectId, { includeIds }).ok).toBe(true); // exactly what intake calls
      return { includeIds, recordIds: new Set(x.db.repos.memory.runSnapshot(runId).map((s) => s.recordId)) };
    };

    expect(select(null)).toEqual(new Set([pinned, a, b]));
    expect(select([])).toEqual(new Set([pinned]));
    expect(select([a])).toEqual(new Set([pinned, a]));
    expect(snapshotAs(absent.data.runId)).toEqual({ includeIds: null, recordIds: new Set([pinned, a, b]) });
    expect(snapshotAs(empty.data.runId)).toEqual({ includeIds: [], recordIds: new Set([pinned]) });
  });
});

describe('BH-3: runs.preflight shows the records intake would snapshot and counts them', () => {
  it('memoryRecords == the intake selection (same function); the token estimate includes their rules; an unknown id → VALIDATION_FAILED', async () => {
    const x = await harness();
    const pinned = await created(x, { title: 'Pinned rule', type: 'user_rule', pinned: true });
    const a = await created(x, { title: 'Decision A', content: `Prefer explicit return types. ${'Keep diffs small and focused. '.repeat(60)}` });
    await created(x, { title: 'Decision B' });

    const pre = await x.engine.handle('relay/v1/runs.preflight', { ...startInput(x), memoryRecordIds: [a] });
    const pinnedOnly = await x.engine.handle('relay/v1/runs.preflight', { ...startInput(x), memoryRecordIds: [] });
    const unknown = await x.engine.handle('relay/v1/runs.preflight', { ...startInput(x), memoryRecordIds: [x.ids.next('memory')] });
    const selection = selectRunMemory(x.db.repos, x.projectId, x.clock.now(), [a]);
    const started = await x.engine.handle('relay/v1/runs.start', startInput(x, { memoryRecordIds: [a] }));
    if (!pre.ok || !pinnedOnly.ok || !selection.ok || !started.ok) throw new Error('preflight/start');
    const runId = started.data.runId;
    expect(x.ctx.memory.snapshotForRun(runId, x.projectId, { includeIds: snapshotOf(x.db.repos.runs.get(runId)).memoryIncludeIds }).ok).toBe(true);

    expect(pre.data.inputSummary.memoryRecords.map((m) => m.id).sort()).toEqual([...ids(selection.value)].sort());
    expect(pre.data.inputSummary.memoryRecords.map((m) => m.id).sort()).toEqual(x.db.repos.memory.runSnapshot(runId).map((s) => s.recordId).sort());
    expect(pre.data.inputSummary.memoryRecords.find((m) => m.id === pinned)).toEqual({ id: pinned, revision: 1, type: 'user_rule', title: 'Pinned rule', pinned: true });
    expect(pinnedOnly.data.inputSummary.memoryRecords.map((m) => m.id)).toEqual([pinned]);
    expect(pre.data.inputSummary.estimatedInputTokens).toBeGreaterThan(pinnedOnly.data.inputSummary.estimatedInputTokens + 300);
    expect(unknown.ok ? null : [unknown.error.code, (unknown.error.details?.['issues'] as { path: string }[])[0]?.path]).toEqual(['VALIDATION_FAILED', 'memoryRecordIds']);
  });
});

describe('BH-6: conflicting approved records never coexist silently', () => {
  it('create with the same normalized title in an overlapping scope → CONFLICT conflictsWith; a disjoint scope is allowed', async () => {
    const x = await harness();
    const first = await created(x, { title: 'Validate inputs', scope: { roles: ['planner'] } });

    const same = await create(x, { title: '  validate INPUTS! ', content: 'Other text.' });
    const disjoint = await create(x, { title: 'Validate inputs', scope: { roles: ['reviewer'] } });

    expect(conflictOf(same)).toEqual(['CONFLICT', 'memory_conflict', [first]]);
    expect(disjoint.ok).toBe(true);
    expect(x.db.repos.memory.list({ projectId: x.projectId, statuses: ['approved'] })).toHaveLength(2);
  });

  it('update: a title or scope change into a conflict → CONFLICT, nothing written', async () => {
    const x = await harness();
    const a = await created(x, { title: 'Validate inputs', scope: { roles: ['planner'] } });
    const b = await created(x, { title: 'Other rule', scope: { roles: ['reviewer'] } });
    const c = await created(x, { title: 'Validate inputs', scope: { roles: ['reviewer'] } });

    const retitled = await x.engine.handle('relay/v1/memory.update', { recordId: b, expectedRevision: 1, title: 'Validate Inputs' });
    const rescoped = await x.engine.handle('relay/v1/memory.update', { recordId: c, expectedRevision: 1, scope: { roles: 'all' } });
    const content = await x.engine.handle('relay/v1/memory.update', { recordId: c, expectedRevision: 1, content: 'Edited.' });

    expect(conflictOf(retitled)).toEqual(['CONFLICT', 'memory_conflict', [c]]); // b and c share the reviewer role
    expect(conflictOf(rescoped)).toEqual(['CONFLICT', 'memory_conflict', [a]]);
    expect([x.db.repos.memory.get(b)?.current.title, x.db.repos.memory.get(b)?.record.currentRevision]).toEqual(['Other rule', 1]);
    expect(x.db.repos.memory.get(c)?.record.scope).toEqual({ roles: ['reviewer'] });
    expect(content.ok).toBe(true); // a content-only edit of a non-conflicting record is unaffected
  });

  it('unarchive into a conflict → CONFLICT; a superseded record cannot be unarchived (only an explicit resolution decides)', async () => {
    const x = await harness();
    const old = await created(x, { title: 'Validate inputs' });
    await x.engine.handle('relay/v1/memory.archive', { recordId: old });
    const replacement = await created(x, { title: 'Validate inputs', content: 'New text.' });
    const p = await created(x, { title: 'Error codes', scope: { roles: ['planner'] } });
    const r = await created(x, { title: 'Error codes', scope: { roles: ['reviewer'] } });
    const resolved = await x.engine.handle('relay/v1/memory.resolveConflict', { idempotencyKey: 'referee-resolve-0001', recordIds: [p, r], resolution: { keep: p } });
    await x.engine.handle('relay/v1/memory.archive', { recordId: p });

    const conflicting = await x.engine.handle('relay/v1/memory.update', { recordId: old, expectedRevision: 1, unarchive: true });
    const superseded = await x.engine.handle('relay/v1/memory.update', { recordId: r, expectedRevision: 1, unarchive: true });

    expect(resolved.ok).toBe(true);
    expect(conflictOf(conflicting)).toEqual(['CONFLICT', 'memory_conflict', [replacement]]);
    expect(conflictOf(superseded)).toEqual(['CONFLICT', 'memory_superseded', [p]]);
    expect([x.db.repos.memory.get(old)?.record.status, x.db.repos.memory.get(r)?.record.status, x.db.repos.memory.get(r)?.record.supersededById]).toEqual(['archived', 'archived', p]);
  });

  it('approve honors proposal.conflictsWith (CONFLICT) until the conflict is resolved through resolveConflict', async () => {
    const x = await harness();
    const existing = await created(x, { title: 'Response format' });
    const suggestion = x.db.repos.memory.insertRecord(
      { id: x.ids.next('memory'), projectId: x.projectId, type: 'project_decision', status: 'suggested', scope: { roles: 'all' }, createdAt: x.clock.now(),
        proposal: { rationale: 'Seen twice.', suggestedScope: { roles: 'all' }, conflictsWith: [existing] } },
      { id: x.ids.next('memoryRevision'), title: 'Public payload shape', content: 'Return { data } only.', sourceRefs: [], author: 'run:x', createdAt: x.clock.now() },
    ).record.id;

    const approve = await x.engine.handle('relay/v1/memory.approve', { suggestionId: suggestion, expectedRevision: 1 });
    const resolved = await x.engine.handle('relay/v1/memory.resolveConflict', { idempotencyKey: 'referee-resolve-0002', recordIds: [suggestion, existing], resolution: { keep: suggestion } });

    expect(conflictOf(approve)).toEqual(['CONFLICT', 'memory_conflict', [existing]]);
    expect(resolved.ok && resolved.data.map((v) => [v.id, v.status])).toEqual([[suggestion, 'approved'], [existing, 'archived']]);
  });

  it('a lifecycle write that fails after writing rolls back (txResult): keepBothWithScopes re-scopes the first record, then the second is refused', async () => {
    const x = await harness();
    const a = await created(x, { title: 'Validate inputs' });
    const secret = x.db.repos.memory.insertRecord(
      { id: x.ids.next('memory'), projectId: x.projectId, type: 'project_decision', status: 'suggested', scope: { roles: 'all' }, createdAt: x.clock.now() },
      { id: x.ids.next('memoryRevision'), title: 'Validate inputs', content: 'Use key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA', sourceRefs: [], author: 'run:x', createdAt: x.clock.now() },
    ).record.id;
    const before = x.db.repos.memory.getWithRevisions(a);

    const res = await x.engine.handle('relay/v1/memory.resolveConflict', { idempotencyKey: 'referee-resolve-0003', recordIds: [a, secret],
      resolution: { keepBothWithScopes: [{ recordId: a, scope: { roles: ['planner'] } }, { recordId: secret, scope: { roles: ['reviewer'] } }] } });

    expect(res.ok ? null : res.error.code).toBe('VALIDATION_FAILED'); // the suggestion fails the secret guard after `a` was re-scoped
    expect(x.db.repos.memory.getWithRevisions(a)).toEqual(before); // …and that write was rolled back
    expect(x.db.repos.memory.get(secret)?.record.status).toBe('suggested');
  });
});

// ---------------------------------------------------------------- BH-7

function item(id: MemoryId, status: 'approved' | 'suggested', title: string, content: string): MemoryItem {
  return {
    record: { id, status, type: 'project_decision', projectId: 'prj' as never, currentRevision: 1, scope: { roles: 'all' }, pinned: false, expiresAt: null, reviewAt: null,
      supersededById: null, sourceRunId: null, proposal: null, createdAt: 0 as never, updatedAt: 0 as never, deletedAt: null },
    current: { id: 'rev' as never, recordId: id, revision: 1, title, content, sourceRefs: [], author: 'user', createdAt: 0 as never },
  };
}

function proposal(title: string, content: string): Proposal {
  return { type: 'project_decision', title, content, rationale: 'Reusable.', conflictsWith: [], artifactId: 'art' as never, sourceRefs: [] };
}

describe('BH-7: proposal selection', () => {
  it('normalizes path qualifiers, case, and whitespace for duplicate keys', () => {
    expect(proposalTitleKey('Validate in src/lib/validate.ts')).toBe(proposalTitleKey('validate in  VALIDATE.ts'));
    expect(proposalContentKey('Use the   helpers.\n')).toBe(proposalContentKey('use the helpers'));
    expect(proposalTitleKey('Validate inputs')).not.toBe(proposalTitleKey('Validate outputs'));
  });

  it('a proposal conflicting with an approved record (same title, different content) is kept with detectedConflicts; a true duplicate is skipped', () => {
    const approved = 'mem_01J9ZZZZZZZZZZZZZZZZZZZZA1' as MemoryId;
    const existing = [item(approved, 'approved', 'Validate inputs', 'Use zod schemas.'), item('mem_01J9ZZZZZZZZZZZZZZZZZZZZS1' as MemoryId, 'suggested', 'Small diffs', 'Keep diffs small.')];

    const res = chooseProposals(existing, [
      proposal('Validate Inputs', 'Validate by hand.'), // conflict → surfaced
      proposal('validate inputs', '  use ZOD schemas '), // duplicate of the approved record
      proposal('Small diffs', 'keep diffs   small.'), // duplicate of the pending suggestion
    ]);

    expect(res.chosen.map((p) => [p.title, p.detectedConflicts])).toEqual([['Validate Inputs', [approved]]]);
    expect(res.skipped).toEqual(['duplicate', 'duplicate']);
  });

  it('dedupes within a run by title key AND near-identical content (path-qualified titles included); caps at 3', () => {
    const res = chooseProposals([], [
      proposal('Validate request fields with src/lib/validate.ts helpers', 'Call validateBody before reading fields.'),
      proposal('Validate request fields with validate.ts helpers', 'call validateBody before reading fields'),
      proposal('Error codes', 'Use src/errors.ts codes.'),
      proposal('Response format', 'Return { data }.'),
      proposal('Logging', 'No console.log.'),
    ]);

    expect(res.chosen.map((p) => p.title)).toEqual(['Validate request fields with src/lib/validate.ts helpers', 'Error codes', 'Response format']);
    expect(res.skipped).toEqual(['duplicate']);
  });

  it('end to end: a run proposal whose title matches an approved record with different content becomes a suggestion with conflictsWith', async () => {
    const x = await harness();
    const runOne = await completeRun(x);
    const firstSuggestion = x.db.repos.memory.list({ projectId: x.projectId, statuses: ['suggested'] }).find((s) => s.record.sourceRunId === runOne);
    if (firstSuggestion === undefined) throw new Error('no suggestion');
    await x.engine.handle('relay/v1/memory.reject', { suggestionId: firstSuggestion.record.id });
    const approved = await created(x, { title: firstSuggestion.current.title, content: 'A different, user-written rule.' });

    const runTwo = await completeRun(x);

    const again = x.db.repos.memory.list({ projectId: x.projectId, statuses: ['suggested'] }).filter((s) => s.record.sourceRunId === runTwo);
    expect(again.map((s) => [s.current.title, (s.record.proposal as { conflictsWith: string[] }).conflictsWith])).toEqual([[firstSuggestion.current.title, [approved]]]);
    const view = await x.engine.handle('relay/v1/memory.get', { recordId: again[0]?.record.id ?? '' });
    expect(view.ok && view.data.conflictsWith).toEqual([approved]);
  });
});

async function completeRun(x: Harness): Promise<RunId> {
  await x.engine.start();
  const runId = await x.startRun();
  await x.waitForStatus(runId, ['awaiting_approval']);
  const detail = await x.engine.handle('relay/v1/runs.get', { runId });
  const a = detail.ok ? detail.data.pendingApproval : null;
  await x.engine.handle('relay/v1/approvals.decide', { idempotencyKey: `approve-${runId.slice(-12)}`, approvalId: a?.id ?? '', planHash: a?.planHash ?? '',
    contextHash: a?.contextHash ?? '', decision: 'approved' });
  await x.waitForStatus(runId, ['completed']);
  return runId;
}
