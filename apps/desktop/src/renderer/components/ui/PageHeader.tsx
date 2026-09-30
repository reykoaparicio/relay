import type { ReactNode } from 'react';

export interface Breadcrumb {
  readonly label: string;
  readonly href?: string;
}

export interface PageHeaderProps {
  readonly title: ReactNode;
  readonly breadcrumbs?: readonly Breadcrumb[];
  /** Live status (e.g. a StatusBadge); announced politely when it changes. */
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
                    <span aria-current={i === breadcrumbs.length - 1 ? 'page' : undefined}>{b.label}</span>
                  ) : (
                    <a href={b.href}>{b.label}</a>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <h1>{title}</h1>
        {status === undefined ? null : (
          <div className="status-line" role="status" aria-live="polite">
            {status}
          </div>
        )}
      </div>
      {actions === undefined ? null : <div className="actions">{actions}</div>}
    </header>
  );
}
