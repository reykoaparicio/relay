// 11 §K5 §17.1 provider failure rows (@m3) + the K2 variants (#patch, #badref, #truncated). Exhausted retries PAUSE the
// run (output_invalid / provider_unavailable / model_refused / rate_limited / auth_required / unknown_outcome); only
// UNRECOVERABLE fails it. Call-log assertions filter on FakeCall.stepKey / purpose.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScenario } from '@relay/providers';
import { expectNoNegativeReserved } from '../helpers/assert-ledger.js';
import { createHarness, sleep } from '../helpers/engine-harness.js';
import type { Harness } from '../helpers/engine-harness.js';
import { createManualClock } from '../helpers/manual-clock.js';
import { FIXTURES_DIR, cleanupTempDirs } from '../helpers/temp-dirs.js';
import { expectedEstimate } from './uncertain-estimate.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
  await cleanupTempDirs();
});

const variant = (name: string): unknown => JSON.parse(readFileSync(`${FIXTURES_DIR}provider-responses/${name}.json`, 'utf8')) as unknown;
const settled = (r: { status: string }) => r.status !== 'queued' && r.status !== 'running';

describe('failure modes @m3', () => {
  describe('#malformed', () => {
    it('malformed-then-ok: exactly one schema repair, then success @m3', async () => {
      h = await createHarness({ scenario: 'malformed-then-ok' });
      const runId = await h.startRun();

      await h.waitFor(runId, 'awaiting_approval');

      expect(h.calls({ runId, stepKey: 'review' }).map((c) => c.purpose)).toEqual(['initial', 'schema_repair']);
      expect(h.attempts(runId, 'review').map((a) => [a.purpose, a.state])).toEqual([['initial', 'failed'], ['schema_repair', 'succeeded']]);
      expect(h.steps(runId, 'review').map((s) => [s.state, s.schemaRepairsUsed])).toEqual([['succeeded', 1]]);
    });

    it('malformed-twice: step failed, run paused(output_invalid) with both attempts; retryStep → new step row (retry_index 1, fresh counters) → completes @m3', async () => {
      h = await createHarness({ scenario: 'malformed-twice' });
      const runId = await h.startRun();

      const paused = await h.waitFor(runId, settled);

      expect([paused.status, paused.pauseReason]).toEqual(['paused', 'output_invalid']);
      expect(h.attempts(runId, 'review').map((a) => a.purpose)).toEqual(['initial', 'schema_repair']);
      expect(h.calls({ runId, stepKey: 'review' }).map((c) => c.purpose)).toEqual(['initial', 'schema_repair']);
      expect(h.steps(runId, 'review').map((s) => [s.retryIndex, s.state, s.schemaRepairsUsed])).toEqual([[0, 'failed', 1]]);

      const retried = await h.retryStep(runId, 'review');
      expect(retried.ok && ['queued', 'running']).toContain(retried.ok ? retried.data.status : null); // RESUME_RESOLVED (the live loop may already run it)
      await h.waitFor(runId, 'awaiting_approval');
      expect(h.steps(runId, 'review').map((s) => [s.retryIndex, s.state, s.schemaRepairsUsed, s.transportRetriesUsed])).toEqual([[0, 'failed', 1, 0], [1, 'succeeded', 0, 0]]);
      await h.approve(runId);
      expect((await h.waitFor(runId, ['completed', 'paused', 'failed', 'incomplete'])).status).toBe('completed');
      expectNoNegativeReserved(h.db);
    });
  });

  describe('#transport', () => {
    it('server-error-twice: exactly 1 transport retry (2 calls, second transport_retry) → step failed → paused(provider_unavailable) @m3', async () => {
      h = await createHarness({ scenario: 'server-error-twice' });
      const runId = await h.startRun();

      const paused = await h.waitFor(runId, settled, 20_000);

      expect([paused.status, paused.pauseReason]).toEqual(['paused', 'provider_unavailable']);
      expect(h.calls({ runId, stepKey: 'review' }).map((c) => c.purpose)).toEqual(['initial', 'transport_retry']);
      expect(h.steps(runId, 'review').map((s) => [s.state, s.transportRetriesUsed])).toEqual([['failed', 1]]);
      expect(h.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: 0 }));
    });
  });

  describe('#rate-limit', () => {
    it('rate-limit-then-ok: the wait honors retryAfterMs (not_before_at persisted) → success (manual clock) @m3', async () => {
      const mc = createManualClock();
      h = await createHarness({ scenario: 'rate-limit-then-ok', clock: mc });
      const runId = await h.startRun();

      await h.waitUntil(() => h!.steps(runId, 'review')[0]?.notBeforeAt != null, 10_000, 'not_before_at set');
      const step = h.steps(runId, 'review')[0]!;
      expect(step.notBeforeAt! - mc.now()).toBe(1000);
      expect(step.rateLimitWaitsUsed).toBe(1);
      expect(h.calls({ runId, stepKey: 'review' })).toHaveLength(1);
      mc.advance(1_000);

      await h.waitFor(runId, 'awaiting_approval');
      expect(h.calls({ runId, stepKey: 'review' })).toHaveLength(2);
      expect(h.attempts(runId, 'review').map((a) => a.state)).toEqual(['failed', 'succeeded']);
    });

    it('a retry-after above 60 s is capped at 60 s @m3', async () => {
      const mc = createManualClock();
      const scenario: FakeScenario = { name: 'rate-limit-long', steps: [{ match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'rate_limited', retryAfterMs: 600_000 } }] };
      h = await createHarness({ scenario, clock: mc });
      const runId = await h.startRun();

      await h.waitUntil(() => h!.steps(runId, 'review')[0]?.notBeforeAt != null, 10_000, 'not_before_at set');

      expect(h.steps(runId, 'review')[0]!.notBeforeAt! - mc.now()).toBe(60_000);
      mc.advance(59_999);
      await sleep(50);
      expect(h.calls({ runId, stepKey: 'review' })).toHaveLength(1);
      mc.advance(1);
      await h.waitFor(runId, 'awaiting_approval');
      expect(h.calls({ runId, stepKey: 'review' })).toHaveLength(2);
    });

    it('rate-limit-exhausted: after the retryPolicy wait count (rate_limit_waits_used persisted) → paused(rate_limited) @m3', async () => {
      const mc = createManualClock();
      h = await createHarness({ scenario: 'rate-limit-exhausted', clock: mc });
      const runId = await h.startRun();

      for (let i = 0; i < 20 && !settled(h.db.repos.runs.get(runId)); i += 1) {
        await sleep(20);
        mc.advance(1_000);
      }
      const paused = await h.waitFor(runId, settled);

      expect([paused.status, paused.pauseReason]).toEqual(['paused', 'rate_limited']);
      const step = h.steps(runId, 'review')[0]!;
      expect(step.rateLimitWaitsUsed).toBe(3);
      expect(h.calls({ runId, stepKey: 'review' })).toHaveLength(4);
    });
  });

  describe('#refused', () => {
    it('refused → paused(model_refused); retryStep({ profileId: Capable }) → run_config_revisions row + new step row → succeeds @m3', async () => {
      h = await createHarness({ scenario: 'refused' });
      const runId = await h.startRun();

      const paused = await h.waitFor(runId, settled);
      expect([paused.status, paused.pauseReason]).toEqual(['paused', 'model_refused']);

      const capable = h.db.repos.profiles.getByName('Capable')!;
      const res = await h.retryStep(runId, 'review', { profileId: capable.id });

      expect(res.ok && ['queued', 'running']).toContain(res.ok ? res.data.status : null);
      expect(h.db.repos.configRevisions.list(runId).map((c) => [c.stepKey, c.reason, c.profileSnapshot.name])).toEqual([['review', 'model_refused', 'Capable']]);
      await h.waitFor(runId, 'awaiting_approval');
      expect(h.steps(runId, 'review').map((s) => [s.retryIndex, s.state])).toEqual([[0, 'failed'], [1, 'succeeded']]);
      expect(h.calls({ runId, stepKey: 'review' }).map((c) => c.modelId)).toEqual([h.attempts(runId, 'review')[0]!.modelId, capable.modelId]);
    });
  });

  describe('#midstream', () => {
    it('midstream-error → attempt uncertain (REQUEST_OUTCOME_UNKNOWN, responded_partial), settled at once as an estimate (input + streamed output), paused(unknown_outcome) offering retry_step / stop, no automatic retry @m3', async () => {
      h = await createHarness({ scenario: 'midstream-error' });
      const runId = await h.startRun();

      const paused = await h.waitFor(runId, settled);
      await sleep(100);

      expect([paused.status, paused.pauseReason]).toEqual(['paused', 'unknown_outcome']);
      const [a, ...rest] = h.attempts(runId, 'review');
      expect(rest).toEqual([]);
      expect(a?.state).toBe('unknown');
      expect(a?.error?.code).toBe('REQUEST_OUTCOME_UNKNOWN');
      expect(a?.usage?.partial).toBe(true); // responded_partial: partial usage recorded (the phase itself is not persisted)
      const entries = h.db.repos.ledger.list(runId, { limit: 100, sort: 'created_asc' });
      expect(entries.ok && entries.value.items.filter((e) => e.attemptId === a!.id).map((e) => [e.type, e.certainty])).toEqual([['reserve', null], ['release', null], ['settle', 'estimated']]);
      const E = expectedEstimate(a!); // partial usage: the output streamed before the failure
      expect(a!.usage!.outputTokens).toBeGreaterThan(0);
      expect(h.db.repos.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: 0, C: E }));
      expect([a!.outcomeUncertain, a!.mayNotHaveBeenCharged]).toEqual([true, false]);
      const detail = await h.call('relay/v1/runs.get', { runId });
      expect(detail.ok && detail.data.availableActions).toEqual(['retry_step', 'stop', 'export_report']);
      expect(h.calls({ runId })).toHaveLength(1); // never auto-retried
    });
  });

  describe('#auth', () => {
    it('auth-fail → paused(auth_required) after exactly 1 call (no retry loop) @m3', async () => {
      h = await createHarness({ scenario: 'auth-fail' });
      const runId = await h.startRun();

      const paused = await h.waitFor(runId, settled);
      await sleep(100);

      expect([paused.status, paused.pauseReason]).toEqual(['paused', 'auth_required']);
      expect(h.calls({ runId })).toHaveLength(1);
    });
  });

  describe('#patch', () => {
    it('patch.does-not-apply on implement → output_invalid path → paused(output_invalid) @m3', async () => {
      const scenario: FakeScenario = { name: 'patch-does-not-apply', steps: [{ match: { stepKey: 'implement' }, times: Infinity, result: { kind: 'success', fixture: 'patch.does-not-apply' } }] };
      h = await createHarness({ scenario, extraFixtures: { 'patch.does-not-apply': variant('patch.does-not-apply') } });
      const runId = await h.startRun();
      await h.waitFor(runId, 'awaiting_approval');
      await h.approve(runId);

      const paused = await h.waitFor(runId, (r) => r.status === 'paused' || r.status === 'completed' || r.status === 'failed');

      expect([paused.status, paused.pauseReason]).toEqual(['paused', 'output_invalid']);
      const [first] = h.attempts(runId, 'implement');
      expect(first?.error?.code).toBe('OUTPUT_INVALID');
      expect(JSON.stringify(first?.error)).toContain('diff_does_not_apply');
      expect(h.calls({ runId, stepKey: 'implement' }).map((c) => c.purpose)).toEqual(['initial', 'schema_repair']);
    });
  });

  describe('#badref', () => {
    it('findings.bad-ref cites nonexistent files → semantic validation failure → paused(output_invalid) @m3', async () => {
      const scenario: FakeScenario = { name: 'bad-ref', steps: [{ match: { stepKey: 'review' }, times: Infinity, result: { kind: 'success', fixture: 'findings.bad-ref' } }] };
      h = await createHarness({ scenario, extraFixtures: { 'findings.bad-ref': variant('findings.bad-ref') } });
      const runId = await h.startRun();

      const paused = await h.waitFor(runId, settled);

      expect([paused.status, paused.pauseReason]).toEqual(['paused', 'output_invalid']);
      const [first] = h.attempts(runId, 'review');
      expect(first?.error?.code).toBe('OUTPUT_INVALID');
      expect(JSON.stringify(first?.error?.details)).toMatch(/users\.ts|validation\.ts/);
    });
  });

  describe('#truncated', () => {
    it('the intentionally incomplete truncated.json reply → OUTPUT_INVALID (repair, then paused(output_invalid)); the raw reply is kept as text/plain @m3', async () => {
      const text = readFileSync(`${FIXTURES_DIR}provider-responses/truncated.json`, 'utf8');
      expect(() => JSON.parse(text) as unknown).toThrow();
      const scenario: FakeScenario = { name: 'truncated-text', steps: [{ match: { stepKey: 'review' }, times: Infinity, result: { kind: 'malformed', text } }] };
      h = await createHarness({ scenario });
      const runId = await h.startRun();

      const paused = await h.waitFor(runId, settled);

      expect([paused.status, paused.pauseReason]).toEqual(['paused', 'output_invalid']);
      const [first] = h.attempts(runId, 'review');
      const raw = h.db.repos.artifacts.listForRun(runId, ['raw_response']).find((x) => x.attemptId === first!.id);
      expect(raw?.mediaType).toMatch(/^text\/plain/);
    });

    it('a provider-truncated reply (max tokens) never succeeds silently @m3', async () => {
      h = await createHarness({ scenario: { name: 'truncated', steps: [{ match: { stepKey: 'review' }, times: Infinity, result: { kind: 'truncated' } }] } });
      const runId = await h.startRun();

      const paused = await h.waitFor(runId, settled);

      expect(paused.status).toBe('paused');
      expect(h.steps(runId, 'review').at(-1)?.state).not.toBe('succeeded');
      expectNoNegativeReserved(h.db);
    });
  });
});
