// A run detail on screen without useRunEvents (Overview's focus run) is refetched after a status push; the inspector
// (useRun + useRunEvents) still costs one runs.get per status change.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createTestQueryClient } from '../components/ui/test-utils';
import { createFakeBridge } from '../api/fake-bridge';
import { installBridge } from '../api/bridge';
import { newIdempotencyKey } from '../api/idempotency';
import { useRun } from '../hooks/useRun';
import { useRunEvents } from '../hooks/useRunEvents';
import { useStep } from '../hooks/useStep';
import { PUSH_INVALIDATE_DEBOUNCE_MS, startPushSync } from './push-sync';

const settle = () => new Promise((r) => setTimeout(r, PUSH_INVALIDATE_DEBOUNCE_MS * 2 + 100));

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

function setup() {
  const bridge = createFakeBridge('active-run');
  installBridge(bridge);
  const queryClient = createTestQueryClient();
  const run = bridge.world.runs[0];
  if (run === undefined) throw new Error('no run');
  const invoke = vi.spyOn(bridge, 'invoke');
  stop = startPushSync(bridge, queryClient, () => undefined);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const gets = () => invoke.mock.calls.filter((c) => c[0] === 'relay/v1/runs.get').length;
  return { bridge, queryClient, run, wrapper, gets };
}

describe('push-sync: mounted run details', () => {
  it('refetches a mounted run detail that has no event stream (Overview) after a run.status push', async () => {
    const { bridge, run, wrapper, gets, queryClient } = setup();
    const { result } = renderHook(() => useRun(run.id), { wrapper });
    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    const before = gets();
    act(() => {
      bridge.emit({ type: 'run.status', runId: run.id, status: 'awaiting_approval', pauseReason: null, seq: 999 });
    });
    await waitFor(() => {
      expect(result.current.data?.status).toBe('awaiting_approval'); // patched in place at once
    });
    await settle();
    // …then refetched, so pendingApproval, steps and availableActions are the runner's, not the pre-push ones.
    expect(gets()).toBe(before + 1);
    expect(queryClient.getQueryState(['run', run.id])?.isInvalidated).toBe(false);
  });

  it('refetches a mounted step detail without an event stream (a second window\'s approval card) after a run.status push', async () => {
    const { bridge, run, wrapper } = setup();
    const step = run.steps[0];
    if (step === undefined) throw new Error('no step');
    const invoke = vi.spyOn(bridge, 'invoke');
    const { result } = renderHook(() => useStep(run.id, step.id), { wrapper });
    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    const stepGets = () => invoke.mock.calls.filter((c) => c[0] === 'relay/v1/runs.getStep').length;
    const before = stepGets();
    act(() => {
      bridge.emit({ type: 'run.status', runId: run.id, status: 'running', pauseReason: null, seq: 999 });
    });
    await settle();
    expect(stepGets()).toBe(before + 1);
  });

  it('a burst of status pushes refetches the detail once, at the end of the burst', async () => {
    const { bridge, run, wrapper, gets } = setup();
    const { result } = renderHook(() => useRun(run.id), { wrapper });
    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    const before = gets();
    act(() => {
      bridge.emit({ type: 'run.status', runId: run.id, status: 'paused', pauseReason: 'user', seq: 997 });
      bridge.emit({ type: 'run.status', runId: run.id, status: 'running', pauseReason: null, seq: 998 });
      bridge.emit({ type: 'run.status', runId: run.id, status: 'awaiting_approval', pauseReason: null, seq: 999 });
    });
    await settle();
    expect(gets()).toBe(before + 1);
  });

  it('an unmounted run detail is only marked stale, never fetched', async () => {
    const { bridge, run, wrapper, gets, queryClient } = setup();
    const view = renderHook(() => useRun(run.id), { wrapper });
    await waitFor(() => {
      expect(view.result.current.data).toBeDefined();
    });
    view.unmount();
    const before = gets();
    bridge.emit({ type: 'run.status', runId: run.id, status: 'awaiting_approval', pauseReason: null, seq: 999 });
    await settle();
    expect(gets()).toBe(before);
    expect(queryClient.getQueryState(['run', run.id])?.isInvalidated).toBe(true);
  });

  it('the inspector (useRun + useRunEvents) fetches the detail once per status change, not twice', async () => {
    const { bridge, run, wrapper, gets } = setup();
    const { result } = renderHook(
      () => {
        const detail = useRun(run.id);
        const events = useRunEvents(run.id);
        return { detail, events };
      },
      { wrapper },
    );
    await waitFor(() => {
      expect(result.current.detail.data).toBeDefined();
      expect(result.current.events.loaded).toBe(true);
    });
    const before = gets();
    // The runner's real order: run.event (run.status_changed), then run.status.
    await act(async () => {
      await bridge.invoke('relay/v1/runs.pause', { runId: run.id, idempotencyKey: newIdempotencyKey() } as never);
      // The pause takes effect once the in-flight request finishes (decision 2).
      bridge.finishInFlight(run.id);
    });
    await settle();
    expect(gets()).toBe(before + 1);
    expect(result.current.detail.data?.status).toBe('paused');
  });
});
