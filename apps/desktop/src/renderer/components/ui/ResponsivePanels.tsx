import { useEffect, useId } from 'react';
import { Tabs } from './Tabs';
import type { Panel } from './Tabs';
import { useMediaQuery } from './useMediaQuery';

export type { Panel } from './Tabs';

/** §5.7: below this width the inspector's bottom row collapses into the tab strip. */
export const DEFAULT_PANELS_BREAKPOINT_PX = 1280;

export interface ResponsivePanelsProps {
  readonly tabs: readonly Panel[];
  /** Shown as a bottom row of labelled sections when wide; appended to the tabs when narrow. */
  readonly secondary: readonly Panel[];
  readonly value: string;
  readonly onValueChange: (id: string) => void;
  /** Accessible name of the tab list. */
  readonly label: string;
  readonly breakpointPx?: number;
}

/**
 * Wide (≥ breakpoint): primary tabs + secondary sections. Narrow: one tab strip holding both,
 * with the same ids, so no content is ever hidden (09 I3, used by the Run inspector).
 */
export function ResponsivePanels({
  tabs,
  secondary,
  value,
  onValueChange,
  label,
  breakpointPx = DEFAULT_PANELS_BREAKPOINT_PX,
}: ResponsivePanelsProps) {
  const isWide = useMediaQuery(`(min-width: ${String(breakpointPx)}px)`);
  const headingBase = useId();
  const firstId = tabs[0]?.id;
  const selectedIsSecondary = secondary.some((p) => p.id === value);
  const mustFallBack = isWide && selectedIsSecondary && firstId !== undefined;
  const effectiveValue = mustFallBack ? firstId : value;

  useEffect(() => {
    if (mustFallBack) onValueChange(firstId);
  }, [mustFallBack, firstId, onValueChange]);

  if (!isWide) {
    return <Tabs label={label} tabs={[...tabs, ...secondary]} value={effectiveValue} onValueChange={onValueChange} />;
  }
  return (
    <div className="panels">
      <Tabs label={label} tabs={tabs} value={effectiveValue} onValueChange={onValueChange} />
      {secondary.length > 0 ? (
        <div className="panels-row">
          {secondary.map((p) => {
            const headingId = `${headingBase}-${p.id}`;
            return (
              <section key={p.id} className="card" aria-labelledby={headingId} data-panel-id={p.id}>
                <h2 id={headingId}>{p.label}</h2>
                {p.content}
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
