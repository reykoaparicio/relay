// E1 regression tests: F2 (no estimate egress to a provider the project no longer allows), the monotonic deadline
// (Mac sleep / clock set back), a key rejected during a run marks the provider failing, instruction versioning, the
// optional step name, choose-profile estimates, run-level attempts + manifest, and suspected-secret preflight issues.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { epochMs } from '@relay/contracts';
import type { ProviderId, RunId, StepKey } from '@relay/contracts';
import type { ProviderRegistry } from '@relay/providers';
import { createDeadlineWatcher } from './deadline.js';
import { tick } from './runner.js';
import { createHarness, SAMPLE_FILES } from './testing/harness.js';
import type { Harness, HarnessOptions } from './testing/harness.js';
import { drive, driveThroughApproval } from './testing/drive.js';
import { createManualTimers } from './testing/manual-timers.js';
import { applyDraftPatch, nextInstructionVersion } from './workflows.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function harness(o: HarnessOptions = {}): Promise<Harness> {
  h = await createHarness(o);
  return h;
}

interface EstimateCall {
  readonly providerId: ProviderId;
  readonly stepKey: string;
  readonly withKey: boolean;
}

/** Records every adapter.estimate call (provider, step, whether the key was passed). */
function recordingEstimates(log: EstimateCall[]): (base: ProviderRegistry) => ProviderRegistry {
  return (base) => ({
    list: () => base.list(),
    get: (id: ProviderId) => {
      const a = base.get(id);
      return {
        ...a,
        estimate: (req, prices, ectx) => {
          log.push({ providerId: id, stepKey: req.metadata.stepKey, withKey: ectx?.apiKey !== undefined });
          return a.estimate(req, prices, ectx);
        },
      };
    },
  });
}

const detailOf = async (x: Harness, runId: RunId) => {
  const d = await x.engine.handle('relay/v1/runs.get', { runId });
  if (!d.ok) throw new Error(d.error.code);
  return d.data;
};

function reviewProvider(x: Harness, runId: RunId): ProviderId {
  const snap = x.db.repos.runs.get(runId).snapshot as { steps: Record<string, { profile?: { providerId: ProviderId } }> };
  const p = snap.steps['review']?.profile?.providerId;
  if (p === undefined) throw new Error('no review profile');
  return p;
}

describe('F2: no estimate egress toward a provider removed from the project', () => {
  it('increaseAllowance after unticking the provider never calls adapter.estimate with the key', async () => {
    const log: EstimateCall[] = [];
    const x = await harness({ providers: recordingEstimates(log) });
    const runId = await x.startRun({ budgetMicrousd: 10_000 });
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    const provider = reviewProvider(x, runId);
    const p = x.db.repos.projects.get(x.projectId);
    const up = await x.engine.handle('relay/v1/projects.update', { projectId: x.projectId, expectedUpdatedAt: p.updatedAt,
      patch: { allowedProviderIds: ['anthropic', 'openai', 'gemini', 'fake'].filter((y) => y !== provider) as ProviderId[] } });
    expect(up.ok).toBe(true);
    log.length = 0;

    const inc = await x.engine.handle('relay/v1/runs.increaseAllowance', { idempotencyKey: 'e1-f2-incr-0000001', runId, newAllowanceMicrousd: 5_000_000 });

    expect(inc.ok).toBe(true);
    expect(log.filter((c) => c.withKey)).toEqual([]);
  });

  it('the project-allowance re-evaluation never estimates with the key for a provider without a credential ref', async () => {
    const log: EstimateCall[] = [];
    const x = await harness({ providers: recordingEstimates(log), monthlyAllowanceMicrousd: 10_000 });
    const runId = await x.startRun();
    await tick(x.ctx);
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('budget_project');
    x.db.repos.credentials.delete(reviewProvider(x, runId));
    log.length = 0;
    const p = x.db.repos.projects.get(x.projectId);

    await x.engine.handle('relay/v1/projects.update', { projectId: x.projectId, expectedUpdatedAt: p.updatedAt, patch: { monthlyAllowanceMicrousd: 50_000_000 } });

    expect(log).toEqual([]);
  });

  it('dispatch checks the allowed providers BEFORE resolving the key and estimating', async () => {
    const log: EstimateCall[] = [];
    let resolved = 0;
    const ref: { x?: Harness } = {};
    const x = await harness({
      providers: recordingEstimates(log),
      credentials: { resolve: () => {
        resolved += 1;
        return Promise.resolve({ ok: true, value: 'test-key-0000000000000000' });
      } },
      // The policy changes between the review and the plan step of the same running segment.
      context: (base) => ({
        assemble: (input) => {
          const hx = ref.x;
          if (input.step.stepKey === 'plan' && hx !== undefined) {
            const project = hx.db.repos.projects.get(input.run.projectId);
            hx.db.tx('immediate', (r) => r.projects.update(project.id, { providerPolicy: { ...project.providerPolicy, allowedProviderIds: [] } }, project.updatedAt));
          }
          return base.assemble(input);
        },
      }),
    });
    ref.x = x;
    const runId = await x.startRun();
    for (let i = 0; i < 40 && x.db.repos.runs.get(runId).status !== 'paused'; i += 1) await tick(x.ctx);

    const run = x.db.repos.runs.get(runId);
    expect([run.status, run.pauseReason, run.statusDetail?.details?.['reason'] ?? run.statusDetail?.code]).toEqual(['paused', 'setup_blocked', 'provider_not_allowed']);
    expect(log.filter((c) => c.stepKey === 'plan')).toEqual([]);
    expect(x.db.repos.steps.latestFor(runId, 'plan' as StepKey)?.state).toBe('ready');
    expect(resolved).toBe(x.db.repos.attempts.listForRun(runId).length); // the review attempt's only (never for plan)
  });
});

describe('deadline on a monotonic clock (Mac sleep, clock set back)', () => {
  const mono = (): { t: number; now(): number } => ({ t: 1_000, now() { return this.t; } });

  async function running(m: { now(): number }): Promise<{ x: Harness; runId: RunId }> {
    const x = await harness({ monotonic: m });
    const wf = x.db.repos.workflows.listWorkflows()[0];
    const started = await x.engine.handle('relay/v1/runs.start', { idempotencyKey: 'e1-deadline-run-001', projectId: x.projectId, workflowId: wf?.id ?? 'wf_01J9ZZZZZZZZZZZZZZZZZZZZZ0',
      workflowVersion: 1, goal: 'g', input: { kind: 'files', relPaths: Object.keys(SAMPLE_FILES) }, limitOverrides: { executionTimeoutSeconds: 60 } });
    if (!started.ok) throw new Error(started.error.code);
    await tick(x.ctx); // CHECKS_PASSED → running (the ctx watcher opens the monotonic segment)
    expect(x.db.repos.runs.get(started.data.runId).status).toBe('running');
    return { x, runId: started.data.runId };
  }

  it('a wall clock set backwards still enforces the deadline (monotonic elapsed)', async () => {
    const m = mono();
    const { x, runId } = await running(m);
    const timers = createManualTimers(); // not linked to the wall clock
    const watcher = createDeadlineWatcher({ ...x.ctx, timers });
    watcher.arm(runId);

    x.clock.set(x.clock.now() - 3_600_000); // the user set the clock back an hour
    m.t += 60_001;
    timers.advance(60_001);
    await x.waitFor(() => x.db.repos.runs.get(runId).status === 'paused');

    const run = x.db.repos.runs.get(runId);
    expect([run.pauseReason, run.executionMsUsed]).toEqual(['deadline', 60_001]);
  });

  it('a timer that fires before the deadline is reached re-arms instead of returning silently', async () => {
    const m = mono();
    const { x, runId } = await running(m);
    const timers = createManualTimers();
    const watcher = createDeadlineWatcher({ ...x.ctx, timers });
    watcher.arm(runId);

    m.t += 30_000; // only half the execution time really elapsed when the timer fired
    timers.advance(60_000);
    await new Promise((r) => globalThis.setTimeout(r, 10));
    expect(x.db.repos.runs.get(runId).status).toBe('running');
    expect(timers.pending()).toBe(1);
    m.t += 30_000;
    timers.advance(30_000);
    await x.waitFor(() => x.db.repos.runs.get(runId).status === 'paused');

    expect(x.db.repos.runs.get(runId).pauseReason).toBe('deadline');
  });

  it('a 2 h sleep during a provider call is not charged as execution time', async () => {
    const m = mono();
    const ref: { x?: Harness } = {};
    const x = await harness({ monotonic: m, hooks: { afterDispatchIntent: (c) => {
      if (c.stepKey === 'review' && ref.x !== undefined) {
        ref.x.clock.advance(2 * 3_600_000); // the Mac slept: the wall clock jumped, the monotonic clock did not
        m.t += 1_500;
      }
    } } });
    ref.x = x;
    const runId = await x.startRun();

    expect(await drive(x, runId, ['awaiting_approval', 'paused'])).toBe('awaiting_approval');
    const used = x.db.repos.runs.get(runId).executionMsUsed;
    expect(used).toBe(1_500);
  });

  it('a fractional monotonic source (performance.now) persists whole ms (INTEGER columns)', async () => {
    const m = { t: 1_000.374, now() { return this.t; } };
    const ref: { x?: Harness } = {};
    const x = await harness({ monotonic: m, hooks: { afterDispatchIntent: () => {
      if (ref.x !== undefined) m.t += 1_234.567;
    } } });
    ref.x = x;
    const runId = await x.startRun();

    expect(await drive(x, runId, ['awaiting_approval', 'paused'])).toBe('awaiting_approval');
    const run = x.db.repos.runs.get(runId);
    expect(Number.isSafeInteger(run.executionMsUsed)).toBe(true);
    expect(run.executionMsUsed).toBe(2 * 1_234 + 1); // two dispatches (review, plan); floor of the summed segment
  });

  it('without a monotonic clock the wall clock is used (unchanged behaviour)', async () => {
    const x = await harness();
    const runId = await x.startRun();
    await tick(x.ctx);
    x.clock.advance(5_000);
    x.db.tx('immediate', (r) => {
      const run = r.runs.get(runId);
      r.runs.leaveRunning(run.id, epochMs(x.clock.now()));
    });
    expect(x.db.repos.runs.get(runId).executionMsUsed).toBe(5_000);
  });
});

describe('a key rejected during a run marks the provider failing', () => {
  it('AUTH_REQUIRED at settle records a failed provider test (providers.list lastTest)', async () => {
    const x = await harness({ scenario: { name: 'auth', steps: [{ match: { stepKey: 'review', purpose: 'initial' }, result: { kind: 'auth_error' } }] } });
    const runId = await x.startRun();
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('auth_required');
    const provider = reviewProvider(x, runId);

    expect(x.db.repos.credentials.get(provider)?.lastTest).toEqual(expect.objectContaining({ ok: false, code: 'AUTH_REQUIRED', source: 'run' }));
    const list = await x.engine.handle('relay/v1/providers.list', {});
    if (provider !== 'fake') expect(list.ok && list.data.find((p) => p.providerId === provider)?.lastTest).toEqual(expect.objectContaining({ ok: false, code: 'AUTH_REQUIRED', source: 'run' }));
  });
});

describe('instruction versioning', () => {
  it('nextInstructionVersion bumps within the family', () => {
    expect(nextInstructionVersion('reviewer.v1', ['reviewer.v1', 'planner.v4'])).toBe('reviewer.v2');
    expect(nextInstructionVersion('reviewer.v1', ['reviewer.v1', 'reviewer.v3'])).toBe('reviewer.v4');
  });

  it('applyDraftPatch: a published version is renamed on edit, a draft-only one is edited in place, an unchanged text keeps its name', async () => {
    const x = await harness();
    const base = x.db.repos.workflows.latestValidated(x.db.repos.workflows.listWorkflows()[0]?.id ?? ('' as never));
    if (base === undefined) throw new Error('no workflow');
    const published = new Set(Object.keys(base.prompts));

    const same = applyDraftPatch(base, { prompts: { 'reviewer.v1': base.prompts['reviewer.v1'] ?? '' } }, undefined, published);
    const edited = applyDraftPatch(base, { prompts: { 'reviewer.v1': 'Review carefully.' } }, undefined, published);
    if (!edited.ok) throw new Error('edit');
    const again = applyDraftPatch(edited.value, { prompts: { 'reviewer.v2': 'Review very carefully.' } }, undefined, published);

    expect(same.ok && same.value.spec.steps.find((s) => s.id === 'review')).toEqual(expect.objectContaining({ instructionVersion: 'reviewer.v1' }));
    expect(edited.value.prompts['reviewer.v2']).toBe('Review carefully.');
    expect(edited.value.prompts['reviewer.v1']).toBeUndefined();
    expect(again.ok && [again.value.prompts['reviewer.v2'], Object.keys(again.value.prompts).filter((k) => k.startsWith('reviewer.'))]).toEqual(['Review very carefully.', ['reviewer.v2']]);
  });

  it('an edited, published prompt runs as reviewer.v2 (manifest + report); v1 keeps its text; the next edit is reviewer.v3', async () => {
    const x = await harness();
    const wf = x.db.repos.workflows.listWorkflows()[0]?.id ?? ('' as never);
    const v1Text = x.db.repos.workflows.getVersion(wf, 1)?.prompts['reviewer.v1'];
    const saved = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 0, patch: { prompts: { 'reviewer.v1': 'Review carefully, please.' } } });
    expect(saved.ok && saved.data.prompts['reviewer.v2']?.text).toBe('Review carefully, please.');
    const published = await x.engine.handle('relay/v1/workflows.publish', { idempotencyKey: 'e1-publish-v2-00001', workflowId: wf });
    expect(published.ok && published.data.version).toBe(2);

    const started = await x.engine.handle('relay/v1/runs.start', { idempotencyKey: 'e1-run-v2-0000001', projectId: x.projectId, workflowId: wf, workflowVersion: 2,
      goal: 'Fix the defects in the handlers.', input: { kind: 'files', relPaths: Object.keys(SAMPLE_FILES) } });
    if (!started.ok) throw new Error(started.error.code);
    const runId = started.data.runId;
    await driveThroughApproval(x, runId, ['completed', 'incomplete', 'paused']);

    const d = await detailOf(x, runId);
    expect(d.stepMeta?.find((s) => s.stepKey === 'review')?.instructionVersion).toBe('reviewer.v2');
    const manifestRow = x.db.repos.artifacts.listForRun(runId, ['context_manifest'])[0];
    const manifest = manifestRow === undefined ? null : await x.engine.handle('relay/v1/artifacts.get', { artifactId: manifestRow.id });
    expect(manifest?.ok && manifest.data.content.kind === 'json' && (manifest.data.content.value as { instructions: { version: string } }).instructions.version).toBe('reviewer.v2');
    if (d.reportArtifactId !== null) {
      const report = await x.engine.handle('relay/v1/artifacts.get', { artifactId: d.reportArtifactId });
      const meta = report.ok && report.data.content.kind === 'json' ? (report.data.content.value as { stepMeta?: { stepKey: string; instructionVersion: string | null }[] }).stepMeta : [];
      expect(meta?.find((s) => s.stepKey === 'review')?.instructionVersion).toBe('reviewer.v2');
    }
    expect(x.db.repos.workflows.getVersion(wf, 1)?.prompts['reviewer.v1']).toBe(v1Text);

    const next = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 0, patch: { prompts: { 'reviewer.v2': 'Third text.' } } });
    expect(next.ok && Object.keys(next.data.prompts).filter((k) => k.startsWith('reviewer.'))).toEqual(['reviewer.v3']);
  });
});

describe('optional step name', () => {
  it('saveDraft accepts a 1–60 char name on model and approval steps; it is shown in RunDetail.stepMeta', async () => {
    const x = await harness();
    const wf = x.db.repos.workflows.listWorkflows()[0]?.id ?? ('' as never);

    const bad = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 0, patch: { steps: { review: { name: 'x'.repeat(61) } } } });
    const blank = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 0, patch: { steps: { review: { name: '   ' } } } });
    const structural = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 0, patch: { steps: { approve: { name: 'Sign-off', profile: 'Economy' } } } });
    const named = await x.engine.handle('relay/v1/workflows.saveDraft', { workflowId: wf, expectedDraftRevision: 0,
      patch: { steps: { review: { name: '  Find defects ' }, approve: { name: 'Sign-off' } } } });

    expect(bad.ok ? null : bad.error.code).toBe('VALIDATION_FAILED');
    expect(blank.ok ? null : blank.error.code).toBe('VALIDATION_FAILED');
    expect(structural.ok ? null : (structural.error.details?.['issues'] as { code: string }[])[0]?.code).toBe('structural_edit_p1');
    expect(named.ok && named.data.spec.steps.find((s) => s.id === 'review')?.name).toBe('Find defects'); // trimmed
    expect(named.ok && named.data.spec.steps.find((s) => s.id === 'approve')?.name).toBe('Sign-off');
    await x.engine.handle('relay/v1/workflows.publish', { idempotencyKey: 'e1-publish-name-001', workflowId: wf });
    const started = await x.engine.handle('relay/v1/runs.start', { idempotencyKey: 'e1-run-name-000001', projectId: x.projectId, workflowId: wf, workflowVersion: 2,
      goal: 'g', input: { kind: 'files', relPaths: ['src/handlers/user.ts'] } });
    if (!started.ok) throw new Error(started.error.code);

    const d = await detailOf(x, started.data.runId);
    expect(d.stepMeta?.find((s) => s.stepKey === 'review')).toEqual({ stepKey: 'review', name: 'Find defects', instructionVersion: 'reviewer.v1' });
    expect(d.stepMeta?.find((s) => s.stepKey === 'intake')?.name).toBeNull();
  });
});

describe('choose-profile estimates and run-level attempts', () => {
  it('a budget pause lists the allowed, credentialed profiles with a local reservation estimate (no adapter call)', async () => {
    const log: EstimateCall[] = [];
    const x = await harness({ providers: recordingEstimates(log), allowedProviderIds: ['anthropic', 'openai'], credentialRefs: ['anthropic'] });
    const wf = x.db.repos.workflows.listWorkflows()[0]?.id ?? ('' as never);
    const pre = await x.engine.handle('relay/v1/runs.preflight', { projectId: x.projectId, workflowId: wf, workflowVersion: 1, goal: 'Fix the defects in the handlers.',
      input: { kind: 'files', relPaths: Object.keys(SAMPLE_FILES) } });
    if (!pre.ok) throw new Error(pre.error.code);
    // A queued run blocked before intake: no input estimate yet → the minimum reservation.
    const early = await x.startRun({ budgetMicrousd: 1_000 });
    await tick(x.ctx);
    const queuedBlock = await detailOf(x, early);
    expect(queuedBlock.profileOptions?.every((o) => o.basis === 'minimum' && o.estimatedInputTokens === 0)).toBe(true);
    const min = Number(queuedBlock.statusDetail?.details?.['N']);
    await x.engine.handle('relay/v1/runs.cancel', { runId: early });
    // Above the minimum reservation, below N: admission fails at the reserve checkpoint (with an input estimate).
    const runId = await x.startRun({ budgetMicrousd: Math.floor((min + pre.data.firstReservation.N) / 2) });
    expect(await drive(x, runId, ['paused'])).toBe('paused');
    expect(x.db.repos.runs.get(runId).pauseReason).toBe('budget_run');
    log.length = 0;

    const d = await detailOf(x, runId);

    expect(d.availableActions).toContain('choose_profile');
    expect(d.profileOptions?.length).toBeGreaterThan(0);
    for (const o of d.profileOptions ?? []) {
      expect(o.providerId).toBe('anthropic');
      expect(o.stepKey).toBe('review');
      expect(o.reservationMicrousd).toBeGreaterThan(0);
      expect([o.basis, o.estimatedInputTokens > 0]).toEqual(['step_estimate', true]); // the reserve-time estimate of the blocked step
    }
    expect(d.profileOptions?.filter((o) => o.current)).toHaveLength(1);
    expect(log).toEqual([]);
  });

  it('no options when choose_profile is not offered', async () => {
    const x = await harness();
    const runId = await x.startRun();
    expect(await drive(x, runId, ['awaiting_approval'])).toBe('awaiting_approval');

    const d = await detailOf(x, runId);

    expect(d.profileOptions).toEqual([]);
    // Run-level Attempts / Context on the approval step: every attempt of the run and the newest manifest.
    expect(d.attempts?.map((a) => a.stepKey)).toEqual(['review', 'plan']);
    expect(d.latestManifest).toEqual(expect.objectContaining({ stepKey: 'plan', attemptId: d.attempts?.[1]?.id }));
    const m = d.latestManifest == null ? null : await x.engine.handle('relay/v1/artifacts.get', { artifactId: d.latestManifest.artifactId });
    expect(m?.ok && m.data.content.kind).toBe('json');
  });
});

describe('suspected secrets (E2 coordination)', () => {
  const SECRET = 'export const KEY = "sk-ant-api03-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6";\n';

  it('preflight reports an unacknowledged suspected-secret file; acknowledging it clears the issue', async () => {
    const x = await harness({ files: { ...SAMPLE_FILES, 'src/config.ts': SECRET } });
    const wf = x.db.repos.workflows.listWorkflows()[0]?.id ?? ('' as never);
    const base = { projectId: x.projectId, workflowId: wf, workflowVersion: 1, goal: 'g' };

    const plain = await x.engine.handle('relay/v1/runs.preflight', { ...base, input: { kind: 'files', relPaths: ['src/handlers/user.ts', 'src/config.ts'] } });
    const ack = { relPath: 'src/config.ts', sha256: createHash('sha256').update(SECRET, 'utf8').digest('hex') };
    const acked = await x.engine.handle('relay/v1/runs.preflight', { ...base, input: { kind: 'files', relPaths: ['src/handlers/user.ts', 'src/config.ts'], acknowledgedSuspectedSecrets: [ack] } });
    const stale = await x.engine.handle('relay/v1/runs.preflight', { ...base, input: { kind: 'files', relPaths: ['src/handlers/user.ts', 'src/config.ts'], acknowledgedSuspectedSecrets: [{ ...ack, sha256: 'a'.repeat(64) }] } });
    const outside = await x.engine.handle('relay/v1/runs.start', { ...base, idempotencyKey: 'e1-secret-start-001', input: { kind: 'files', relPaths: ['src/handlers/user.ts'], acknowledgedSuspectedSecrets: [ack] } });

    expect(plain.ok && plain.data.issues.filter((i) => i.code === 'suspected_secret')).toEqual([expect.objectContaining({ path: 'input.relPaths.1' })]);
    expect(plain.ok && JSON.stringify(plain.data.issues)).not.toContain('sk-ant');
    expect(acked.ok && acked.data.issues.filter((i) => i.code === 'suspected_secret')).toEqual([]);
    expect(stale.ok && stale.data.issues.filter((i) => i.code === 'suspected_secret')).toEqual([expect.objectContaining({ path: 'input.relPaths.1' })]);
    expect(outside.ok ? null : outside.error.code).toBe('VALIDATION_FAILED');
  });
});
