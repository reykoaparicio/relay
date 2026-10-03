import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RunnerState } from '@relay/contracts';
import { getBridge } from '../api/bridge';
import { call } from '../api/client';
import { appErrorOf } from '../api/errors';
import { startPushSync } from './push-sync';

const RunnerStateContext = createContext<RunnerState>('ready');

/** Starts the global push sync for the app's lifetime and exposes the runner state to the shell banner. */
export function PushSyncProvider({ children }: { readonly children: ReactNode }) {
  const queryClient = useQueryClient();
  const [runner, setRunner] = useState<RunnerState>('ready');
  useEffect(() => {
    let pushed = false;
    let cancelled = false;
    const stop = startPushSync(getBridge(), queryClient, (s) => {
      pushed = true;
      setRunner(s);
    });
    // The preload does not buffer pushes: a `runner.state` main sent before this subscription is lost, and the banner
    // would stay hidden while the runner is down. Ask main once for the current state; a push that arrives meanwhile
    // is newer and wins.
    call('relay/v1/app.getDiagnostics', {})
      .then((d) => {
        if (!cancelled && !pushed) setRunner(d.runner.state);
      })
      .catch((e: unknown) => {
        if (!cancelled && !pushed && appErrorOf(e)?.code === 'RUNNER_UNAVAILABLE') setRunner('unavailable');
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, [queryClient]);
  return <RunnerStateContext.Provider value={runner}>{children}</RunnerStateContext.Provider>;
}

/** Latest `runner.state` push (defaults to `ready` until one arrives). */
export function useRunnerState(): RunnerState {
  return useContext(RunnerStateContext);
}
