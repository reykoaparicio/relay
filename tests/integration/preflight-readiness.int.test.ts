// 06 F13 runChecks + F14 preflight (Referee audit item 1): a profile whose provider has no credential ref is listed by
// `runs.preflight`, and a run started anyway pauses `auth_required` at `queued` — before any attempt, reservation, or
// provider call — with an actionable reason. Recording the credential and resuming completes the run.
import { afterEach, describe, expect, it } from 'vitest';
import { expectNoNegativeReserved } from '../helpers/assert-ledger.js';
import { DEFAULT_REL_PATHS, createHarness } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { cleanupTempDirs } from '../helpers/temp-dirs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

describe('preflight readiness @m3', () => {
  it('no anthropic credential → preflight lists it per step; the run never creates an attempt and pauses auth_required; credential + resume completes @m3', async () => {
    h = await createHarness({ credentialRefs: ['openai', 'gemini', 'fake'] });

    const pre = await h.call('relay/v1/runs.preflight', { projectId: h.projectId, workflowId: h.workflowId, workflowVersion: 1,
      goal: 'Fix the defects in the handlers.', input: { kind: 'files', relPaths: [...DEFAULT_REL_PATHS] } });
    if (!pre.ok) throw new Error(pre.error.code);
    expect(pre.data.issues.map((i) => [i.path, i.code])).toEqual(['review', 'plan', 'implement', 'verify']
      .map((k) => [`profileOverrides.${k}`, 'missing_credential']));

    const runId = await h.startRun();
    const paused = await h.waitFor(runId, (r) => r.status !== 'queued');

    expect([paused.status, paused.pauseReason, paused.statusDetail?.code]).toEqual(['paused', 'auth_required', 'AUTH_REQUIRED']);
    expect(h.db.repos.attempts.listForRun(runId)).toEqual([]);
    expect(h.calls({ runId })).toEqual([]);
    const ledger = h.db.repos.ledger.list(runId, { limit: 50, sort: 'created_asc' });
    expect(ledger.ok && ledger.value.items.map((e) => e.type)).toEqual(['allowance_set']); // no reservation
    const trail = h.db.repos.events.list(runId, 0, 100).filter((e) => e.type === 'run.status_changed').map((e) => (e.payload as { to: string }).to);
    expect(trail).toEqual(['paused']); // queued → paused: it never ran
    const detail = await h.call('relay/v1/runs.get', { runId });
    // No credential ref yet: resume cannot succeed, so only reconnect/stop are offered — and resume is refused.
    expect(detail.ok && detail.data.availableActions).toEqual(['reconnect_provider', 'stop']);
    const early = await h.resume(runId, { kind: 'continue' }, 'resume-before-credential');
    expect(early.ok ? 'ok' : early.error.code).toBe('AUTH_REQUIRED');
    expect(h.db.repos.runs.get(runId).status).toBe('paused');

    const ref = await h.call('relay/v1/providers.recordCredentialRef', { providerId: 'anthropic', storageMode: 'session', vaultFile: null, redactedLabel: 'sk-…test' });
    expect(ref.ok).toBe(true);
    const resumed = await h.resume(runId, { kind: 'continue' });
    expect(resumed.ok && resumed.data.status).toBe('queued');
    await h.waitFor(runId, 'awaiting_approval');
    await h.approve(runId);
    const done = await h.waitFor(runId, ['completed', 'incomplete', 'paused', 'failed']);

    expect(done.status).toBe('completed');
    expect(h.attempts(runId).map((a) => a.state)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    expectNoNegativeReserved(h.db);
  });
});
