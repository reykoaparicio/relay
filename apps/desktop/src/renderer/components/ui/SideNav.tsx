import type { MouseEvent } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface NavItemData {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
  readonly badgeCount?: number;
  /** Screen-reader text for the count, e.g. (n) => `${n} waiting for approval`. */
  readonly badgeLabel?: (count: number) => string;
}

export interface NavItemProps {
  readonly item: NavItemData;
  readonly active: boolean;
  readonly onNavigate?: (key: string, event: MouseEvent<HTMLAnchorElement>) => void;
}

export function NavItem({ item, active, onNavigate }: NavItemProps) {
  const Icon = item.icon;
  const count = item.badgeCount ?? 0;
  return (
    <a
      className="nav-item"
      href={item.href}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate ? (e) => { onNavigate(item.key, e); } : undefined}
    >
      <Icon aria-hidden="true" />
      <span>{item.label}</span>
      {count > 0 ? (
        <span className="nav-count">
          <span aria-hidden="true">{count}</span>
          <span className="sr-only">{item.badgeLabel ? item.badgeLabel(count) : `${String(count)} items`}</span>
        </span>
      ) : null}
    </a>
  );
}

export interface SideNavProps {
  readonly items: readonly NavItemData[];
  readonly activeKey: string | null;
  readonly onNavigate?: (key: string, event: MouseEvent<HTMLAnchorElement>) => void;
}

export function SideNav({ items, activeKey, onNavigate }: SideNavProps) {
  return (
    <ul className="nav">
      {items.map((item) => (
        <li key={item.key}>
          <NavItem item={item} active={item.key === activeKey} {...(onNavigate ? { onNavigate } : {})} />
        </li>
      ))}
    </ul>
  );
}
