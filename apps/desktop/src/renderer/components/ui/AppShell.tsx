import type { MouseEvent, ReactNode, Ref } from 'react';

export interface AppShellProps {
  /** Primary navigation (usually a SideNav). Wrapped in `<nav aria-label="Primary">`. */
  readonly nav: ReactNode;
  /** Bottom of the sidebar: project switcher, provider status, FakeProviderBadge. */
  readonly workspace?: ReactNode;
  readonly brand?: ReactNode;
  readonly children: ReactNode;
  /** The `<main tabIndex={-1}>` element (e.g. the focus-rescue fallback). */
  readonly mainRef?: Ref<HTMLElement>;
}

export const MAIN_ID = 'main';

// The app uses hash routing, so a plain `href="#main"` would change the route. Move focus instead.
function skipToMain(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  document.getElementById(MAIN_ID)?.focus();
}

export function AppShell({ nav, workspace, brand, children, mainRef }: AppShellProps) {
  return (
    <div className="shell">
      <a className="skip-link" href={`#${MAIN_ID}`} onClick={skipToMain}>
        Skip to main content
      </a>
      <aside className="sidebar">
        <div className="brand">
          {brand ?? (
            <>
              Relay<small>Bounded AI workflows</small>
            </>
          )}
        </div>
        <nav aria-label="Primary">{nav}</nav>
        {workspace === undefined ? null : <div className="workspace">{workspace}</div>}
      </aside>
      <main ref={mainRef} id={MAIN_ID} className="main" tabIndex={-1}>
        <div className="main-inner">{children}</div>
      </main>
    </div>
  );
}
