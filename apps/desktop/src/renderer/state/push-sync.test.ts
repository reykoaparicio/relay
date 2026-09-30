import { describe, expect, it, vi } from 'vitest';
import type { InfiniteData } from '@tanstack/react-query';
import type { OutputOf } from '@relay/contracts';
import { createTestQueryClient } from '../components/ui/test-utils';
import { createFakeBridge } from '../api/fake-bridge';
import { qk } from '../api/keys';
import { startPushSync } from './push-sync';

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
});
