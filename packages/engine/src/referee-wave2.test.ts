// Regression tests for the Referee-confirmed Wave-2 engine bugs BH-1…BH-7 and the resnapshot_and_replan storage
// follow-up. Each test fails on the pre-fix code.
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { afterEach, describe, expect, it } from 'vitest';
import { PAUSE_REASONS, errors, microusd } from '@relay/contracts';
import type { AppError, PauseReason, RunAction, RunId, StepKey } from '@relay/contracts';
import { FAKE_FIXTURES } from '@relay/providers';
import type { FakeScenario, ModelRequest, ModelResult, ProviderRegistry, ReconciliationResult } from '@relay/providers';
import type { Repos } from '@relay/storage';
import { createTemplateRegistry } from '@relay/templates';
import { reconcileUnknownAttempts } from './recovery.js';
import { applyRunEvent } from './run-machine.js';
import type { RunMachineEvent } from './run-machine.js';
import { tick } from './runner.js';
import { setupCharge } from './setup-calls.js';
import { effectiveStepSnapshot } from './snapshot.js';
import { validateOutput } from './steps/validate-output.js';
import { loadValidationInputs } from './steps/validation-inputs.js';
import { SAMPLE_FILES, createHarness } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';
import { approvePending, drive, driveThroughApproval, wrapAdapters } from './testing/drive.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function harness(o: HarnessOptions = {}): Promise<Harness> {
  h = await createHarness(o);
  return h;
}

const REVIEW = 'review' as StepKey;
const IMPLEMENT = 'implement' as StepKey;
const rows = (r: Repos, runId: RunId, key: StepKey) => r.steps.listForRun(runId).filter((s) => s.stepKey === key);
const actionsOf = async (x: Harness, runId: RunId): Promise<readonly RunAction[]> => {
  const d = await x.engine.handle('relay/v1/runs.get', { runId });
  return d.ok ? d.data.availableActions : [];
};

/** Registry whose adapters answer `generate` through `f` (and optionally `reconcile`). */
function adapters(
  f: (base: ProviderRegistry, req: ModelRequest, gctx: Parameters<ReturnType<ProviderRegistry['get']>['generate']>[1]) => Promise<ModelResult>,
  reconcile?: () => Promise<ReconciliationResult>,
) {
  return (base: ProviderRegistry): ProviderRegistry => ({
    list: () => base.list(),
    get: (id) => ({ ...base.get(id), generate: (req, gctx) => f(base, req, gctx), ...(reconcile === undefined ? {} : { reconcile }) }),
  });
}

/** The first `stepKey` call reaches the fake (response id recorded) but its answer is lost → attempt unknown. */
function loseFirst(stepKey: string, nth = 1) {
  let seen = 0;
  return async (base: ProviderRegistry, req: ModelRequest, gctx: Parameters<ReturnType<ProviderRegistry['get']>['generate']>[1]): Promise<ModelResult> => {
    const res = await base.get(req.providerId).generate(req, gctx);
    if (req.metadata.stepKey !== stepKey) return res;
    seen += 1;
    return seen === nth ? { kind: 'error', error: errors.providerUnavailable(req.providerId), phase: 'sent_no_response' } : res;
  };
}

const LOOKUP: FakeScenario = { name: 'lookup', capabilityOverrides: { supportsRequestLookup: true }, steps: [] };
const usage = (outputTokens: number) => ({ uncachedInputTokens: 100, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens });

// ---------------------------------------------------------------- BH-1

describe('BH-1: a responded non-retryable provider error pauses as provider_unavailable (never a stuck setup_blocked)', () => {
  it.each([
    ['MODEL_UNSUPPORTED (400/404/422)', errors.modelUnsupported({ providerId: 'anthropic', reason: 'http_400' })],
    ['CONTEXT_TOO_LARGE (413)', errors.contextTooLarge({ estimatedInputTokens: 1, budgetTokens: 0 })],
  ] as const)('%s: step failed, run paused(provider_unavailable), retry_step resumes', async (_name, error: AppError) => {
    let failed = false;
    const x = await harness({ providers: adapters(async (base, req, gctx) => {
      if (req.metadata.stepKey === 'review' && !failed) {
        failed = true;
        return { kind: 'error', error, phase: 'responded' };
      }
      return base.get(req.providerId).generate(req, gctx);
    }) });
    const runId = await x.startRun();

    expect(await drive(x, runId, ['paused'])).toBe('paused');

    const run = x.db.repos.runs.get(runId);
    const review = x.db.repos.steps.latestFor(runId, REVIEW);
    expect([run.pauseReason, run.statusDetail?.code, review?.state]).toEqual(['provider_unavailable', error.code, 'failed']);
    expect(await actionsOf(x, runId)).toEqual(['retry_step', 'choose_profile', 'stop']);
    const retried = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'bh1-retry-step-01', runId, stepId: review?.id ?? '' });
    expect(retried.ok && retried.data.status).toBe('queued');
    expect(await driveThroughApproval(x, runId, ['completed', 'paused'])).toBe('completed');
  });

  it('choose_profile on the failed step maps to runs.retryStep { profileId } (new row, config revision)', async () => {
    const x = await harness({ providers: adapters(async (base, req, gctx) =>
      req.metadata.stepKey === 'review' && req.metadata.purpose === 'initial'
        ? { kind: 'error', error: errors.modelUnsupported({ providerId: req.providerId }), phase: 'responded' }
        : base.get(req.providerId).generate(req, gctx)) });
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const failed = x.db.repos.steps.latestFor(runId, REVIEW);
    const economy = x.db.repos.profiles.getByName('Economy');

    const res = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'bh1-choose-prof-01', runId, stepId: failed?.id ?? '', profileId: economy?.id });

    expect(res.ok && res.data.status).toBe('queued');
    expect(x.db.repos.configRevisions.list(runId).map((c) => c.stepKey)).toEqual(['review']);
    expect(x.db.repos.steps.latestFor(runId, REVIEW)?.retryIndex).toBe(1);
  });
});

describe('BH-1: a run left paused(setup_blocked) with a FAILED step by an earlier build is not stuck', () => {
  it('choose_profile → runs.retryStep { profileId } resumes it; switch_profile points at retryStep', async () => {
    const x = await harness();
    const runId = await x.startRun();
    await tick(x.ctx);
    x.db.tx('immediate', (r) => {
      applyRunEvent(r, r.runs.get(runId), { type: 'SETUP_BLOCKED', reason: 'setup_blocked', error: errors.modelUnsupported() }, x.clock.now(), []);
      const s = r.steps.latestFor(runId, REVIEW);
      if (s !== undefined) r.steps.transition(s.id, [s.state], 'failed', { error: errors.modelUnsupported() });
    });
    const economy = x.db.repos.profiles.getByName('Economy');
    const stepId = x.db.repos.steps.latestFor(runId, REVIEW)?.id ?? '';

    const switched = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'bh1-legacy-switch1', runId,
      decision: { kind: 'switch_profile', stepKey: 'review', profileId: economy?.id ?? '' } } as never);
    const retried = await x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'bh1-legacy-retry01', runId, stepId, profileId: economy?.id });

    expect(switched.ok ? null : switched.error.details).toEqual(expect.objectContaining({ reason: 'step_not_ready', useOp: 'relay/v1/runs.retryStep' }));
    expect(retried.ok && retried.data.status).toBe('queued');
  });
});

// ---------------------------------------------------------------- BH-1 invariant

interface PauseCase {
  /** A non-stop action of the truth table that must lead to RESUME_RESOLVED from this representative state. */
  readonly action: RunAction;
  readonly event: RunMachineEvent;
  readonly setup?: (x: Harness, runId: RunId) => void;
  readonly act: (x: Harness, runId: RunId) => Promise<unknown>;
}

const E = errors.providerUnavailable();
const resume = (decision: object) => (x: Harness, runId: RunId) =>
  x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'inv-resume-key-01', runId, decision } as never);
const failReview = (error: AppError) => (x: Harness, runId: RunId) => {
  x.db.tx('immediate', (r) => {
    const s = r.steps.latestFor(runId, REVIEW);
    if (s !== undefined) r.steps.transition(s.id, [s.state], 'failed', { error });
  });
};
const retryReview = (x: Harness, runId: RunId) =>
  x.engine.handle('relay/v1/runs.retryStep', { idempotencyKey: 'inv-retry-key-001', runId, stepId: x.db.repos.steps.latestFor(runId, REVIEW)?.id ?? '' });

/** Every PAUSE_REASON (Record ⇒ a new reason fails to compile until it gets a representative case). */
const PAUSE_CASES: Record<PauseReason, PauseCase> = {
  budget_run: { action: 'increase_allowance', event: { type: 'BUDGET_BLOCKED', scope: 'run', error: E },
    act: (x, runId) => x.engine.handle('relay/v1/runs.increaseAllowance', { idempotencyKey: 'inv-allowance-001', runId, newAllowanceMicrousd: 900_000_000 }) },
  budget_project: { action: 'edit_project_allowance', event: { type: 'BUDGET_BLOCKED', scope: 'project', error: E },
    act: (x) => x.engine.handle('relay/v1/projects.update', { projectId: x.projectId, expectedUpdatedAt: x.db.repos.projects.get(x.projectId).updatedAt,
      patch: { monthlyAllowanceMicrousd: 900_000_000 } }) },
  budget_overrun: { action: 'acknowledge_overrun', event: { type: 'BUDGET_OVERRUN', attemptId: 'att_01J9ZZZZZZZZZZZZZZZZZZZZZ0' as never, error: E },
    act: resume({ kind: 'acknowledge_overrun' }) },
  user: { action: 'resume', event: { type: 'USER_PAUSE' }, act: resume({ kind: 'continue' }) },
  rate_limited: { action: 'resume', event: { type: 'RATE_LIMIT_EXHAUSTED', error: E }, act: resume({ kind: 'continue' }) },
  setup_blocked: { action: 'resume', event: { type: 'SETUP_BLOCKED', reason: 'setup_blocked', error: errors.permissionDenied('provider_not_allowed') },
    act: resume({ kind: 'continue' }) },
  auth_required: { action: 'resume', event: { type: 'AUTH_FAILED', error: errors.authRequired('anthropic') },
    act: async (x, runId) => {
      for (const providerId of ['anthropic', 'openai', 'gemini', 'fake'] as const) {
        await x.engine.handle('relay/v1/providers.recordCredentialRef', { providerId, storageMode: 'session', vaultFile: null, redactedLabel: 'sk-…' });
      }
      return resume({ kind: 'continue' })(x, runId);
    } },
  approval_stale: { action: 'use_preserved_snapshot', event: { type: 'APPROVAL_STALE', error: errors.projectChanged(['src/lib/format.ts' as never]) },
    act: resume({ kind: 'use_preserved_snapshot' }) },
  limit_attempts: { action: 'raise_limits', event: { type: 'LIMIT_REACHED', reason: 'limit_attempts', error: errors.limitReached('attempts') },
    act: resume({ kind: 'raise_limits', maxAttempts: 30 }) },
  deadline: { action: 'raise_limits', event: { type: 'LIMIT_REACHED', reason: 'deadline', error: errors.limitReached('deadline') },
    act: resume({ kind: 'raise_limits', executionTimeoutSeconds: 3000 }) },
  output_invalid: { action: 'retry_step', event: { type: 'OUTPUT_INVALID_EXHAUSTED', error: errors.outputInvalid() },
    setup: failReview(errors.outputInvalid()), act: retryReview },
  provider_unavailable: { action: 'retry_step', event: { type: 'TRANSPORT_EXHAUSTED', error: errors.modelUnsupported() },
    setup: failReview(errors.modelUnsupported()), act: retryReview },
  model_refused: { action: 'retry_step', event: { type: 'MODEL_REFUSED', error: errors.modelRefused() },
    setup: failReview(errors.modelRefused()), act: retryReview },
  unknown_outcome: { action: 'decide_unknown', event: { type: 'UNKNOWN_OUTCOME', attemptId: 'att_01J9ZZZZZZZZZZZZZZZZZZZZZ1' as never, error: E },
    setup: (x, runId) => {
      x.db.tx('immediate', (r) => {
        const run = r.runs.get(runId);
        const s = r.steps.latestFor(runId, REVIEW);
        if (s === undefined) return;
        const snap = effectiveStepSnapshot(r, run, REVIEW).profile;
        r.attempts.insert({ id: 'att_01J9ZZZZZZZZZZZZZZZZZZZZZ1' as never, runId, stepRunId: s.id, seq: 1, purpose: 'initial', providerId: snap.providerId,
          modelId: snap.modelId, profileSnapshot: snap, requestFingerprint: 'f'.repeat(64), state: 'reserved', reservationMicrousd: microusd(10),
          priceCatalogVersion: snap.priceCatalogVersion, createdAt: x.clock.now() });
        r.attempts.transition('att_01J9ZZZZZZZZZZZZZZZZZZZZZ1' as never, ['reserved'], 'unknown', {});
        r.steps.transition(s.id, [s.state], 'unknown', {});
      });
    },
    act: (x, runId) => x.engine.handle('relay/v1/runs.decideUnknown', { idempotencyKey: 'inv-decide-key-01', runId,
      attemptId: 'att_01J9ZZZZZZZZZZZZZZZZZZZZZ1', decision: 'retry_acknowledging_charge' }) },
};

describe('F2 invariant: every paused state has a non-stop action that leads to RESUME_RESOLVED', () => {
  it.each(PAUSE_REASONS)('paused(%s)', async (reason) => {
    const c = PAUSE_CASES[reason];
    const x = await harness({ monthlyAllowanceMicrousd: reason === 'budget_project' ? 1_000 : null });
    const runId = await x.startRun();
    await tick(x.ctx); // CHECKS_PASSED → running (budget_project: the queued check already pauses it, before any reservation)
    const cur = x.db.repos.runs.get(runId);
    if (!(cur.status === 'paused' && cur.pauseReason === reason)) x.db.tx('immediate', (r) => applyRunEvent(r, r.runs.get(runId), c.event, x.clock.now(), []));
    c.setup?.(x, runId);
    expect(x.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: reason }));
    const offered = await actionsOf(x, runId);

    await c.act(x, runId);

    expect(c.action).not.toBe('stop');
    expect(offered).toContain(c.action);
    expect(x.db.repos.runs.get(runId).status).toBe('queued');
    expect(x.db.repos.events.list(runId, 0, 1000).filter((e) => e.type === 'run.status_changed').at(-1)?.payload['trigger']).toBe('RESUME_RESOLVED');
  });
});

// ---------------------------------------------------------------- BH-2

describe('BH-2: a reconciled overrun (X > liability) pauses budget_overrun and never auto-resumes', () => {
  const findings = FAKE_FIXTURES['findings.v1'];
  const overrun = (): Promise<ReconciliationResult> => Promise.resolve({ kind: 'completed', json: structuredClone(findings), usage: usage(900_000), rawUsage: null });

  it('the last unknown reconciled with an overrun → paused(budget_overrun), acknowledge_overrun resumes', async () => {
    const x = await harness({ scenario: LOOKUP, providers: adapters(loseFirst('review'), overrun) });
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const [a] = x.db.repos.attempts.listForRun(runId);

    await reconcileUnknownAttempts(x.ctx, new AbortController().signal);

    const run = x.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason]).toEqual(['paused', 'budget_overrun']);
    expect(x.db.repos.ledger.attemptBalances(a?.id ?? ('' as never)).settled).toBeGreaterThan(a?.reservationMicrousd ?? 0);
    expect(await actionsOf(x, runId)).toEqual(['acknowledge_overrun', 'increase_allowance', 'stop']);
    const ack = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'bh2-ack-overrun-1', runId, decision: { kind: 'acknowledge_overrun' } });
    expect(ack.ok && ack.data.status).toBe('queued');
  });

  it('an overrun reconciled while another unknown remains is applied when the last one is decided (no RESUME_RESOLVED)', async () => {
    const x = await harness({ scenario: LOOKUP, providers: adapters(loseFirst('review'), overrun) });
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const [a] = x.db.repos.attempts.listForRun(runId);
    const second = 'att_01J9ZZZZZZZZZZZZZZZZZZZZZ2' as never;
    x.db.tx('immediate', (r) => {
      if (a === undefined) return;
      r.attempts.insert({ ...a, id: second, seq: 2, state: 'reserved', createdAt: x.clock.now() } as never);
      r.attempts.transition(second, ['reserved'], 'unknown', {});
    });

    await reconcileUnknownAttempts(x.ctx, new AbortController().signal);
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('unknown_outcome'); // one unknown left
    await x.engine.handle('relay/v1/runs.decideUnknown', { idempotencyKey: 'bh2-decide-key-01', runId, attemptId: second, decision: 'mark_failed_keep_liability' });

    expect(x.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ status: 'paused', pauseReason: 'budget_overrun' }));
  });
});

// ---------------------------------------------------------------- BH-3

describe('BH-3: REQUEST_OUTCOME_UNKNOWN from a connection test is setup liability in ANY phase', () => {
  it('a gateway answer (phase responded) moves the full N to unknown, certainty unknown', async () => {
    const x = await harness({ providers: wrapAdapters({ testConnection: () =>
      Promise.resolve({ kind: 'error', error: errors.requestOutcomeUnknown('att_01J9ZZZZZZZZZZZZZZZZZZZZZ3' as never), phase: 'responded' }) }) });

    const res = await x.engine.handle('relay/v1/providers.test', { providerId: 'anthropic' });

    expect(res.ok && [res.data.ok, res.data.certainty]).toEqual([false, 'unknown']);
    const b = x.db.repos.ledger.setupBalances(0 as never, Number.MAX_SAFE_INTEGER as never);
    expect([b.R, b.U, b.C]).toEqual([0, res.ok ? res.data.costMicrousd : -1, 0]);
    expect(b.U).toBeGreaterThan(0);
    const prices = { input: microusd(1), output: microusd(1), cacheRead: microusd(1), cacheWrite: microusd(1) };
    for (const phase of ['not_sent', 'responded'] as const) {
      expect(setupCharge({ kind: 'error', error: errors.requestOutcomeUnknown('x' as never), phase, usage: usage(1) }, false, { prices }, microusd(9)))
        .toEqual({ kind: 'unknown' });
    }
  });
});

// ---------------------------------------------------------------- BH-4 + resnapshot storage

describe('BH-4: isRevision follows the quality-revision cycle under the current approval', () => {
  const validate = SAMPLE_FILES['src/lib/validate.ts'] ?? '';
  const widened = {
    ...(FAKE_FIXTURES['patch.v1'] as { files: object[] }),
    files: [{ relPath: 'src/lib/validate.ts', changeType: 'modify',
      unifiedDiff: createTwoFilesPatch('a/src/lib/validate.ts', 'b/src/lib/validate.ts', validate, validate.replace('Request body must be a JSON object', 'Body must be an object')) }],
  };

  it('after resnapshot_and_replan the new plan starts at cycle 0: an out-of-scope first implementation is OUTPUT_INVALID (repairable), not APPROVAL_STALE', async () => {
    let implementCalls = 0;
    const x = await harness({
      scenario: 'revise-then-accept',
      providers: wrapAdapters({
        generate: async (base, req, gctx) => {
          const res: ModelResult = await base.get(req.providerId).generate(req, gctx);
          if (req.metadata.stepKey !== 'implement' || res.kind !== 'success') return res;
          implementCalls += 1;
          // 2nd (revision cycle 1) and 3rd (first implementation after the replan) widen the scope.
          return implementCalls === 2 || implementCalls === 3 ? { ...res, json: widened, rawText: JSON.stringify(widened) } : res;
        },
      }),
    });
    const runId = await x.startRun();
    expect(await driveThroughApproval(x, runId, ['completed', 'paused'])).toBe('paused');
    expect(x.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ pauseReason: 'approval_stale', revisionCycle: 1 }));

    const replan = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'bh4-replan-key-01', runId, decision: { kind: 'resnapshot_and_replan' } });
    expect(replan.ok && replan.data.status).toBe('queued');
    expect(x.db.repos.runs.get(runId).revisionCycle).toBe(0);
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    await approvePending(x, runId, 'bh4-approve-key-02');

    expect(await drive(x, runId, ['completed', 'paused', 'incomplete'])).toBe('completed');
    const attempts = x.db.repos.attempts.listForRun(runId).filter((a) => rows(x.db.repos, runId, IMPLEMENT).some((s) => s.id === a.stepRunId));
    expect(attempts.map((a) => [a.purpose, a.error?.code ?? null])).toEqual([
      ['initial', null], ['initial', 'APPROVAL_STALE'], ['initial', 'OUTPUT_INVALID'], ['schema_repair', null],
    ]);
    expect(x.db.repos.approvals.latestApprovedForRun(runId)?.invalidatedAt).toBeNull(); // the new approval was reused
  });
});

describe('resnapshot_and_replan when the project changed (RunRepo.replaceInputFiles)', () => {
  it('re-snapshots the changed files, sets a new context hash, and re-plans under a new approval bound to it', async () => {
    const x = await harness();
    const runId = await x.startRun();
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    const before = x.db.repos.runs.get(runId);
    const beforeFiles = x.db.repos.runs.inputFiles(runId);
    const changed = `${SAMPLE_FILES['src/lib/format.ts'] ?? ''}\n// edited\n`;
    await writeFile(join(x.projectRoot, 'src', 'lib', 'format.ts'), changed);
    const detail = await x.engine.handle('relay/v1/runs.get', { runId });
    const a = detail.ok ? detail.data.pendingApproval : null;
    const stale = await x.engine.handle('relay/v1/approvals.decide', { idempotencyKey: 'rs-approve-stale-1', approvalId: a?.id ?? '',
      planHash: a?.planHash ?? '', contextHash: a?.contextHash ?? '', decision: 'approved' });
    expect(stale.ok ? null : stale.error.code).toBe('PROJECT_CHANGED');

    const replan = await x.engine.handle('relay/v1/runs.resume', { idempotencyKey: 'rs-replan-key-001', runId, decision: { kind: 'resnapshot_and_replan' } });

    expect(replan.ok && replan.data.status).toBe('queued');
    const run = x.db.repos.runs.get(runId);
    const files = x.db.repos.runs.inputFiles(runId);
    const format = files.find((f) => f.relPath === 'src/lib/format.ts');
    const oldFormat = beforeFiles.find((f) => f.relPath === 'src/lib/format.ts');
    expect(run.contextHash).not.toBe(before.contextHash);
    expect(files.map((f) => f.relPath)).toEqual(beforeFiles.map((f) => f.relPath));
    expect(format?.sha256).not.toBe(oldFormat?.sha256);
    expect(x.db.repos.artifacts.get(format?.artifactId ?? ('' as never))).toEqual(expect.objectContaining({ kind: 'input_file', sha256: format?.sha256 }));
    const inputs = await loadValidationInputs(x.ctx, run);
    expect(inputs.files.get('src/lib/format.ts')).toBe(changed); // the new snapshot bytes
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');
    const next = await x.engine.handle('relay/v1/runs.get', { runId });
    expect(next.ok && next.data.pendingApproval?.contextHash).toBe(run.contextHash);
    await approvePending(x, runId, 'rs-approve-key-002');
    expect(await drive(x, runId, ['completed', 'paused'])).toBe('completed');
  });
});

// ---------------------------------------------------------------- BH-5

describe('BH-5: after RECONCILED_RETRY the next attempt purpose matches the counter that was spent', () => {
  it('a reconciled invalid output → schema_repair attempt whose prompt carries the repair block', async () => {
    const requests: ModelRequest[] = [];
    const lose = loseFirst('review');
    const x = await harness({ scenario: LOOKUP, providers: adapters(async (base, req, gctx) => {
      requests.push(req);
      return lose(base, req, gctx);
    }, () => Promise.resolve({ kind: 'completed', json: { summary: '' }, usage: usage(10), rawUsage: null })) });
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');

    await reconcileUnknownAttempts(x.ctx, new AbortController().signal);
    expect(x.db.repos.steps.latestFor(runId, REVIEW)).toEqual(expect.objectContaining({ state: 'ready', schemaRepairsUsed: 1 }));
    expect(x.db.repos.runs.get(runId).status).toBe('queued');
    await drive(x, runId, ['awaiting_approval', 'paused']);

    const reviewAttempts = x.db.repos.attempts.listForRun(runId).filter((a) => a.stepRunId === x.db.repos.steps.latestFor(runId, REVIEW)?.id);
    expect(reviewAttempts.map((a) => a.purpose)).toEqual(['initial', 'schema_repair']);
    const repair = requests.find((q) => q.metadata.stepKey === 'review' && q.metadata.purpose === 'schema_repair');
    expect(repair?.messages[0]?.content).toContain('<previous_output_issues>');
  });

  it('a reconciled provider failure → transport_retry', async () => {
    const x = await harness({ scenario: LOOKUP, providers: adapters(loseFirst('review'), () => Promise.resolve({ kind: 'failed', usage: usage(1) })) });
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');

    await reconcileUnknownAttempts(x.ctx, new AbortController().signal);
    await drive(x, runId, ['awaiting_approval', 'paused']);

    const step = x.db.repos.steps.latestFor(runId, REVIEW);
    expect(x.db.repos.attempts.listForStep(step?.id ?? ('' as never)).map((a) => a.purpose)).toEqual(['initial', 'transport_retry']);
    expect(step?.transportRetriesUsed).toBe(1);
  });
});

// ---------------------------------------------------------------- BH-6

describe('BH-6: the reconcile path applies the F10 scope rule exactly like the live settle', () => {
  it('a reconciled quality revision outside the approved scope invalidates the approval and pauses approval_stale', async () => {
    const validate = SAMPLE_FILES['src/lib/validate.ts'] ?? '';
    const widened = {
      ...(FAKE_FIXTURES['patch.v1'] as { files: object[] }),
      files: [{ relPath: 'src/lib/validate.ts', changeType: 'modify',
        unifiedDiff: createTwoFilesPatch('a/src/lib/validate.ts', 'b/src/lib/validate.ts', validate, validate.replace('Request body must be a JSON object', 'Body must be an object')) }],
    };
    const scenario: FakeScenario = { name: 'revise-lookup', capabilityOverrides: { supportsRequestLookup: true },
      steps: [{ match: { stepKey: 'verify' }, result: { kind: 'success', fixture: 'review.v1.revise' } }] };
    const x = await harness({ scenario, providers: adapters(loseFirst('implement', 2),
      () => Promise.resolve({ kind: 'completed', json: widened, usage: usage(10), rawUsage: null })) });
    const runId = await x.startRun();
    expect(await driveThroughApproval(x, runId, ['completed', 'paused'])).toBe('paused');
    expect(x.db.repos.runs.get(runId)).toEqual(expect.objectContaining({ pauseReason: 'unknown_outcome', revisionCycle: 1 }));
    const approval = x.db.repos.approvals.latestApprovedForRun(runId);

    await reconcileUnknownAttempts(x.ctx, new AbortController().signal);

    const run = x.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason, run.statusDetail?.code, run.statusDetail?.details?.['reason']]).toEqual(['paused', 'approval_stale', 'APPROVAL_STALE', 'scope_changed']);
    expect(x.db.repos.approvals.get(approval?.id ?? ('' as never))?.invalidatedReason).toBe('scope_changed');
    expect(x.db.repos.steps.latestFor(runId, IMPLEMENT)).toEqual(expect.objectContaining({ state: 'ready', schemaRepairsUsed: 0 }));
    expect(await actionsOf(x, runId)).toEqual(['resnapshot_and_replan', 'stop']); // E1 #8: scope change ≠ project change
  });
});

// ---------------------------------------------------------------- BH-7

describe('BH-7: an unreadable / unverifiable snapshot is never accepted; duplicate patch files are invalid', () => {
  const templates = createTemplateRegistry();
  const files = new Map<string, string | null>(Object.entries(SAMPLE_FILES));

  it('findings refs and patch diffs on an unavailable snapshot → OUTPUT_INVALID(snapshot_unavailable)', () => {
    const unavailable = new Set(['src/lib/format.ts']);
    const findings = structuredClone(FAKE_FIXTURES['findings.v1']) as { sourceRefs: { relPath: string; startLine: number | null; endLine: number | null }[] };
    findings.sourceRefs = [{ relPath: 'src/lib/format.ts', startLine: 9999, endLine: null }];
    const plan = FAKE_FIXTURES['plan.v1'] as { fileScope: string[] };
    const patch = FAKE_FIXTURES['patch.v1'] as { files: { relPath: string }[] };

    const f = validateOutput({ outputSchema: 'findings.v1' }, findings, templates, { files, approvedScope: null, isRevision: false, unavailable });
    const p = validateOutput({ outputSchema: 'patch.v1' }, patch, templates,
      { files, approvedScope: plan.fileScope, isRevision: false, unavailable: new Set(patch.files.map((x) => x.relPath)) });

    for (const v of [f, p]) {
      expect(v.ok ? null : v.error.code).toBe('OUTPUT_INVALID');
      expect(v.ok ? [] : (v.error.details?.['issues'] as { code: string }[]).map((i) => i.code)).toContain('snapshot_unavailable');
    }
  });

  it('two files[] entries for the same relPath → OUTPUT_INVALID(duplicate_file)', () => {
    const patch = structuredClone(FAKE_FIXTURES['patch.v1']) as { files: object[] };
    const plan = FAKE_FIXTURES['plan.v1'] as { fileScope: string[] };
    const first = patch.files[0];
    if (first !== undefined) patch.files = [first, first];

    const v = validateOutput({ outputSchema: 'patch.v1' }, patch, templates, { files, approvedScope: plan.fileScope, isRevision: false });

    expect(v.ok ? [] : (v.error.details?.['issues'] as { code: string; path: string }[]).map((i) => `${i.path}:${i.code}`)).toEqual(['files[1].relPath:duplicate_file']);
  });

  it('loadValidationInputs marks a corrupted snapshot unavailable, so a findings ref past its end is rejected', async () => {
    const x = await harness();
    const runId = await x.startRun();
    await tick(x.ctx);
    await tick(x.ctx); // intake
    const ref = x.db.repos.runs.inputFiles(runId).find((f) => f.relPath === 'src/lib/format.ts');
    const art = x.db.repos.artifacts.get(ref?.artifactId ?? ('' as never));
    const stored = join(x.userDataDir, art?.relPath ?? 'missing');
    await rm(stored, { force: true }); // snapshot files are read-only
    await writeFile(stored, 'tampered');
    const findings = structuredClone(FAKE_FIXTURES['findings.v1']) as { sourceRefs: { relPath: string; startLine: number | null; endLine: number | null }[] };
    findings.sourceRefs = [{ relPath: 'src/lib/format.ts', startLine: 9999, endLine: null }];

    const inputs = await loadValidationInputs(x.ctx, x.db.repos.runs.get(runId));
    const v = validateOutput({ outputSchema: 'findings.v1' }, findings, templates, inputs);

    expect([...(inputs.unavailable ?? [])]).toEqual(['src/lib/format.ts']);
    expect([...new Set(v.ok ? [] : (v.error.details?.['issues'] as { code: string }[]).map((i) => i.code))]).toEqual(['snapshot_unavailable']);
  });
});
