import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_STATUSES } from '@relay/contracts';
import type { MemoryId, MemoryRecordScope, MemoryStatus, MemoryType, Result, RunId } from '@relay/contracts';
import type { MemoryAction, MemoryEnv } from './memory.js';
import {
  applyAction,
  approveSuggestion,
  createMemoryService,
  guardSecrets,
  normalizeTitle,
  resolveConflict,
  runSummaryText,
  scopesOverlap,
  snapshotMemoryForRun,
  transitionMemory,
  updateRecord,
} from './memory.js';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA';

async function harness(o: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  h = await createHarness(o);
  return h;
}

function env(x: Harness): MemoryEnv {
  return { ids: x.ids, now: x.clock.now(), actor: 'user' };
}

function add(x: Harness, o: { status?: MemoryStatus; scope?: MemoryRecordScope; title?: string; type?: MemoryType; pinned?: boolean; content?: string } = {}): MemoryId {
  return x.db.repos.memory.insertRecord(
    { id: x.ids.next('memory'), projectId: x.projectId, type: o.type ?? 'user_rule', status: o.status ?? 'approved', scope: o.scope ?? { roles: 'all' },
      pinned: o.pinned ?? false, createdAt: x.clock.now() },
    { id: x.ids.next('memoryRevision'), title: o.title ?? `Rule ${x.ids.next('memory').slice(-6)}`, content: o.content ?? 'Never cast body fields.', sourceRefs: [], author: 'user', createdAt: x.clock.now() },
  ).record.id;
}

const status = (x: Harness, id: MemoryId) => x.db.repos.memory.get(id)?.record.status;
const events = (x: Harness, id: MemoryId) => x.db.repos.memory.getWithRevisions(id)?.events.map((e) => e.event);

describe('transitionMemory (07 G5 table, exhaustive)', () => {
  const LEGAL: Record<MemoryAction, Partial<Record<MemoryStatus | 'none', MemoryStatus>>> = {
    create: { none: 'approved' },
    propose: { none: 'suggested' },
    record_summary: { none: 'approved' },
    approve: { suggested: 'approved' },
    reject: { suggested: 'rejected' },
    edit: { approved: 'approved' },
    archive: { approved: 'archived' },
    unarchive: { archived: 'approved' },
    delete: { approved: 'deleted', archived: 'deleted' },
  };
  const FROM = ['none', ...MEMORY_STATUSES] as const;

  for (const [action, table] of Object.entries(LEGAL) as [MemoryAction, Partial<Record<string, MemoryStatus>>][]) {
    for (const from of FROM) {
      const expected = table[from] ?? null;
      it(`${from} --${action}--> ${expected ?? 'illegal'}`, () => {
        expect(transitionMemory(from === 'none' ? null : from, action)).toBe(expected);
      });
    }
  }
});

describe('memory helpers', () => {
  it('secret guard rejects credential-shaped text with the §5.5 message; normalizes titles; detects scope overlap', () => {
    const res = guardSecrets({ title: 'ok', content: `key ${SECRET}` });

    expect(res.ok ? null : [res.error.code, res.error.userMessage, (res.error.details?.['issues'] as { path: string }[])[0]?.path])
      .toEqual(['VALIDATION_FAILED', "Provider credentials and secrets don't belong in memory", 'content']);
    expect(guardSecrets({ title: 'fine', content: undefined }).ok).toBe(true);
    expect(normalizeTitle('  Use  PNPM, always! ')).toBe('use pnpm always');
    expect(scopesOverlap({ roles: 'all' }, { roles: ['planner'] })).toBe(true);
    expect(scopesOverlap({ roles: ['planner', 'reviewer'] }, { roles: ['reviewer'] })).toBe(true);
    expect(scopesOverlap({ roles: ['planner'] }, { roles: ['reviewer'] })).toBe(false);
  });

  it('builds the run summary deterministically from typed data', () => {
    expect(runSummaryText({ goal: 'Fix  the\nhandlers', verdict: 'accept', fileScope: ['a.ts', 'b.ts'] })).toEqual({
      title: 'Run summary: Fix the handlers',
      content: 'Goal: Fix the handlers\nOutcome: completed\nVerdict: accept\nFile scope: a.ts, b.ts',
    });
    expect(runSummaryText({ goal: 'g', verdict: 'revise', fileScope: [] }).content).toBe('Goal: g\nOutcome: incomplete\nVerdict: revise\nFile scope: none');
    expect(runSummaryText({ goal: 'x'.repeat(300), verdict: null, fileScope: [] }).title).toHaveLength(120);
  });
});

describe('memory lifecycle (07 G5)', () => {
  it('approve: suggested → approved; edits create rev 2 (edited + approved events); scope/pinned applied', async () => {
    const x = await harness();
    const s = add(x, { status: 'suggested', type: 'project_decision' });

    const res = x.db.tx('immediate', (r) => approveSuggestion(r, env(x), { suggestionId: s, expectedRevision: 1, finalContent: 'Edited.', scope: { roles: ['planner'] }, pinned: true }));

    expect(res.ok && [res.value.record.status, res.value.record.currentRevision, res.value.current.content, res.value.record.scope, res.value.record.pinned])
      .toEqual(['approved', 2, 'Edited.', { roles: ['planner'] }, true]);
    expect(events(x, s)).toEqual(['edited', 'approved']);
  });

  it('approve rejects a stale revision, a non-suggestion, a secret, an unknown id, and a same-title overlap (never auto-merged)', async () => {
    const x = await harness();
    const existing = add(x, { title: 'Use PNPM', scope: { roles: ['reviewer'] } });
    const dup = add(x, { status: 'suggested', title: 'use pnpm!' });
    const s = add(x, { status: 'suggested' });

    const stale = x.db.tx('immediate', (r) => approveSuggestion(r, env(x), { suggestionId: s, expectedRevision: 2 }));
    const notSuggested = x.db.tx('immediate', (r) => approveSuggestion(r, env(x), { suggestionId: existing, expectedRevision: 1 }));
    const secret = x.db.tx('immediate', (r) => approveSuggestion(r, env(x), { suggestionId: s, expectedRevision: 1, finalContent: SECRET }));
    const missing = x.db.tx('immediate', (r) => approveSuggestion(r, env(x), { suggestionId: x.ids.next('memory'), expectedRevision: 1 }));
    const conflict = x.db.tx('immediate', (r) => approveSuggestion(r, env(x), { suggestionId: dup, expectedRevision: 1 }));
    const disjoint = x.db.tx('immediate', (r) => approveSuggestion(r, env(x), { suggestionId: dup, expectedRevision: 1, scope: { roles: ['planner'] } }));

    const code = (v: Result<unknown>) => (v.ok ? 'ok' : v.error.code);
    expect([code(stale), code(notSuggested), code(secret), code(missing), code(conflict)]).toEqual(['CONFLICT', 'CONFLICT', 'VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT']);
    expect(!conflict.ok && conflict.error.details?.['conflictsWith']).toEqual([existing]);
    expect(stale.ok ? null : stale.error.details?.['currentRevision']).toBe(1);
    expect(status(x, s)).toBe('suggested');
    expect(code(disjoint)).toBe('ok'); // non-overlapping scopes are not a conflict
  });

  it('reject / archive / unarchive / delete follow the table; illegal moves are CONFLICT', async () => {
    const x = await harness();
    const s = add(x, { status: 'suggested' });
    const a = add(x);

    const rejected = x.db.tx('immediate', (r) => applyAction(r, env(x), s, 'reject', { reason: 'nope' }));
    const rejectAgain = x.db.tx('immediate', (r) => applyAction(r, env(x), s, 'reject'));
    const archived = x.db.tx('immediate', (r) => applyAction(r, env(x), a, 'archive'));
    const editArchived = x.db.tx('immediate', (r) => updateRecord(r, env(x), { recordId: a, expectedRevision: 1, content: 'x' }));
    const unarchived = x.db.tx('immediate', (r) => updateRecord(r, env(x), { recordId: a, expectedRevision: 1, unarchive: true }));
    const deleted = x.db.tx('immediate', (r) => applyAction(r, env(x), a, 'delete'));
    const deleteAgain = x.db.tx('immediate', (r) => applyAction(r, env(x), a, 'delete'));

    expect([rejected.ok, rejectAgain.ok, archived.ok, editArchived.ok, unarchived.ok, deleted.ok, deleteAgain.ok]).toEqual([true, false, true, false, true, true, false]);
    expect([status(x, s), status(x, a)]).toEqual(['rejected', 'deleted']);
    expect(events(x, a)).toEqual(['archived', 'unarchived', 'deleted']);
    expect(!rejectAgain.ok && rejectAgain.error.code).toBe('CONFLICT');
  });

  it('update: CAS on expectedRevision; title/content/scope → new revision; attributes only → same revision; secrets rejected', async () => {
    const x = await harness();
    const a = add(x);

    const content = x.db.tx('immediate', (r) => updateRecord(r, env(x), { recordId: a, expectedRevision: 1, content: 'Second.' }));
    const stale = x.db.tx('immediate', (r) => updateRecord(r, env(x), { recordId: a, expectedRevision: 1, content: 'Third.' }));
    const scope = x.db.tx('immediate', (r) => updateRecord(r, env(x), { recordId: a, expectedRevision: 2, scope: { roles: ['reviewer'] } }));
    const attrs = x.db.tx('immediate', (r) => updateRecord(r, env(x), { recordId: a, expectedRevision: 3, pinned: true, reviewAt: x.clock.now(), expiresAt: null }));
    const noop = x.db.tx('immediate', (r) => updateRecord(r, env(x), { recordId: a, expectedRevision: 3 }));
    const secret = x.db.tx('immediate', (r) => updateRecord(r, env(x), { recordId: a, expectedRevision: 3, title: SECRET }));
    const missing = x.db.tx('immediate', (r) => updateRecord(r, env(x), { recordId: x.ids.next('memory'), expectedRevision: 1 }));

    expect(content.ok && content.value.record.currentRevision).toBe(2);
    expect(stale.ok ? null : [stale.error.code, stale.error.details?.['currentRevision']]).toEqual(['CONFLICT', 2]);
    expect(scope.ok && [scope.value.record.currentRevision, scope.value.record.scope]).toEqual([3, { roles: ['reviewer'] }]);
    expect(attrs.ok && [attrs.value.record.currentRevision, attrs.value.record.pinned, attrs.value.record.reviewAt]).toEqual([3, true, x.clock.now()]);
    expect(noop.ok && noop.value.record.currentRevision).toBe(3);
    expect(secret.ok ? null : secret.error.code).toBe('VALIDATION_FAILED');
    expect(missing.ok ? null : missing.error.code).toBe('NOT_FOUND');
    expect(events(x, a)).toEqual(['edited', 'edited', 'edited']);
  });
});

describe('memory.resolveConflict (07 G5)', () => {
  const resolve = (x: Harness, ids: [MemoryId, MemoryId], res: Parameters<typeof resolveConflict>[3]) =>
    x.db.tx('immediate', (r) => resolveConflict(r, env(x), ids, res));

  it('approved ×2, keep → the other is archived and superseded', async () => {
    const x = await harness();
    const [a, b] = [add(x), add(x)];

    const res = resolve(x, [a, b], { keep: a });

    expect(res.ok && res.value).toEqual([a, b]);
    expect([status(x, a), status(x, b), x.db.repos.memory.get(b)?.record.supersededById]).toEqual(['approved', 'archived', a]);
    expect(events(x, b)).toEqual(['archived', 'conflict_resolved']);
  });

  it('approved ×2, rewrite → a new approved record and both inputs archived/superseded by it; a secret is rejected', async () => {
    const x = await harness();
    const [a, b] = [add(x), add(x)];

    const secret = resolve(x, [a, b], { rewrite: { title: 'Merged', content: SECRET, scope: { roles: 'all' } } });
    const res = resolve(x, [a, b], { rewrite: { title: 'Merged', content: 'Both.', scope: { roles: 'all' }, pinned: true } });

    expect(secret.ok ? null : secret.error.code).toBe('VALIDATION_FAILED');
    const created = res.ok ? res.value[2] : undefined;
    if (created === undefined) throw new Error('no new record');
    expect([status(x, a), status(x, b), status(x, created)]).toEqual(['archived', 'archived', 'approved']);
    expect(x.db.repos.memory.get(a)?.record.supersededById).toBe(created);
    expect(x.db.repos.memory.get(created)?.record.pinned).toBe(true);
  });

  it('keepBothWithScopes → both approved with the new disjoint scopes; overlapping scopes are VALIDATION_FAILED', async () => {
    const x = await harness();
    const [a, s] = [add(x), add(x, { status: 'suggested' })];

    const overlap = resolve(x, [a, s], { keepBothWithScopes: [{ recordId: a, scope: { roles: ['reviewer'] } }, { recordId: s, scope: { roles: 'all' } }] });
    const res = resolve(x, [a, s], { keepBothWithScopes: [{ recordId: a, scope: { roles: ['reviewer'] } }, { recordId: s, scope: { roles: ['planner'] } }] });

    expect(overlap.ok ? null : overlap.error.code).toBe('VALIDATION_FAILED');
    expect(res.ok).toBe(true);
    expect([status(x, a), status(x, s), x.db.repos.memory.get(s)?.record.scope]).toEqual(['approved', 'approved', { roles: ['planner'] }]);
  });

  it('suggested + approved: keep approved → suggestion rejected; keep suggestion → approved + old superseded; rewrite → suggestion rejected', async () => {
    const x = await harness();
    const [a1, s1] = [add(x), add(x, { status: 'suggested' })];
    const [a2, s2] = [add(x), add(x, { status: 'suggested' })];
    const [a3, s3] = [add(x), add(x, { status: 'suggested' })];

    const keepApproved = resolve(x, [s1, a1], { keep: a1 });
    const keepSuggestion = resolve(x, [s2, a2], { keep: s2 });
    const rewrite = resolve(x, [s3, a3], { rewrite: { title: 'Combined', content: 'Combined.', scope: { roles: 'all' } } });

    expect([keepApproved.ok, keepSuggestion.ok, rewrite.ok]).toEqual([true, true, true]);
    expect([status(x, s1), status(x, a1)]).toEqual(['rejected', 'approved']);
    expect([status(x, s2), status(x, a2), x.db.repos.memory.get(a2)?.record.supersededById]).toEqual(['approved', 'archived', s2]);
    expect([status(x, s3), status(x, a3)]).toEqual(['rejected', 'archived']);
    for (const s of [s1, s2, s3]) expect(status(x, s)).not.toBe('suggested');
  });

  it('two suggestions → VALIDATION_FAILED; a deleted record → CONFLICT; an unknown id → NOT_FOUND; a secret suggestion cannot be kept', async () => {
    const x = await harness();
    const [s1, s2] = [add(x, { status: 'suggested' }), add(x, { status: 'suggested', content: `token ${SECRET}` })];
    const [a, d] = [add(x), add(x, { status: 'deleted' })];

    const two = resolve(x, [s1, s2], { keep: s1 });
    const deleted = resolve(x, [a, d], { keep: a });
    const missing = resolve(x, [a, x.ids.next('memory')], { keep: a });
    const missingFirst = resolve(x, [x.ids.next('memory'), a], { keep: a });
    const secret = resolve(x, [s2, a], { keep: s2 });

    expect([two, deleted, missing, missingFirst, secret].map((v) => (v.ok ? 'ok' : v.error.code))).toEqual(['VALIDATION_FAILED', 'CONFLICT', 'NOT_FOUND', 'NOT_FOUND', 'VALIDATION_FAILED']);
  });
});

describe('snapshotForRun (07 G5)', () => {
  it('includeIds limits the non-pinned records, pinned user rules are always included, and a retried intake keeps the first snapshot', async () => {
    const x = await harness();
    const pinned = add(x, { pinned: true });
    const chosen = add(x);
    add(x);
    const runId = await x.startRun();
    const service = createMemoryService({ db: x.db, artifacts: x.ctx.artifacts, clock: x.clock, ids: x.ids, logger: x.logger });

    const res = service.snapshotForRun(runId, x.projectId, { includeIds: [chosen] });
    const again = service.snapshotForRun(runId, x.projectId, {});

    expect([res.ok, again.ok]).toEqual([true, true]);
    expect(new Set(x.db.repos.memory.runSnapshot(runId).map((s) => s.recordId))).toEqual(new Set([pinned, chosen]));
  });

  it('a non-approved (or foreign) id → VALIDATION_FAILED; no includeIds → every approved record', async () => {
    const x = await harness();
    const s = add(x, { status: 'suggested' });
    const a = add(x);
    const runId = await x.startRun();

    const bad = x.db.tx('immediate', (r) => snapshotMemoryForRun(r, runId, x.projectId, x.clock.now(), [s]));
    const all = x.db.tx('immediate', (r) => snapshotMemoryForRun(r, runId, x.projectId, x.clock.now()));

    expect(bad.ok ? null : [bad.error.code, (bad.error.details?.['issues'] as { path: string }[])[0]?.path]).toEqual(['VALIDATION_FAILED', 'memoryRecordIds']);
    expect(all.ok).toBe(true);
    expect(x.db.repos.memory.runSnapshot(runId).map((r) => r.recordId)).toEqual([a]);
  });
});

async function completeRun(x: Harness, goal?: string): Promise<RunId> {
  await x.engine.start();
  const runId = await x.startRun(goal === undefined ? {} : { goal });
  await x.waitForStatus(runId, ['awaiting_approval']);
  const detail = await x.engine.handle('relay/v1/runs.get', { runId });
  const a = detail.ok ? detail.data.pendingApproval : null;
  await x.engine.handle('relay/v1/approvals.decide', { idempotencyKey: `approve-${runId.slice(-12)}`, approvalId: a?.id ?? '', planHash: a?.planHash ?? '',
    contextHash: a?.contextHash ?? '', decision: 'approved' });
  await x.waitForStatus(runId, ['completed']);
  return runId;
}

describe('finalize memory (proposeFromRun + recordRunSummary)', () => {
  it('a completed run suggests memory from review.v1 + plan.v1 (never approved) and records one approved run_summary; both idempotent', async () => {
    const x = await harness();
    const runId = await completeRun(x);
    const service = createMemoryService({ db: x.db, artifacts: x.ctx.artifacts, clock: x.clock, ids: x.ids, logger: x.logger });

    const items = () => x.db.repos.memory.list({ projectId: x.projectId });
    const before = items().length;
    await service.proposeFromRun(runId);
    await service.recordRunSummary(runId);

    const all = items();
    const suggestions = all.filter((i) => i.record.status === 'suggested');
    const summaries = all.filter((i) => i.record.type === 'run_summary');
    expect(all).toHaveLength(before);
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    expect(suggestions.every((s) => s.record.sourceRunId === runId && s.current.author === `run:${runId}`)).toBe(true);
    expect(suggestions[0]?.record.proposal).toEqual(expect.objectContaining({ suggestedScope: { roles: 'all' }, conflictsWith: [] }));
    expect(summaries.map((s) => [s.record.status, s.current.author])).toEqual([['approved', `run:${runId}`]]);
    expect(summaries[0]?.current.content).toContain('Verdict: accept');
    expect(summaries[0]?.current.sourceRefs.filter((r) => r.kind === 'file').map((r) => r.relPath).sort()).toEqual(['src/handlers/orders.ts', 'src/handlers/user.ts', 'src/lib/format.ts']);
    expect(x.events.some((e) => e.type === 'memory.changed')).toBe(true);
  });

  it('a second run proposes no duplicate suggestions, and a secret-looking run summary is skipped and logged', async () => {
    const x = await harness();
    await completeRun(x);
    const second = await completeRun(x, `Rotate ${SECRET} please`);

    const all = x.db.repos.memory.list({ projectId: x.projectId });

    expect(all.filter((i) => i.record.sourceRunId === second)).toEqual([]);
    expect(x.logger.entries.some((e) => e.event === 'memory.run_summary_skipped')).toBe(true);
    expect(x.logger.entries.some((e) => e.event === 'memory.proposal_skipped' && e.fields?.['reason'] === 'duplicate')).toBe(true);
  });
});
