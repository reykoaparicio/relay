import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { runEventSchema } from '@relay/contracts';
import type * as ui from '../components/ui';
import { createFakeBridge, FAKE_PROJECT_ID } from '../api/fake-bridge';
import { renderApp } from '../features/testing/render-app';

type UiModule = typeof ui;
const timelineRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../components/ui', async (importOriginal) => {
  const actual = await importOriginal<UiModule>();
  // Counts every time the page asks StepTimeline to render (a parent re-render reaches this wrapper even when the
  // memoized StepTimeline itself would bail out), so an unchanged count means the page did not re-render.
  function CountingStepTimeline(props: ComponentProps<UiModule['StepTimeline']>) {
    timelineRenders.count += 1;
    return <actual.StepTimeline {...props} />;
  }
  return { ...actual, StepTimeline: CountingStepTimeline };
});

describe('RunInspectorPage render cost (PERF-02)', () => {
  it('a stream progress push updates the token count without re-rendering the page (StepTimeline)', async () => {
    const bridge = createFakeBridge('running-streaming');
    const run = bridge.world.runs[0];
    if (run === undefined) throw new Error('scenario has no run');
    renderApp(`/p/${FAKE_PROJECT_ID}/runs/${run.id}`, { bridge });
    await screen.findByRole('list', { name: 'Run steps' });
    await waitFor(() => {
      expect(screen.getByTestId('stream-tokens')).toHaveTextContent('1.4k tokens est.');
    });
    // Let the initial queries and effects settle before counting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = timelineRenders.count;
    const last = bridge.world.events.get(run.id)?.at(-1)?.seq ?? 0;

    act(() => {
      bridge.emit({
        type: 'run.event',
        event: runEventSchema.parse({
          id: 'evt_00000000000000000000099990',
          runId: run.id,
          seq: last + 1,
          type: 'attempt.stream_progress',
          at: Date.now(),
          payload: { stepKey: 'review', outputTokensSoFar: 2_950, elapsedMs: 52_000 },
        }),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('stream-tokens')).toHaveTextContent('3k tokens est.');
    });
    expect(timelineRenders.count).toBe(before);
  });
});
