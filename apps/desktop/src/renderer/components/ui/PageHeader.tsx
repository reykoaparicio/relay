import type { ReactNode } from 'react';

export interface Breadcrumb {
  readonly label: string;
  readonly href?: string;
  /** Secondary detail in a tooltip (e.g. the project's full folder path behind "Local project"). */
  readonly title?: string;
}

export interface PageHeaderProps {
  readonly title: ReactNode;
  readonly breadcrumbs?: readonly Breadcrumb[];
  /**
   * Current status (e.g. a StatusBadge). Not a live region: run status changes are announced once by `useRunEvents`
   * through the app live region.
   */
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
}

export function PageHeader({ title, breadcrumbs = [], status, actions }: PageHeaderProps) {
  return (
    <header className="topbar">
      <div>
        {breadcrumbs.length > 0 ? (
          <nav aria-label="Breadcrumb">
            <ol className="breadcrumbs">
              {breadcrumbs.map((b, i) => (
                <li key={`${b.label}-${String(i)}`}>
                  {b.href === undefined ? (
                    <span aria-current={i === breadcrumbs.length - 1 ? 'page' : undefined} title={b.title}>
                      {b.label}
                    </span>
                  ) : (
                    <a href={b.href} title={b.title}>
                      {b.label}
                    </a>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <h1>{title}</h1>
        {status === undefined ? null : (
          <div className="status-line">
            {status}
          </div>
        )}
      </div>
      {actions === undefined ? null : <div className="actions">{actions}</div>}
    </header>
  );
}
