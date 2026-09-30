import { lazy, Suspense, useEffect, useState } from 'react';
import { Skeleton } from '../Skeleton';
import type { DiffViewerProps } from './DiffViewer';

const DiffViewerImpl = lazy(() => import('./DiffViewer'));

/** Suspense fallback that marks the region busy while it is shown and clears it when it unmounts. */
function LoadingDiff({ onBusyChange }: { readonly onBusyChange: (busy: boolean) => void }) {
  useEffect(() => {
    onBusyChange(true);
    return () => { onBusyChange(false); };
  }, [onBusyChange]);
  return <Skeleton lines={8} />;
}

/** Code-split DiffViewer (09 I4 "lazy-loaded"); the barrel exports only this wrapper. */
export function LazyDiffViewer(props: DiffViewerProps) {
  const [isBusy, setIsBusy] = useState(false);
  return (
    <div aria-busy={isBusy}>
      <Suspense fallback={<LoadingDiff onBusyChange={setIsBusy} />}>
        <DiffViewerImpl {...props} />
      </Suspense>
    </div>
  );
}
