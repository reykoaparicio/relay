import type { ReactNode } from 'react';

export interface KeyValueItem {
  readonly term: ReactNode;
  readonly value: ReactNode;
  readonly mono?: boolean;
  /** Stable React key; defaults to the index. */
  readonly id?: string;
}

export function KeyValueList({ items, className }: { readonly items: readonly KeyValueItem[]; readonly className?: string }) {
  return (
    <dl className={className ? `kv ${className}` : 'kv'}>
      {items.map((item, i) => (
        <div key={item.id ?? String(i)} style={{ display: 'contents' }}>
          <dt>{item.term}</dt>
          <dd className={item.mono ? 'num' : undefined}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
