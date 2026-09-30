// Deterministic loop driving for engine tests: `tick` repeatedly, pumping the MANUAL timers only while a tick waits
// on them (backoff `wait_until`, rate-limit waits). Never touches global timers (R4-36).
import type { ProviderId, RunId, RunStatus } from '@relay/contracts';
import type { ModelResult, ProviderRegistry } from '@relay/providers';
import { selectNextStep, tick } from '../runner.js';
import type { Harness } from './harness.js';
import { sleep } from './harness.js';

/**
 * Ticks `runId` until its status is one of `statuses`. Manual time moves only when the next tick will wait for a
 * backoff (`wait_until`): the timers are advanced exactly to the earliest `not_before_at`.
 */
export async function drive(h: Harness, runId: RunId, statuses: readonly RunStatus[], o: { maxTicks?: number } = {}): Promise<RunStatus> {
  const maxTicks = o.maxTicks ?? 200;
  for (let i = 0; i < maxTicks; i += 1) {
    const run = h.db.repos.runs.get(runId);
    if (statuses.includes(run.status)) return run.status;
    const next = run.status === 'running' && !run.pauseRequested ? selectNextStep(h.db.repos.steps.latestPerStepKey(runId), h.clock.now()) : null;
    const p = tick(h.ctx);
    if (next?.kind === 'wait_until') {
      for (let k = 0; k < 5; k += 1) await sleep(0);
      h.timers.advance(Math.max(0, next.at - h.clock.now()));
    }
    await p;
  }
  throw new Error(`drive: run ${runId} stuck in ${h.db.repos.runs.get(runId).status}, wanted ${statuses.join('|')}`);
}

/** Approves the run's pending approval through IPC (echoing the shown hashes). */
export async function approvePending(h: Harness, runId: RunId, key = 'approve-key-000001'): Promise<void> {
  const detail = await h.engine.handle('relay/v1/runs.get', { runId });
  if (!detail.ok || detail.data.pendingApproval === null) throw new Error('no pending approval');
  const a = detail.data.pendingApproval;
  const decided = await h.engine.handle('relay/v1/approvals.decide', {
    idempotencyKey: key, approvalId: a.id, planHash: a.planHash, contextHash: a.contextHash, decision: 'approved',
  });
  if (!decided.ok) throw new Error(`approve: ${decided.error.code}`);
}

/** Drives through the approval to one of `statuses`. */
export async function driveThroughApproval(h: Harness, runId: RunId, statuses: readonly RunStatus[]): Promise<RunStatus> {
  const first = await drive(h, runId, ['awaiting_approval', ...statuses]);
  if (first !== 'awaiting_approval' || statuses.includes('awaiting_approval')) return first;
  await approvePending(h, runId);
  return drive(h, runId, statuses);
}

/** Wraps every adapter's `generate` (and optionally `testConnection`). */
export function wrapAdapters(
  f: {
    generate?: (base: ProviderRegistry, ...a: Parameters<ReturnType<ProviderRegistry['get']>['generate']>) => Promise<ModelResult>;
    testConnection?: (base: ProviderRegistry, ...a: Parameters<ReturnType<ProviderRegistry['get']>['testConnection']>) => Promise<ModelResult>;
  },
): (base: ProviderRegistry) => ProviderRegistry {
  return (base) => ({
    list: () => base.list(),
    get: (id: ProviderId) => {
      const a = base.get(id);
      return {
        ...a,
        ...(f.generate === undefined ? {} : { generate: (req, gctx) => f.generate?.(base, req, gctx) ?? a.generate(req, gctx) }),
        ...(f.testConnection === undefined ? {} : { testConnection: (tctx) => f.testConnection?.(base, tctx) ?? a.testConnection(tctx) }),
      };
    },
  });
}
