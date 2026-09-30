import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RunnerState } from '@relay/contracts';
import { getBridge } from '../api/bridge';
import { startPushSync } from './push-sync';

const RunnerStateContext = createContext<RunnerState>('ready');

/** Starts the global push sync for the app's lifetime and exposes the runner state to the shell banner. */
export function PushSyncProvider({ children }: { readonly children: ReactNode }) {
  const queryClient = useQueryClient();
  const [runner, setRunner] = useState<RunnerState>('ready');
  useEffect(() => startPushSync(getBridge(), queryClient, setRunner), [queryClient]);
  return <RunnerStateContext.Provider value={runner}>{children}</RunnerStateContext.Provider>;
}

/** Latest `runner.state` push (defaults to `ready` until one arrives). */
export function useRunnerState(): RunnerState {
  return useContext(RunnerStateContext);
}
