// Direct repo tests (03 C3 / 06 F2 clarification 14 + §9.5 + F17): `RunRepo.setDeferredPause`,
// `LedgerRepo.attemptsOverran` (also surfaced as `InspectorProjection.attemptsOverran`), `RunRepo.listTerminalWithoutReport`,
// and `ApprovalRepo.listForRun`.
import type { AttemptId, ProjectId, RunId } from '@relay/contracts';
import { epochMs, errors } from '@relay/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FixtureDb } from '../testing/fixtures.js';
import { newId, openFixtureDb, seedAttempt, seedProject, seedRun, seedStep, sha } from '../testing/fixtures.js';
import type { LedgerEntryInsert } from '../types.js';

let f: FixtureDb;
beforeEach(async () => {
  f = await openFixtureDb();
});
afterEach(async () => {
  await f.db.dispose();
});

describe('RunRepo.setDeferredPause', () => {
  it('stores the reason + detail durably, overwrites, clears with null, and bumps updated_at', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const other = seedRun(f.db, f.clock, p.id);
    const overrun = errors.budgetBlocked({ L: 10, C: 20, R: 0, U: 0, N: 0, total: 20, scope: 'run', allowed: false } as never);
    f.clock.advance(5);

    f.db.repos.runs.setDeferredPause(run.id, { reason: 'budget_overrun', detail: overrun });
    const set = f.db.repos.runs.get(run.id);
    f.db.repos.runs.setDeferredPause(run.id, { reason: 'approval_stale', detail: errors.approvalStale('scope_changed') });
    const replaced = f.db.repos.runs.get(run.id).deferredPause;
    f.db.repos.runs.setDeferredPause(run.id, null);

    expect(set.deferredPause).toEqual({ reason: 'budget_overrun', detail: overrun });
    expect(set.updatedAt).toBeGreaterThan(run.updatedAt);
    expect([replaced?.reason, replaced?.detail.code, replaced?.detail.details?.['reason']]).toEqual(['approval_stale', 'APPROVAL_STALE', 'scope_changed']);
    expect(f.db.repos.runs.get(run.id).deferredPause).toBeNull();
    expect(f.db.repos.runs.get(other.id).deferredPause).toBeNull(); // only the addressed run
  });

  it('survives a status change (it is not part of the status CAS)', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    f.db.repos.runs.setDeferredPause(run.id, { reason: 'budget_overrun', detail: errors.budgetBlocked({ L: 1, C: 2, R: 0, U: 0, N: 0, total: 2, scope: 'run', allowed: false } as never) });

    expect(f.db.repos.runs.updateStatus(run.id, ['queued'], 'paused', { pauseReason: 'user' })).toBe(true);

    expect(f.db.repos.runs.get(run.id).deferredPause?.reason).toBe('budget_overrun');
  });
});

describe('LedgerRepo.attemptsOverran (§9.5: some attempt settled more than it reserved)', () => {
  const setup = () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const step = seedStep(f.db, f.clock, run.id);
    const e = (x: Partial<LedgerEntryInsert> & Pick<LedgerEntryInsert, 'type' | 'bucket' | 'deltaMicrousd'>): LedgerEntryInsert => ({ scope: 'run', runId: run.id, projectId: p.id, ...x });
    const settleAt = (attemptId: AttemptId, N: number, X: number, runId: RunId = run.id) => {
      const on = (x: Parameters<typeof e>[0]) => ({ ...e(x), runId });
      f.db.repos.ledger.append([on({ type: 'reserve', bucket: 'reserved', deltaMicrousd: N, attemptId })]);
      f.db.repos.ledger.append([on({ type: 'release', bucket: 'reserved', deltaMicrousd: -N, attemptId }), on({ type: 'settle', bucket: 'settled', deltaMicrousd: X, attemptId, certainty: 'calculated' })]);
    };
    return { p, run, step, e, settleAt };
  };

  it('false with no entries, false at X = N (inclusive), true at X > N; the inspector projection agrees', () => {
    const { run, step, e, settleAt } = setup();
    expect(f.db.repos.ledger.attemptsOverran(run.id)).toBe(false);
    f.db.repos.ledger.append([e({ type: 'allowance_set', bucket: 'allowance', deltaMicrousd: 1_000_000 })]);

    settleAt(seedAttempt(f.db, f.clock, run.id, step.id).id, 1000, 1000);
    const atEqual = f.db.repos.ledger.attemptsOverran(run.id);
    settleAt(seedAttempt(f.db, f.clock, run.id, step.id).id, 1000, 1001);

    expect(atEqual).toBe(false);
    expect(f.db.repos.ledger.attemptsOverran(run.id)).toBe(true);
    expect(f.db.repos.runs.getInspectorProjection(run.id).attemptsOverran).toBe(true);
    expect(f.db.repos.ledger.runBalances(run.id).L).toBe(1_000_000); // overran regardless of L (R3-2)
  });

  it('is per attempt: one attempt under and another over in total do not hide each other, and other runs never count', () => {
    const { p, run, step, settleAt } = setup();
    const other = seedRun(f.db, f.clock, p.id);
    const otherStep = seedStep(f.db, f.clock, other.id);
    settleAt(seedAttempt(f.db, f.clock, run.id, step.id).id, 5000, 100); // far under
    settleAt(seedAttempt(f.db, f.clock, other.id, otherStep.id).id, 100, 900, other.id); // the other run overran

    expect(f.db.repos.ledger.attemptsOverran(run.id)).toBe(false);
    expect(f.db.repos.ledger.attemptsOverran(other.id)).toBe(true);
    settleAt(seedAttempt(f.db, f.clock, run.id, step.id).id, 100, 101); // run total still under: 5100 reserved vs 201 settled
    expect(f.db.repos.ledger.attemptsOverran(run.id)).toBe(true);
  });

  it('an unknown resolved at the full estimate (resolve_unknown + settle N, no reserve on that group) is not an overrun', () => {
    const { run, step, e } = setup();
    const a = seedAttempt(f.db, f.clock, run.id, step.id).id;
    f.db.repos.ledger.append([e({ type: 'reserve', bucket: 'reserved', deltaMicrousd: 1000, attemptId: a })]);
    f.db.repos.ledger.append([e({ type: 'release', bucket: 'reserved', deltaMicrousd: -1000, attemptId: a }), e({ type: 'move_to_unknown', bucket: 'unknown', deltaMicrousd: 1000, attemptId: a })]);
    f.db.repos.ledger.append([e({ type: 'resolve_unknown', bucket: 'unknown', deltaMicrousd: -1000, attemptId: a }), e({ type: 'settle', bucket: 'settled', deltaMicrousd: 1000, attemptId: a, certainty: 'estimated' })]);

    expect(f.db.repos.ledger.attemptsOverran(run.id)).toBe(false);
  });
});

describe('RunRepo.listTerminalWithoutReport (06 F17 crash-safety)', () => {
  it('lists terminal runs without a report artifact, oldest first, and drops a run once its report row exists', () => {
    const p = seedProject(f.db, f.clock);
    const runs: Record<string, RunId> = {};
    for (const [name, to] of [['done', 'completed'], ['inc', 'incomplete'], ['can', 'cancelled'], ['fail', 'failed'], ['queued', null], ['paused', 'paused']] as const) {
      f.clock.advance(10);
      const run = seedRun(f.db, f.clock, p.id);
      runs[name] = run.id;
      if (to === 'paused') f.db.repos.runs.updateStatus(run.id, ['queued'], 'paused', { pauseReason: 'user' });
      else if (to !== null) f.db.repos.runs.updateStatus(run.id, ['queued'], to, {});
    }
    const listed = () => f.db.repos.runs.listTerminalWithoutReport().map((r) => r.id);

    expect(listed()).toEqual([runs['done'], runs['inc'], runs['can'], runs['fail']]);
    insertReport(p.id, runs['done'] as RunId);
    expect(listed()).toEqual([runs['inc'], runs['can'], runs['fail']]);
  });

  function insertReport(projectId: ProjectId, runId: RunId): void {
    f.db.repos.artifacts.insertIfAbsent({ id: newId('artifact'), runId, projectId, kind: 'report', relPath: `artifacts/${runId}/r`, sha256: sha('e'), sizeBytes: 1,
      mediaType: 'application/json', schemaId: 'report.v1', createdAt: f.clock.now() });
  }
});

describe('ApprovalRepo.listForRun', () => {
  it('returns every approval of the run (decided, invalidated, pending) oldest first, and none of another run', () => {
    const p = seedProject(f.db, f.clock);
    const run = seedRun(f.db, f.clock, p.id);
    const other = seedRun(f.db, f.clock, p.id);
    const step = seedStep(f.db, f.clock, run.id, { stepKey: 'approve' });
    const plan = f.db.repos.artifacts.insertIfAbsent({ id: newId('artifact'), runId: run.id, projectId: p.id, kind: 'plan', relPath: 'artifacts/run/plan', sha256: sha('1'),
      sizeBytes: 1, mediaType: 'application/json', createdAt: f.clock.now() });
    const insert = () => {
      f.clock.advance(1);
      return f.db.repos.approvals.insert({ id: newId('approval'), runId: run.id, stepRunId: step.id, planArtifactId: plan.id, planHash: sha('2'), contextHash: sha('3'),
        fileScope: [], requestedPermissions: { providers: ['fake'] }, createdAt: f.clock.now() });
    };
    const a = insert();
    f.db.repos.approvals.decide(a.id, 'revision_requested', 'More tests.', epochMs(f.clock.now()));
    const b = insert();
    f.db.repos.approvals.invalidate(b.id, 'scope_changed', epochMs(f.clock.now()));
    const c = insert();

    const listed = f.db.repos.approvals.listForRun(run.id);

    expect(listed.map((x) => [x.id, x.decision, x.decisionNote, x.invalidatedReason])).toEqual([
      [a.id, 'revision_requested', 'More tests.', null], [b.id, null, null, 'scope_changed'], [c.id, null, null, null],
    ]);
    expect(f.db.repos.approvals.listForRun(other.id)).toEqual([]);
  });
});
