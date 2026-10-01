import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { RunEvent } from '@relay/contracts';
import type { StreamProgressStore } from './useRunEvents';

/** The stream progress of the run on screen; provided by the page that owns `useRunEvents`. */
export const StreamProgressContext = createContext<StreamProgressStore | null>(null);

const NO_SUBSCRIPTION = () => () => undefined;

/** Progress is keyed by attempt id when the event names one, else by step: the newest of the two. */
function latestProgress(
  progress: ReadonlyMap<string, RunEvent>,
  attemptId: string | undefined,
  stepKey: string | undefined,
): RunEvent | undefined {
  const byAttempt = attemptId === undefined ? undefined : progress.get(attemptId);
  const byStep = stepKey === undefined ? undefined : progress.get(`step:${stepKey}`);
  if (byAttempt === undefined) return byStep;
  if (byStep === undefined) return byAttempt;
  return byStep.seq > byAttempt.seq ? byStep : byAttempt;
}

/**
 * The latest `attempt.stream_progress` of one attempt (or of its step when the event names no attempt). Subscribes to
 * the run's progress store, so a progress push re-renders only the component that calls this (PERF-02).
 */
export function useStreamProgress(runId: string, attemptId: string | undefined, stepKey?: string): RunEvent | undefined {
  const store = useContext(StreamProgressContext);
  const active = store !== null && store.runId === runId ? store : null;
  const getSnapshot = useCallback(
    () => (active === null ? undefined : latestProgress(active.snapshot(), attemptId, stepKey)),
    [active, attemptId, stepKey],
  );
  return useSyncExternalStore(active?.subscribe ?? NO_SUBSCRIPTION, getSnapshot);
}
