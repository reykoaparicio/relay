import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

interface LiveRegionApi {
  /** Politely announce a message. Use for completion, pauses, approval requests, and "Copied"; never tokens (§5.7). */
  readonly announce: (message: string) => void;
}

const NOOP: LiveRegionApi = { announce: () => undefined };
const LiveRegionContext = createContext<LiveRegionApi>(NOOP);

/** Single app-wide polite live region (09 I3). */
export function LiveRegionProvider({ children }: { readonly children: ReactNode }) {
  const [entry, setEntry] = useState<{ readonly message: string; readonly n: number }>({ message: '', n: 0 });
  const announce = useCallback((message: string) => {
    setEntry((prev) => ({ message, n: prev.n + 1 }));
  }, []);
  const api = useMemo(() => ({ announce }), [announce]);
  return (
    <LiveRegionContext.Provider value={api}>
      {children}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="live-region">
        {/* A fresh node per message makes screen readers repeat identical announcements. */}
        <span key={entry.n}>{entry.message}</span>
      </div>
    </LiveRegionContext.Provider>
  );
}

export function useLiveRegion(): LiveRegionApi {
  return useContext(LiveRegionContext);
}
