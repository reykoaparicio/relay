import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createTestQueryClient } from '../components/ui/test-utils';
import { createFakeBridge } from '../api/fake-bridge';
import { installBridge } from '../api/bridge';
import { toViewError, validationIssuesOf } from '../api/errors';
import { fieldForPath, FIELD } from '../features/new-run/new-run-model';
import { canonicalJson } from './useIdempotentMutation';
import { usePreflight } from './usePreflight';

function setup() {
  const bridge = createFakeBridge('active-run');
  installBridge(bridge);
  const invoke = vi.spyOn(bridge, 'invoke');
  const run = bridge.world.runs[0];
  if (run === undefined) throw new Error('no run');
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const keyFor = (memoryRecordIds?: string[]) =>
    canonicalJson({
      projectId: run.projectId,
      workflowId: run.workflow.id,
      workflowVersion: run.workflow.version,
      goal: 'g',
      input: { kind: 'files', relPaths: ['src/a.ts'] },
      ...(memoryRecordIds === undefined ? {} : { memoryRecordIds }),
    });
  const preflights = () => invoke.mock.calls.filter((c) => c[0] === 'relay/v1/runs.preflight').length;
  return { wrapper, keyFor, preflights };
}

const memoryIds = (n: number) => Array.from({ length: n }, (_, i) => 'mem_01' + String(i).padStart(24, '0'));

describe('usePreflight', () => {
  it('reports an input the schema rejects (51 memory records) as VALIDATION_FAILED at the memory field, not INTERNAL', async () => {
    const { wrapper, keyFor, preflights } = setup();
    const { result } = renderHook(() => usePreflight(keyFor(memoryIds(51))), { wrapper });
    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(preflights()).toBe(0); // never reached the runner
    expect(toViewError(result.current.error).code).toBe('VALIDATION_FAILED');
    const issues = validationIssuesOf(result.current.error);
    expect(issues.map((i) => i.path)).toEqual(['memoryRecordIds']);
    expect(fieldForPath(issues[0]?.path ?? '')).toBe(FIELD.memory);
  });

  it('sends a valid input to the runner', async () => {
    const { wrapper, keyFor, preflights } = setup();
    const { result } = renderHook(() => usePreflight(keyFor()), { wrapper });
    await waitFor(() => {
      expect(result.current.isFetched).toBe(true);
    });
    expect(preflights()).toBe(1);
  });
});
