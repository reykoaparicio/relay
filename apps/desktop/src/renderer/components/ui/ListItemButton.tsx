import { useId } from 'react';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

export interface ListItemButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children' | 'type' | 'aria-label' | 'aria-labelledby' | 'aria-describedby'> {
  /** The accessible name (aria-labelledby). Put any screen-reader-only prefix (e.g. "Step 2: ") inside it. */
  readonly title: ReactNode;
  /** Shown beside the title (e.g. a status badge); part of the description. */
  readonly aside?: ReactNode;
  /** Secondary line(s) under the title; part of the description. */
  readonly meta?: ReactNode;
  /** Tags and badges under the meta line; part of the description. */
  readonly badges?: ReactNode;
  /** Decoration before the text (e.g. a step number); hidden from assistive tech. */
  readonly leading?: ReactNode;
  /** Replaces the default `list-item` class (e.g. `''` inside a `.timeline`, which styles its own buttons). */
  readonly className?: string;
  readonly ref?: Ref<HTMLButtonElement>;
}

/**
 * A selectable list row as one `<button>`: its name is the title only (aria-labelledby) and the meta line and
 * badges are its description (aria-describedby), so screen readers say "Plan fix, button, current step" first and
 * the details after, instead of the whole row as one long name. No hand-written aria-label.
 */
export function ListItemButton({ title, aside, meta, badges, leading, className = 'list-item', ref, ...rest }: ListItemButtonProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const asideId = `${id}-aside`;
  const metaId = `${id}-meta`;
  const badgesId = `${id}-badges`;
  const describedBy = [aside === undefined ? null : asideId, meta === undefined ? null : metaId, badges === undefined ? null : badgesId]
    .filter((x): x is string => x !== null)
    .join(' ');
  const titleEl = (
    <span id={titleId} className="title">
      {title}
    </span>
  );
  const text = (
    <>
      {aside === undefined ? (
        titleEl
      ) : (
        <span className="row" style={{ justifyContent: 'space-between' }}>
          {titleEl}
          <span id={asideId}>{aside}</span>
        </span>
      )}
      {meta === undefined ? null : (
        <span id={metaId} className="meta">
          {meta}
        </span>
      )}
      {badges === undefined ? null : (
        <span id={badgesId} className="meta row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {badges}
        </span>
      )}
    </>
  );
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      className={className === '' ? undefined : className}
      aria-labelledby={titleId}
      {...(describedBy === '' ? {} : { 'aria-describedby': describedBy })}
    >
      {leading === undefined ? (
        text
      ) : (
        <span className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          <span aria-hidden="true">{leading}</span>
          <span className="stack" style={{ gap: 2 }}>
            {text}
          </span>
        </span>
      )}
    </button>
  );
}
