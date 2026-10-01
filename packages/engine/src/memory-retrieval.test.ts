import { afterEach, describe, expect, it } from 'vitest';
import { epochMs, providerPolicySchema } from '@relay/contracts';
import type { MemoryId, MemoryRecordScope, MemoryStatus, MemoryType, ProjectId } from '@relay/contracts';
import { snapshotMemoryForRun } from './memory.js';
import type { RetrievableRecord } from './memory-retrieval.js';
import { MAX_RUN_SUMMARIES, PINNED_SCORE, applyMemoryScope, excessRunSummaries, rankMemory, scoreRecord, tokenize } from './memory-retrieval.js';
import { createHarness } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const rec = (id: string, o: Partial<RetrievableRecord> = {}): RetrievableRecord => ({
  id: `mem_01J9ZZZZZZZZZZZZZZZZZZZZ${id}` as MemoryId, revision: 1, type: 'project_decision', title: 'T', content: 'nothing relevant here',
  pinned: false, scope: { roles: 'all' }, sourcePaths: [], stale: false, ...o,
});

describe('memory retrieval ranking (07 G2)', () => {
  it('tokenizes lowercase on non-alphanumerics and drops stopwords and 1-char tokens', () => {
    expect([...tokenize('Fix the User-Handler, and validate a x!')]).toEqual(['fix', 'user', 'handler', 'validate']);
  });

  it('scores 2·goal overlap + 3·sourceRef path overlap + type weight; pinned records score PINNED_SCORE', () => {
    const goal = tokenize('validate user input');
    const inputs = new Set(['src/a.ts']);

    expect(scoreRecord(rec('A0', { content: 'Always validate user fields', type: 'user_rule' }), goal, inputs)).toBe(2 * 2 + 3);
    expect(scoreRecord(rec('A1', { sourcePaths: ['src/a.ts', 'src/b.ts'], type: 'source_reference' }), goal, inputs)).toBe(3 + 1);
    expect(scoreRecord(rec('A2', { type: 'run_summary' }), goal, inputs)).toBe(0.5);
    expect(scoreRecord(rec('A3', { pinned: true }), goal, inputs)).toBe(PINNED_SCORE);
  });

  it('orders by score then id, marks only pinned user_rules mandatory, and keeps at most 2 run summaries', () => {
    const records = [
      rec('B1', { type: 'run_summary', content: 'validate input' }),
      rec('B2', { type: 'run_summary' }),
      rec('B3', { type: 'run_summary', content: 'validate' }),
      rec('B4', { type: 'user_rule', pinned: true }),
      rec('B5', { type: 'run_summary', pinned: true }),
      rec('B6', { type: 'project_decision', content: 'validate input' }),
      rec('B7', { type: 'project_decision', content: 'validate input' }),
    ];

    const ranked = rankMemory(records, { goal: 'validate input', role: 'reviewer', inputPaths: [] });

    expect(ranked.map((r) => r.id.slice(-2))).toEqual(['B4', 'B5', 'B6', 'B7', 'B1']);
    expect(ranked.filter((r) => r.type === 'run_summary')).toHaveLength(MAX_RUN_SUMMARIES);
    expect(ranked.filter((r) => r.mandatory).map((r) => r.id.slice(-2))).toEqual(['B4']);
    expect(excessRunSummaries(records, ranked).map((r) => r.id.slice(-2))).toEqual(['B2', 'B3']);
  });

  it('applies the step memoryScope (types + step role); pinned user rules bypass only the step filter, never their own role scope (BH-4)', () => {
    const records = [
      rec('C1', { type: 'user_rule', scope: { roles: ['planner'] } }),
      rec('C2', { type: 'user_rule', scope: { roles: ['reviewer'] } }),
      rec('C3', { type: 'run_summary' }),
      rec('C4', { type: 'user_rule', pinned: true, scope: { roles: ['planner'] } }),
      rec('C5', { type: 'user_rule', pinned: true, scope: { roles: 'all' } }),
    ];

    const stepRole = applyMemoryScope(records, { roles: 'step_role', types: ['user_rule'] }, 'reviewer');
    const allRoles = applyMemoryScope(records, { roles: 'all', types: ['user_rule', 'run_summary'] }, 'reviewer');
    const summariesOnly = applyMemoryScope(records, { roles: 'step_role', types: ['run_summary'] }, 'reviewer');
    const planner = applyMemoryScope(records, { roles: 'step_role', types: [] }, 'planner');

    expect(stepRole.map((r) => r.id.slice(-2))).toEqual(['C2', 'C5']);
    expect(allRoles.map((r) => r.id.slice(-2))).toEqual(['C1', 'C2', 'C3', 'C5']); // a pinned planner rule never reaches the reviewer
    expect(summariesOnly.map((r) => r.id.slice(-2))).toEqual(['C3', 'C5']); // pinned bypasses the step's types filter
    expect(planner.map((r) => r.id.slice(-2))).toEqual(['C4', 'C5']);
  });
});

describe('memory candidates (project isolation, §10.5)', () => {
  function add(x: Harness, projectId: ProjectId, o: { status?: MemoryStatus; scope?: MemoryRecordScope; expiresAt?: number; type?: MemoryType; pinned?: boolean } = {}): MemoryId {
    const item = x.db.repos.memory.insertRecord(
      { id: x.ids.next('memory'), projectId, type: o.type ?? 'user_rule', status: o.status ?? 'approved', scope: o.scope ?? { roles: 'all' },
        pinned: o.pinned ?? false, ...(o.expiresAt === undefined ? {} : { expiresAt: epochMs(o.expiresAt) }), createdAt: x.clock.now() },
      { id: x.ids.next('memoryRevision'), title: 'Rule', content: 'Never cast body fields.', sourceRefs: [], author: 'user', createdAt: x.clock.now() },
    );
    return item.record.id;
  }

  it('snapshots only approved, unexpired records of the run project; suggestions and other projects never enter', async () => {
    const x = await createHarness();
    h = x;
    const other = x.db.repos.projects.insert({ id: x.ids.next('project'), name: 'B', rootRealpath: '/nonexistent/relay-b', rootDisplayPath: '~/b', exclusions: [],
      providerPolicy: providerPolicySchema.parse({ allowedProviderIds: ['fake'] }), monthlyAllowanceMicrousd: null, isDemo: false, createdAt: x.clock.now() });
    const now = x.clock.now();
    const approved = add(x, x.projectId);
    const planner = add(x, x.projectId, { scope: { roles: ['planner'] } });
    add(x, x.projectId, { status: 'suggested' });
    add(x, x.projectId, { status: 'archived' });
    add(x, x.projectId, { expiresAt: now - 1 });
    const foreign = add(x, other.id);
    const runId = await x.startRun();

    const res = x.db.tx('immediate', (r) => snapshotMemoryForRun(r, runId, x.projectId, now));
    const snap = x.db.repos.memory.runSnapshot(runId).map((s) => s.recordId);

    expect(res.ok).toBe(true);
    expect(new Set(snap)).toEqual(new Set([approved, planner]));
    expect(snap).not.toContain(foreign);
  });
});
