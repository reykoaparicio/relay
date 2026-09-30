import { useEffect, useId, useRef } from 'react';
import { CircleAlert } from 'lucide-react';

export interface FormProblem {
  /** Id of the control to focus, or null for a problem without a field (e.g. a provider credential). */
  readonly fieldId: string | null;
  readonly message: string;
  /** Stable error code shown beside the message (text, never color only). */
  readonly code?: string;
}

export interface ErrorSummaryProps {
  readonly problems: readonly FormProblem[];
  /** Move focus to the summary when it appears (after a submit). */
  readonly focusOnMount?: boolean;
  readonly title?: (count: number) => string;
}

function focusField(id: string): void {
  const el = document.getElementById(id);
  if (el === null) return;
  el.scrollIntoView({ block: 'center' });
  el.focus();
}

const defaultTitle = (n: number) =>
  `${String(n)} ${n === 1 ? 'problem prevents' : 'problems prevent'} starting this run`;

/**
 * Error summary at the top of a form (00b §5, ui-ux-pro-max `error-feedback`): each entry links to its field. Links
 * focus the field in script, because a `#id` href would change the hash route.
 */
export function ErrorSummary({ problems, focusOnMount = false, title = defaultTitle }: ErrorSummaryProps) {
  const headingId = useId();
  const ref = useRef<HTMLElement>(null);
  const shouldFocus = focusOnMount && problems.length > 0;
  useEffect(() => {
    if (shouldFocus) ref.current?.focus();
  }, [shouldFocus]);
  if (problems.length === 0) return null;
  return (
    <section ref={ref} className="banner danger" aria-labelledby={headingId} tabIndex={-1} role="alert">
      <CircleAlert aria-hidden="true" />
      <div className="body">
        <strong id={headingId}>{title(problems.length)}</strong>
        <ul className="stack small" style={{ margin: 0, paddingLeft: 16 }}>
          {problems.map((p, i) => (
            <li key={`${p.fieldId ?? 'form'}:${String(i)}`}>
              {p.fieldId === null ? (
                p.message
              ) : (
                <a
                  href={`#${p.fieldId}`}
                  onClick={(e) => {
                    e.preventDefault();
                    focusField(p.fieldId ?? '');
                  }}
                >
                  {p.message}
                </a>
              )}
              {p.code === undefined ? null : (
                <>
                  {' '}
                  <code className="small">{p.code}</code>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
