import { lazy, Suspense } from 'react';
import { Skeleton } from '../Skeleton';
import type { DiffViewerProps } from './DiffViewer';

const DiffViewerImpl = lazy(() => import('./DiffViewer'));

/** Code-split DiffViewer (09 I4 "lazy-loaded"); the barrel exports only this wrapper. */
export function LazyDiffViewer(props: DiffViewerProps) {
  return (
    <div aria-busy="false">
      <Suspense fallback={<Skeleton lines={8} />}>
        <DiffViewerImpl {...props} />
      </Suspense>
    </div>
  );
}
