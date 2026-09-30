import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { errors } from '@relay/contracts';
import { createTestQueryClient } from '../components/ui/test-utils';
import { installBridge } from '../api/bridge';
import { createFakeBridge } from '../api/fake-bridge';
import { canonicalJson, IntentInFlightError, useIdempotentMutation } from './useIdempotentMutation';

function setup() {
  const bridge = createFakeBridge('empty');
  installBridge(bridge);
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { readonly children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useIdempotentMutation('relay/v1/projects.createSample'), { wrapper });
  return { bridge, hook };
}

const keyOf = (input: unknown) => (input as { idempotencyKey: string }).idempotencyKey;

describe('useIdempotentMutation', () => {
  it('double submit → one call with one key', async () => {
    const { bridge, hook } = setup();
    const release = bridge.hold('relay/v1/projects.createSample');
    let a: Promise<unknown> = Promise.resolve();
    let b: Promise<unknown> = Promise.resolve();
    act(() => {
      a = hook.result.current.mutateAsync({});
      b = hook.result.current.mutateAsync({});
    });
    await waitFor(() => {
      expect(hook.result.current.isPending).toBe(true);
    });
    release();
    await act(async () => {
      await Promise.all([a, b]);
    });
    const calls = bridge.callsTo('relay/v1/projects.createSample');
    expect(calls).toHaveLength(1);
    expect(keyOf(calls[0]?.input)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a).toBe(b);
  });

  it('a retry of the same intent reuses the key; success resets it', async () => {
    const { bridge, hook } = setup();
    bridge.failNext('relay/v1/projects.createSample', errors.runnerUnavailable());
    await act(async () => {
      await hook.result.current.mutateAsync({}).catch(() => undefined);
    });
    await act(async () => {
      await hook.result.current.mutateAsync({});
    });
    const [first, retry] = bridge.callsTo('relay/v1/projects.createSample');
    expect(keyOf(first?.input)).toBe(keyOf(retry?.input));
    expect(hook.result.current.currentKey()).toBeNull();

    await act(async () => {
      await hook.result.current.mutateAsync({});
    });
    const third = bridge.callsTo('relay/v1/projects.createSample')[2];
    expect(keyOf(third?.input)).not.toBe(keyOf(first?.input));
  });

  it('newIntent() (form changed) gives the next submit a fresh key', async () => {
    const { bridge, hook } = setup();
    bridge.failNext('relay/v1/projects.createSample', errors.runnerUnavailable());
    await act(async () => {
      await hook.result.current.mutateAsync({}).catch(() => undefined);
    });
    act(() => {
      hook.result.current.newIntent();
    });
    await act(async () => {
      await hook.result.current.mutateAsync({});
    });
    const [first, second] = bridge.callsTo('relay/v1/projects.createSample');
    expect(keyOf(first?.input)).not.toBe(keyOf(second?.input));
  });

  it('B4: a different input while another is in flight is rejected, never resolved with the first result', async () => {
    const bridge = createFakeBridge('paused-user');
    installBridge(bridge);
    const run = bridge.world.runs.find((r) => r.status === 'paused');
    if (run === undefined) throw new Error('scenario has no paused run');
    const queryClient = createTestQueryClient();
    const wrapper = ({ children }: { readonly children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const hook = renderHook(() => useIdempotentMutation('relay/v1/runs.resume'), { wrapper });
    const release = bridge.hold('relay/v1/runs.resume');
    let a: Promise<unknown> = Promise.resolve();
    let b: Promise<unknown> = Promise.resolve();
    act(() => {
      a = hook.result.current.mutateAsync({ runId: run.id, decision: { kind: 'continue' } });
      b = hook.result.current.mutateAsync({ runId: run.id, decision: { kind: 'acknowledge_overrun' } });
    });
    await expect(b).rejects.toBeInstanceOf(IntentInFlightError);
    await expect(b).rejects.toMatchObject({ appError: { code: 'CONFLICT' } });
    release();
    await act(async () => {
      await a;
    });
    const calls = bridge.callsTo('relay/v1/runs.resume');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toMatchObject({ decision: { kind: 'continue' } });
  });

  it('B4: same intent (key order irrelevant) dedupes; a changed input after a failure gets a new key', async () => {
    const bridge = createFakeBridge('paused-user');
    installBridge(bridge);
    const run = bridge.world.runs.find((r) => r.status === 'paused');
    if (run === undefined) throw new Error('scenario has no paused run');
    const queryClient = createTestQueryClient();
    const wrapper = ({ children }: { readonly children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const hook = renderHook(() => useIdempotentMutation('relay/v1/runs.resume'), { wrapper });
    const release = bridge.hold('relay/v1/runs.resume');
    let a: Promise<unknown> = Promise.resolve();
    let b: Promise<unknown> = Promise.resolve();
    act(() => {
      a = hook.result.current.mutateAsync({ runId: run.id, decision: { kind: 'raise_limits', maxAttempts: 9, executionTimeoutSeconds: 600 } });
      b = hook.result.current.mutateAsync({ decision: { executionTimeoutSeconds: 600, maxAttempts: 9, kind: 'raise_limits' }, runId: run.id });
    });
    expect(a).toBe(b);
    release();
    await act(async () => {
      await a;
    });
    expect(bridge.callsTo('relay/v1/runs.resume')).toHaveLength(1);

    // A failed attempt keeps its key only for the same input; a different input is a new intent.
    bridge.failNext('relay/v1/runs.resume', errors.runnerUnavailable());
    await act(async () => {
      await hook.result.current.mutateAsync({ runId: run.id, decision: { kind: 'continue' } }).catch(() => undefined);
    });
    await act(async () => {
      await hook.result.current.mutateAsync({ runId: run.id, decision: { kind: 'acknowledge_overrun' } }).catch(() => undefined);
    });
    const [, failed, changed] = bridge.callsTo('relay/v1/runs.resume');
    expect(keyOf(failed?.input)).not.toBe(keyOf(changed?.input));
  });

  it('canonicalJson sorts keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } })).toBe('{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}');
  });
});
