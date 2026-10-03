import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { cx } from './cx';

/**
 * True while the element's content is wider than its box (re-measured on resize of the box or its first child).
 * Without ResizeObserver (jsdom) it stays false: the wrapper is then a plain, non-focusable container.
 */
export function useHorizontalOverflow(ref: RefObject<HTMLElement | null>): boolean {
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      setOverflowing(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild !== null) observer.observe(el.firstElementChild);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return overflowing;
}

/** True while an overflowing element is not scrolled to its right edge (more columns to the right). */
function useMoreToTheRight(ref: RefObject<HTMLElement | null>, overflowing: boolean): boolean {
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null || !overflowing) {
      setMore(false);
      return undefined;
    }
    const measure = () => {
      setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      el.removeEventListener('scroll', measure);
    };
  }, [ref, overflowing]);
  return more;
}

export interface TableScrollProps {
  /** Id of the element naming the table (usually its `<caption>`); names the scroll region when it overflows. */
  readonly labelledBy?: string;
  /** Accessible name when there is no element to point at. */
  readonly label?: string;
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * Horizontal scroll container for a table that may be wider than its card (09 I3 `DataTable`, the ledger tables).
 * Tables are sized to fit first (numbers don't wrap, text columns wrap); when they still don't fit, this wrapper
 * scrolls instead of clipping. While it overflows it is a named, keyboard-focusable region (arrow keys scroll it)
 * with an always-visible scrollbar (macOS overlay scrollbars would otherwise hide that there is more to see), and
 * the row-header column stays pinned.
 */
export function TableScroll({ labelledBy, label, className, children }: TableScrollProps) {
  const ref = useRef<HTMLDivElement>(null);
  const overflowing = useHorizontalOverflow(ref);
  // A right-edge fade while columns are hidden to the right, so a clipped table never reads as complete.
  const moreRight = useMoreToTheRight(ref, overflowing);
  const regionProps = overflowing
    ? {
        role: 'region',
        tabIndex: 0,
        ...(labelledBy === undefined ? { 'aria-label': `${label ?? 'Table'}, scrolls horizontally` } : { 'aria-labelledby': labelledBy }),
      }
    : {};
  return (
    <div ref={ref} className={cx('table-wrap', overflowing && 'is-overflowing', moreRight && 'more-right', className)} {...regionProps}>
      {children}
    </div>
  );
}
