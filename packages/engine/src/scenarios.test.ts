// Engine-level F7 / F10 / F2 scenarios on the named fake provider scripts (04 §D7), driven tick by tick on manual
// timers. Each scenario ends paused (never failed, R3-1) and the matching user decision resumes it.
import { afterEach, describe, expect, it } from 'vitest';
import { computeCost } from '@relay/contracts';
import type { RunId, StepKey } from '@relay/contracts';
import type { Repos } from '@relay/storage';
import { createHarness } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';
import { drive, driveThroughApproval } from './testing/drive.js';
import { tick } from './runner.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function start(o: HarnessOptions & { budgetMicrousd?: number } = {}): Promise<{ x: Harness; runId: RunId }> {
  const x = await createHarness(o);
  h = x;
  const runId = await x.startRun(o.budgetMicrousd === undefined ? {} : { budgetMicrousd: o.budgetMicrousd });
  return { x, runId };
}

const rowsOf = (r: Repos, runId: RunId, key: string) => r.steps.listForRun(runId).filter((s) => s.stepKey === (key as StepKey));
/** The step key's attempts in dispatch order (row order, then seq). */
const attemptsOf = (r: Repos, runId: RunId, key: string) => rowsOf(r, runId, key).flatMap((s) => [...r.attempts.listForStep(s.id)].sort((a, b) => a.seq - b.seq));
const ledgerTypes = (r: Repos, runId: RunId) => {
  const page = r.ledger.list(runId, { limit: 200, sort: 'created_asc' });
  return page.ok ? page.value.items : [];
};

describe('F7 retry scenarios (fake provider)', () => {
  it('malformed-twice: schema_repair carries the issues, exhaustion fails the step → paused(output_invalid); retryStep → new row (user_retry) → completes', async () => {
    const { x, runId } = await start({ scenario: 'malformed-twice' });

    expect(await drive(x, runId, ['paused'])).toBe('paused');

    const r = x.db.repos;
    expect(r.runs.get(runId).pauseReason).toBe('output_invalid');
    const [initial, repair] = attemptsOf(r, runId, 'review');
    expect([initial?.purpose, repair?.purpose]).toEqual(['initial', 'schema_repair']);
    expect(initial?.error?.code).toBe('OUTPUT_INVALID');
    expect(rowsOf(r, runId, 'review')[0]).toEqual(expect.objectContaining({ state: 'failed', schemaRepairsUsed: 1 }));
    expect(ledgerTypes(r, runId).filter((e) => e.type === 'settle')).toHaveLength(2); // invalid output is still charged

    const failed = rowsOf(r, runId, 'review')[0];
    const retried = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'retry-step-key-01', runId, stepId: failed?.id ?? '' });
    expect(retried.ok && retried.data.status).toBe('queued');
    const rows = rowsOf(r, runId, 'review');
    expect(rows.map((s) => [s.retryIndex, s.state, s.schemaRepairsUsed])).toEqual([[0, 'failed', 1], [1, 'ready', 0]]);

    expect(await driveThroughApproval(x, runId, ['completed'])).toBe('completed');
    expect(attemptsOf(r, runId, 'review').map((a) => a.purpose)).toEqual(['initial', 'schema_repair', 'user_retry']);
    const replay = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'retry-step-key-01', runId, stepId: failed?.id ?? '' });
    expect(replay.ok && rowsOf(r, runId, 'review')).toHaveLength(2); // never re-applied
  });

  it('server-error-twice: 5xx before body → transport_retry after a 2 s not_before_at, then paused(provider_unavailable)', async () => {
    const { x, runId } = await start({ scenario: 'server-error-twice' });

    expect(await drive(x, runId, ['paused'])).toBe('paused');

    const r = x.db.repos;
    expect(r.runs.get(runId).pauseReason).toBe('provider_unavailable');
    const [first, second] = attemptsOf(r, runId, 'review');
    expect([first?.purpose, second?.purpose]).toEqual(['initial', 'transport_retry']);
    expect((second?.createdAt ?? 0) - (first?.finishedAt ?? 0)).toBeGreaterThanOrEqual(2_000);
    expect(rowsOf(r, runId, 'review')[0]).toEqual(expect.objectContaining({ state: 'failed', transportRetriesUsed: 1 }));
    expect(r.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: 0, C: 0 })); // no usage on a 5xx
    const detail = await x.engine.handle('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.availableActions).toEqual(['retry_step', 'choose_profile', 'stop', 'export_report']);
  });

  it('rate-limit-exhausted: waits persist on the step with not_before_at (≤ 60 s), then paused(rate_limited); resume resets the counter', async () => {
    const { x, runId } = await start({ scenario: 'rate-limit-exhausted' });

    expect(await drive(x, runId, ['paused'])).toBe('paused');

    const r = x.db.repos;
    expect(r.runs.get(runId).pauseReason).toBe('rate_limited');
    expect(attemptsOf(r, runId, 'review').map((a) => a.purpose)).toEqual(['initial', 'initial', 'initial', 'initial']);
    const step = rowsOf(r, runId, 'review')[0];
    expect(step).toEqual(expect.objectContaining({ state: 'ready', rateLimitWaitsUsed: 3 }));

    const resumed = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'resume-rate-key-01', runId, decision: { kind: 'continue' } });

    expect(resumed.ok && resumed.data.status).toBe('queued');
    expect(rowsOf(r, runId, 'review')[0]).toEqual(expect.objectContaining({ state: 'ready', rateLimitWaitsUsed: 0, notBeforeAt: null }));
  });

  it('refused: step failed MODEL_REFUSED → paused(model_refused); retryStep with another profile records a config revision (reason model_refused)', async () => {
    const { x, runId } = await start({ scenario: 'refused' });

    expect(await drive(x, runId, ['paused'])).toBe('paused');

    const r = x.db.repos;
    expect(r.runs.get(runId).pauseReason).toBe('model_refused');
    const failed = rowsOf(r, runId, 'review')[0];
    const capable = r.profiles.getByName('Capable');
    const settledBefore = ledgerTypes(r, runId).filter((e) => e.type === 'settle').map((e) => e.deltaMicrousd);

    const res = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'retry-refused-001', runId, stepId: failed?.id ?? '', profileId: capable?.id ?? '' });

    expect(res.ok && res.data.status).toBe('queued');
    expect(r.configRevisions.list(runId).map((c) => [c.stepKey, c.reason, c.profileSnapshot.name])).toEqual([['review', 'model_refused', 'Capable']]);
    expect(rowsOf(r, runId, 'review').at(-1)).toEqual(expect.objectContaining({ retryIndex: 1, profileName: 'Capable', state: 'ready' }));
    expect(r.events.list(runId, 0, 1000).some((e) => e.type === 'run.config_revised')).toBe(true);
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    expect(attemptsOf(r, runId, 'review').at(-1)?.modelId).toBe(capable?.modelId);
    expect(ledgerTypes(r, runId).filter((e) => e.type === 'settle').slice(0, settledBefore.length).map((e) => e.deltaMicrousd)).toEqual(settledBefore);
  });

  it('midstream-error: responded_partial → uncertain (never auto-retried) → settled at once as an estimate → paused(unknown_outcome)', async () => {
    const { x, runId } = await start({ scenario: 'midstream-error' });

    expect(await drive(x, runId, ['paused'])).toBe('paused');

    const r = x.db.repos;
    const [a] = attemptsOf(r, runId, 'review');
    expect(r.runs.get(runId).pauseReason).toBe('unknown_outcome');
    expect(a?.state).toBe('unknown');
    expect(a?.usage?.partial).toBe(true);
    // Decision 1: input tokens of the estimate + the output streamed so far, at the attempt's prices; R back to 0, U stays 0.
    const estimate = expectedEstimate(a!);
    expect(estimate).toBeGreaterThan(0);
    expect(r.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: 0, C: estimate }));
    expect(r.ledger.attemptBalances(a!.id)).toEqual({ reserved: 0, unknown: 0, settled: estimate });
    expect(r.ledger.settledByCertainty(runId).estimated).toBe(estimate);
    expect(a).toEqual(expect.objectContaining({ outcomeUncertain: true, mayNotHaveBeenCharged: false })); // bytes came back
    const detail = await x.engine.handle('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.availableActions).toEqual(['retry_step', 'stop', 'export_report']);
    expect(detail.ok && detail.data.cost.hasEstimates).toBe(true);
    expect(detail.ok && detail.data.unresolvedAttempts).toEqual([]);
    expect(detail.ok && detail.data.uncertainAttempts.map((v) => [v.id, v.cost, v.mayNotHaveBeenCharged])).toEqual([[a!.id, { microusd: estimate, certainty: 'estimated' }, false]]);
  });
});

/** Decision 1: the estimate of an uncertain attempt, computed independently of the engine. */
function expectedEstimate(a: { estimate: unknown; usage: { outputTokens: number } | null; profileSnapshot: { prices: Parameters<typeof computeCost>[1] } }): number {
  const inputTokens = (a.estimate as { inputTokens: number }).inputTokens;
  return computeCost({ uncachedInputTokens: inputTokens, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: a.usage?.outputTokens ?? 0 }, a.profileSnapshot.prices).microusd;
}

describe('uncertain outcome (decision 1): estimate settled at once, retry_step or stop', () => {
  async function uncertainReview() {
    const { x, runId } = await start({ scenario: 'midstream-error' });
    await drive(x, runId, ['paused']);
    const [a] = attemptsOf(x.db.repos, runId, 'review');
    if (a === undefined) throw new Error('no attempt');
    return { x, runId, a };
  }

  it('retry_step ("may incur another charge"): the uncertain attempt is abandoned with its estimate kept once, a new row retries it and the run completes', async () => {
    const { x, runId, a } = await uncertainReview();
    const estimate = expectedEstimate(a);
    const step = rowsOf(x.db.repos, runId, 'review')[0]!;

    const res = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'retry-uncertain-01', runId, stepId: step.id });

    const r = x.db.repos;
    expect(res.ok && res.data.status).toBe('queued');
    expect(r.attempts.get(a.id).state).toBe('abandoned');
    expect(rowsOf(r, runId, 'review').map((s) => [s.retryIndex, s.state])).toEqual([[0, 'failed'], [1, 'ready']]);
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    expect(attemptsOf(r, runId, 'review').at(-1)).toEqual(expect.objectContaining({ purpose: 'user_retry', state: 'succeeded' }));
    // The estimate is counted exactly once; nothing is reserved or unknown after the uncertain attempt.
    expect(r.ledger.attemptBalances(a.id)).toEqual({ reserved: 0, unknown: 0, settled: estimate });
    expect(r.ledger.runBalances(runId)).toEqual(expect.objectContaining({ R: 0, U: 0 }));
  });

  it('never auto-retries: the loop keeps the run paused until the user decides', async () => {
    const { x, runId } = await uncertainReview();
    for (let i = 0; i < 5; i += 1) await tick(x.ctx);
    expect(x.db.repos.runs.get(runId).status).toBe('paused');
    expect(attemptsOf(x.db.repos, runId, 'review')).toHaveLength(1);
  });

  it('runs.decideUnknown is retired: CONFLICT decision_not_applicable for any attempt; continue is refused', async () => {
    const { x, runId, a } = await uncertainReview();

    const decide = await x.engine.handle('relay/v1/runs.decideUnknown', { idempotencyKey: 'decide-unknown-01', runId, attemptId: a.id, decision: 'accept_estimated_charge' });
    const other = await x.engine.handle('relay/v1/runs.decideUnknown', { idempotencyKey: 'decide-unknown-02', runId, attemptId: 'att_01J9ZZZZZZZZZZZZZZZZZZZZZ0', decision: 'accept_estimated_charge' });
    const cont = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'resume-uncertain-01', runId, decision: { kind: 'continue' } });

    expect(decide.ok ? null : [decide.error.code, decide.error.details?.['reason']]).toEqual(['CONFLICT', 'decision_not_applicable']);
    expect(other.ok ? null : other.error.details?.['reason']).toBe('decision_not_applicable');
    expect(cont.ok ? null : cont.error.details?.['reason']).toBe('decision_not_applicable');
    expect(x.db.repos.attempts.get(a.id).state).toBe('unknown'); // nothing changed
  });
});

describe('runs.retryStep guards (F7)', () => {
  it('CONFLICT on a step that is not failed (budget pause keeps the row: switch_profile instead); at maxAttempts the retry pauses limit_attempts', async () => {
    const { x, runId } = await start({ scenario: 'malformed-twice' });
    await drive(x, runId, ['paused']);
    const r = x.db.repos;
    const failed = rowsOf(r, runId, 'review')[0];
    const intake = rowsOf(r, runId, 'intake')[0];

    const notFailed = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'retry-guard-0001', runId, stepId: intake?.id ?? '' });
    x.db.tx('immediate', (tx) => {
      tx.runs.setLimits(runId, { ...tx.runs.get(runId).limits, maxAttempts: tx.runs.get(runId).attemptCount });
    });
    const missing = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'retry-guard-0003', runId, stepId: 'stp_01J9ZZZZZZZZZZZZZZZZZZZZZ0' });
    const limit = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'retry-guard-0002', runId, stepId: failed?.id ?? '' });

    expect(notFailed.ok ? null : [notFailed.error.code, notFailed.error.details?.['reason']]).toEqual(['CONFLICT', 'step_not_failed']);
    expect(missing.ok ? null : missing.error.code).toBe('NOT_FOUND');
    // Finding 2: no LIMIT_REACHED dead end — the retry is accepted and the reserve checkpoint pauses limit_attempts.
    expect(limit.ok).toBe(true);
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    expect(r.runs.get(runId).pauseReason).toBe('limit_attempts');
  });

  it('rejects a profile whose provider the project does not permit (PERMISSION_DENIED) without writing anything', async () => {
    const { x, runId } = await start({ scenario: 'refused', allowedProviderIds: ['anthropic', 'fake'] });
    await drive(x, runId, ['paused']);
    const r = x.db.repos;
    const failed = rowsOf(r, runId, 'review')[0];
    const openai = r.profiles.getByName('Balanced · OpenAI');

    const res = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'retry-openai-001', runId, stepId: failed?.id ?? '', profileId: openai?.id ?? '' });

    expect(res.ok ? null : res.error.code).toBe('PERMISSION_DENIED');
    expect(r.configRevisions.list(runId)).toEqual([]);
    expect(rowsOf(r, runId, 'review')).toHaveLength(1);
  });
});

describe('budget pauses (F5 / F2 increaseAllowance, acknowledge_overrun)', () => {
  it('budget-exhaustion: paused(budget_run) when C + R + U + N > L; increaseAllowance writes allowance_change and auto-resumes when admission passes', async () => {
    const { x, runId } = await start({ scenario: 'budget-exhaustion', budgetMicrousd: 1_000 });

    expect(await drive(x, runId, ['paused', 'awaiting_approval'])).toBe('paused');
    const r = x.db.repos;
    expect(r.runs.get(runId).pauseReason).toBe('budget_run');
    const L = r.ledger.runBalances(runId).L;

    const tooSmall = await x.engine.handle('relay/v1/runs.increaseAllowance', { idempotencyKey: 'allow-key-00001', runId, newAllowanceMicrousd: L });
    const stillShort = await x.engine.handle('relay/v1/runs.increaseAllowance', { idempotencyKey: 'allow-key-00002', runId, newAllowanceMicrousd: L + 1 });
    const enough = await x.engine.handle('relay/v1/runs.increaseAllowance', { idempotencyKey: 'allow-key-00003', runId, newAllowanceMicrousd: 50_000_000 });
    const replay = await x.engine.handle('relay/v1/runs.increaseAllowance', { idempotencyKey: 'allow-key-00003', runId, newAllowanceMicrousd: 50_000_000 });

    expect(tooSmall.ok ? null : tooSmall.error.code).toBe('VALIDATION_FAILED');
    expect(stillShort.ok && [stillShort.data.status, stillShort.data.budget?.scope, stillShort.data.budget?.allowed]).toEqual(['paused', 'run', false]);
    expect(enough.ok && [enough.data.status, enough.data.budget, enough.data.cost.allowance]).toEqual(['queued', null, 50_000_000]);
    expect(replay.ok && replay.data.status).toBe('queued');
    expect(ledgerTypes(r, runId).filter((e) => e.type === 'allowance_change').map((e) => e.deltaMicrousd)).toEqual([1, 50_000_000 - L - 1]);
    expect(r.runs.get(runId).limits.budgetMicrousd).toBe(50_000_000);
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
  });

  it('switch_profile on paused(budget_run) appends a config revision (budget_cheaper_profile) and resumes; the step keeps its row', async () => {
    const { x, runId } = await start({ scenario: 'budget-exhaustion', budgetMicrousd: 1_000 });
    await drive(x, runId, ['paused', 'awaiting_approval']);
    const r = x.db.repos;
    const economy = r.profiles.getByName('Economy');
    const ready = rowsOf(r, runId, 'review');

    const retry = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'retry-budget-0001', runId, stepId: ready.at(-1)?.id ?? '' });
    const res = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'switch-key-000001', runId,
      decision: { kind: 'switch_profile', stepKey: 'review', profileId: economy?.id ?? '' } });

    expect(retry.ok ? null : retry.error.code).toBe('CONFLICT');
    expect(res.ok && res.data.status).toBe('queued');
    expect(r.configRevisions.list(runId).map((c) => [c.reason, c.profileSnapshot.name])).toEqual([['budget_cheaper_profile', 'Economy']]);
    expect(rowsOf(r, runId, 'review')).toHaveLength(ready.length);
    expect(rowsOf(r, runId, 'review').at(-1)?.profileName).toBe('Economy');
  });

  it('overrun: X > N pauses budget_overrun regardless of L; acknowledge_overrun → queued, and a replayed key never re-applies', async () => {
    const { x, runId } = await start({ scenario: 'overrun', budgetMicrousd: 100_000_000 });

    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const r = x.db.repos;
    expect(r.runs.get(runId).pauseReason).toBe('budget_overrun');
    const detail = await x.engine.handle('relay/v1/runs.get', { runId });
    expect(detail.ok && detail.data.availableActions).toEqual(['acknowledge_overrun', 'increase_allowance', 'stop', 'export_report']);

    const wrong = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'ack-key-0000001', runId, decision: { kind: 'continue' } });
    const ack = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'ack-key-0000002', runId, decision: { kind: 'acknowledge_overrun' } });
    const replay = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'ack-key-0000002', runId, decision: { kind: 'acknowledge_overrun' } });
    const reused = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'ack-key-0000002', runId, decision: { kind: 'continue' } });

    expect(wrong.ok ? null : wrong.error.details?.['reason']).toBe('decision_not_applicable');
    expect(ack.ok && ack.data.status).toBe('queued');
    expect(replay.ok && replay.data.status).toBe('queued');
    expect(reused.ok ? null : reused.error.details?.['reason']).toBe('idempotency_key_reused');
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
  });

  it('increaseAllowance on paused(budget_overrun) resumes when the next admission passes; a terminal run is CONFLICT', async () => {
    const { x, runId } = await start({ scenario: 'overrun', budgetMicrousd: 1_000_000 });
    await drive(x, runId, ['paused']);

    const res = await x.engine.handle('relay/v1/runs.increaseAllowance', { idempotencyKey: 'allow-overrun-01', runId, newAllowanceMicrousd: 90_000_000 });
    await x.engine.handle('relay/v1/runs.cancel', { runId });
    const terminal = await x.engine.handle('relay/v1/runs.increaseAllowance', { idempotencyKey: 'allow-overrun-02', runId, newAllowanceMicrousd: 99_000_000 });

    expect(res.ok && res.data.status).toBe('queued');
    expect(terminal.ok ? null : terminal.error.code).toBe('CONFLICT');
  });
});
