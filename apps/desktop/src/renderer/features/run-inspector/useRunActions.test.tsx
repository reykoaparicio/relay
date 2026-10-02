import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { createTestQueryClient } from '../../components/ui/test-utils';
import { installBridge } from '../../api/bridge';
import { createFakeBridge, FAKE_PROJECT_ID } from '../../api/fake-bridge';
import { appError } from '@relay/contracts';
import type { FakeScenarioName } from '../../api/fake-bridge';
import { IntentInFlightError } from '../../hooks/useIdempotentMutation';
import { useRunActions } from './useRunActions';
import type { RunActionsContext } from './useRunActions';

function setup(scenario: FakeScenarioName, context?: (runId: string) => RunActionsContext) {
  const bridge = createFakeBridge(scenario);
  installBridge(bridge);
  const run = bridge.world.runs[0];
  if (run === undefined) throw new Error('scenario has no run');
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  const hook = renderHook(() => useRunActions(context?.(run.id)), { wrapper });
  return { bridge, run, hook, queryClient };
}

describe('useRunActions', () => {
  it('B4: a different action while one is in flight is rejected, not resolved with the first result', async () => {
    const { bridge, run, hook } = setup('paused-user');
    const release = bridge.hold('relay/v1/runs.resume');
    let a: Promise<boolean> = Promise.resolve(false);
    let b: Promise<boolean> = Promise.resolve(true);
    act(() => {
      a = hook.result.current.dispatch({ action: 'resume', runId: run.id });
    });
    expect(hook.result.current.busy).toBe(true);
    act(() => {
      b = hook.result.current.dispatch({ action: 'acknowledge_overrun', runId: run.id });
    });
    expect(await b).toBe(false);
    expect(hook.result.current.error).toBeInstanceOf(IntentInFlightError);
    release();
    await act(async () => {
      expect(await a).toBe(true);
    });
    const calls = bridge.callsTo('relay/v1/runs.resume');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toMatchObject({ decision: { kind: 'continue' } });
    expect(hook.result.current.busy).toBe(false);
  });

  it('B4: the same action submitted twice is one call', async () => {
    const { bridge, run, hook } = setup('active-run');
    const release = bridge.hold('relay/v1/runs.pause');
    let a: Promise<boolean> = Promise.resolve(false);
    let b: Promise<boolean> = Promise.resolve(false);
    act(() => {
      a = hook.result.current.dispatch({ action: 'pause', runId: run.id });
      b = hook.result.current.dispatch({ action: 'pause', runId: run.id });
    });
    release();
    await act(async () => {
      expect(await Promise.all([a, b])).toEqual([true, true]);
    });
    expect(bridge.callsTo('relay/v1/runs.pause')).toHaveLength(1);
    expect(hook.result.current.error).toBeNull();
  });

  it('B5: approval success invalidates the displayed run, its steps, its ledger, and the project run lists', async () => {
    const { bridge, run, hook, queryClient } = setup('awaiting-approval', (runId) => ({ runId, projectId: FAKE_PROJECT_ID }));
    const approval = run.pendingApproval;
    if (approval === null) throw new Error('scenario has no pending approval');
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    await act(async () => {
      await hook.result.current.dispatch({
        action: 'approve',
        approvalId: approval.id,
        planHash: approval.planHash,
        contextHash: approval.contextHash,
      });
    });
    await waitFor(() => {
      expect(bridge.callsTo('relay/v1/approvals.decide')).toHaveLength(1);
    });
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(['run', run.id]);
    expect(keys).toContainEqual(['step', run.id]);
    expect(keys).toContainEqual(['ledger', run.id]);
    expect(keys).toContainEqual(['runs', FAKE_PROJECT_ID]);
  });

  it('B5: a run-scoped action invalidates its run, steps, and ledger', async () => {
    const { run, hook, queryClient } = setup('active-run');
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    await act(async () => {
      expect(await hook.result.current.dispatch({ action: 'pause', runId: run.id })).toBe(true);
    });
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(['run', run.id]);
    expect(keys).toContainEqual(['step', run.id]);
    expect(keys).toContainEqual(['ledger', run.id]);
  });

  it('error and pending belong to the run they were started from (the inspector keeps the hook across runs)', async () => {
    const bridge = createFakeBridge('active-run');
    installBridge(bridge);
    const run = bridge.world.runs[0];
    if (run === undefined) throw new Error('scenario has no run');
    const otherRun = 'run_00000000000000000000099999';
    const queryClient = createTestQueryClient();
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    const initialProps: { runId: string } = { runId: run.id };
    const hook = renderHook(({ runId }: { runId: string }) => useRunActions({ runId, projectId: FAKE_PROJECT_ID }), {
      wrapper,
      initialProps,
    });

    // A failed action on run A…
    bridge.failNext('relay/v1/runs.pause', appError('CONFLICT'));
    await act(async () => {
      expect(await hook.result.current.dispatch({ action: 'pause', runId: run.id })).toBe(false);
    });
    expect(hook.result.current.error).not.toBeNull();
    // …is not shown on run B, and is back on A (until cleared).
    hook.rerender({ runId: otherRun });
    expect(hook.result.current.error).toBeNull();
    hook.rerender({ runId: run.id });
    expect(hook.result.current.error).not.toBeNull();
    act(() => {
      hook.result.current.clearError();
    });

    // An action in flight on A: B shows no pending button, but stays busy until A's request settles.
    const release = bridge.hold('relay/v1/runs.pause');
    let a: Promise<boolean> = Promise.resolve(false);
    act(() => {
      a = hook.result.current.dispatch({ action: 'pause', runId: run.id });
    });
    expect(hook.result.current.pending).toBe('pause');
    hook.rerender({ runId: otherRun });
    expect(hook.result.current.pending).toBeNull();
    expect(hook.result.current.busy).toBe(true);
    release();
    await act(async () => {
      expect(await a).toBe(true);
    });
    expect(hook.result.current.busy).toBe(false);
    expect(hook.result.current.error).toBeNull();
  });
});
