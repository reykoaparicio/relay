import { describe, expect, it, vi } from 'vitest';
import type { InfiniteData } from '@tanstack/react-query';
import { idSchema } from '@relay/contracts';
import type { OutputOf } from '@relay/contracts';
import { createTestQueryClient } from '../components/ui/test-utils';
import { createFakeBridge } from '../api/fake-bridge';
import { qk } from '../api/keys';
import { PUSH_INVALIDATE_DEBOUNCE_MS, startPushSync } from './push-sync';

type RunsPage = OutputOf<'relay/v1/runs.list'>;

async function seeded() {
  const bridge = createFakeBridge('active-run');
  const queryClient = createTestQueryClient();
  const run = bridge.world.runs[0];
  if (run === undefined) throw new Error('no run');
  const page = await bridge.invoke('relay/v1/runs.list', { projectId: run.projectId });
  if (!page.ok) throw new Error('list failed');
  queryClient.setQueryData<InfiniteData<RunsPage>>(qk.runs(run.projectId, 'all', 25), { pages: [page.data], pageParams: [undefined] });
  queryClient.setQueryData(qk.runs(run.projectId, 'awaiting-count', 100), page.data);
  queryClient.setQueryData(qk.run(run.id), run);
  return { bridge, queryClient, run };
}

describe('push-sync', () => {
  it('run.status updates cached run summaries and details in place', async () => {
    const { bridge, queryClient, run } = await seeded();
    const onRunner = vi.fn();
    const stop = startPushSync(bridge, queryClient, onRunner);
    bridge.emit({ type: 'run.status', runId: run.id, status: 'paused', pauseReason: 'user', seq: 99 });
    const list = queryClient.getQueryData<InfiniteData<RunsPage>>(qk.runs(run.projectId, 'all', 25));
    expect(list?.pages[0]?.items.find((r) => r.id === run.id)).toMatchObject({ status: 'paused', pauseReason: 'user' });
    const single = queryClient.getQueryData<RunsPage>(qk.runs(run.projectId, 'awaiting-count', 100));
    expect(single?.items.find((r) => r.id === run.id)?.status).toBe('paused');
    expect(queryClient.getQueryData<typeof run>(qk.run(run.id))?.status).toBe('paused');
    stop();
  });

  it('memory.changed and providers.changed invalidate their queries; runner.state reaches the banner', async () => {
    const { bridge, queryClient, run } = await seeded();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const onRunner = vi.fn();
    const stop = startPushSync(bridge, queryClient, onRunner);
    bridge.emit({ type: 'memory.changed', projectId: run.projectId });
    bridge.emit({ type: 'providers.changed' });
    bridge.emit({ type: 'runner.state', state: 'restarting' });
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(['memory', run.projectId]);
    expect(keys).toContainEqual(['providers']);
    expect(onRunner).toHaveBeenCalledWith('restarting');
    stop();
  });

  it('run.status refreshes only that project (debounced, trailing) and never refetches the patched run detail', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, queryClient, run } = await seeded();
      queryClient.setQueryData(qk.runs('prj_other', 'all', 25), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });
      const spy = vi.spyOn(queryClient, 'invalidateQueries');
      const stop = startPushSync(bridge, queryClient, vi.fn());

      bridge.emit({ type: 'run.status', runId: run.id, status: 'paused', pauseReason: 'user', seq: 99 });
      bridge.emit({ type: 'run.status', runId: run.id, status: 'running', pauseReason: null, seq: 100 });
      bridge.emit({ type: 'run.status', runId: run.id, status: 'paused', pauseReason: 'user', seq: 101 });
      const lists = () => spy.mock.calls.filter((c) => c[0]?.refetchType !== 'none');
      expect(lists()).toHaveLength(0);
      vi.advanceTimersByTime(PUSH_INVALIDATE_DEBOUNCE_MS);

      const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
      expect(lists().map((c) => c[0]?.queryKey)).toEqual([
        ['runs', run.projectId],
        ['project', run.projectId],
      ]);
      expect(keys).not.toContainEqual(['runs']);
      // The patched detail is only marked stale (refetched on its next mount), never refetched by the push.
      const runCalls = spy.mock.calls.filter((c) => JSON.stringify(c[0]?.queryKey) === JSON.stringify(qk.run(run.id)));
      expect(runCalls.every((c) => c[0]?.refetchType === 'none')).toBe(true);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('run.status of a run no cache knows falls back to every run list (debounced)', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, queryClient } = await seeded();
      const spy = vi.spyOn(queryClient, 'invalidateQueries');
      const stop = startPushSync(bridge, queryClient, vi.fn());

      bridge.emit({ type: 'run.status', runId: idSchema('run').parse('run_00000000000000000000099999'), status: 'completed', pauseReason: null, seq: 1 });
      vi.advanceTimersByTime(PUSH_INVALIDATE_DEBOUNCE_MS);

      expect(spy.mock.calls.filter((c) => c[0]?.refetchType !== 'none').map((c) => c[0]?.queryKey)).toEqual([['runs'], ['project']]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("memory.changed invalidates that project's records only", async () => {
    const { bridge, queryClient, run } = await seeded();
    queryClient.setQueryData(qk.memoryRecord('mem_mine'), { id: 'mem_mine', projectId: run.projectId });
    queryClient.setQueryData(qk.memoryRecord('mem_other'), { id: 'mem_other', projectId: 'prj_other' });
    const stop = startPushSync(bridge, queryClient, vi.fn());

    bridge.emit({ type: 'memory.changed', projectId: run.projectId });

    expect(queryClient.getQueryState(qk.memoryRecord('mem_mine'))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(qk.memoryRecord('mem_other'))?.isInvalidated).toBe(false);
    stop();
  });
});
