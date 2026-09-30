export interface SkeletonProps {
  readonly lines?: number;
  /** Line height in px; reserve the real content's height to avoid layout jumps. */
  readonly height?: number;
}

/** Decorative placeholder: `aria-hidden`. The loading container sets `aria-busy` (09 I3). */
export function Skeleton({ lines = 3, height = 14 }: SkeletonProps) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} style={{ height }} />
      ))}
    </div>
  );
}
