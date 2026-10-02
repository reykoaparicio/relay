import { useId } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { cx } from './cx';
import { TableScroll } from './TableScroll';

export interface DataTableColumn<T> {
  readonly key: string;
  readonly header: ReactNode;
  readonly cell: (row: T) => ReactNode;
  /** Right-aligned tabular digits (money, tokens, durations). Numeric cells never wrap. */
  readonly numeric?: boolean;
  /** Keep the cell on one line (short labels, ids, times). Default: true for numeric columns, else false. */
  readonly nowrap?: boolean;
  /**
   * Narrowest the column may shrink to (a CSS length, e.g. `'14rem'`) when the table is squeezed. Give long text
   * columns one so they wrap into a readable measure instead of a word per line.
   */
  readonly minWidth?: string;
}

function cellClass<T>(c: DataTableColumn<T>): string | undefined {
  const cls = cx(c.numeric === true && 'num', (c.nowrap ?? c.numeric === true) && 'nowrap');
  return cls === '' ? undefined : cls;
}

export interface DataTableProps<T> {
  /** Accessible table name (rendered as a visually hidden caption unless `showCaption`). */
  readonly caption: ReactNode;
  readonly showCaption?: boolean;
  readonly columns: ReadonlyArray<DataTableColumn<T>>;
  readonly rows: readonly T[];
  readonly getRowKey: (row: T) => string;
  /**
   * Makes rows activatable: the first cell renders a real link (`getRowHref`) or button
   * (`onRowActivate`), so rows are keyboard reachable, never a clickable `<tr>` only (09 I3).
   */
  readonly onRowActivate?: (row: T) => void;
  readonly getRowHref?: (row: T) => string;
  /** Accessible name for the row control; defaults to the first cell's text content. */
  readonly getRowLabel?: (row: T) => string;
  readonly emptyState?: ReactNode;
}

function FirstCell<T>({ row, content, props }: { readonly row: T; readonly content: ReactNode; readonly props: DataTableProps<T> }) {
  const label = props.getRowLabel?.(row);
  if (props.getRowHref) {
    return (
      <a className="row-link" href={props.getRowHref(row)} aria-label={label}>
        {content}
      </a>
    );
  }
  const activate = props.onRowActivate;
  if (activate) {
    return (
      <button type="button" className="row-link" aria-label={label} onClick={() => { activate(row); }}>
        {content}
      </button>
    );
  }
  return <>{content}</>;
}

export function DataTable<T>(props: DataTableProps<T>) {
  const { caption, showCaption = false, columns, rows, getRowKey, emptyState } = props;
  const captionId = useId();
  if (rows.length === 0 && emptyState !== undefined) return <>{emptyState}</>;
  const isActivatable = props.onRowActivate !== undefined || props.getRowHref !== undefined;
  return (
    <TableScroll labelledBy={captionId}>
      <table className="table">
        <caption id={captionId} className={showCaption ? 'subtle' : 'sr-only'}>
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const style: CSSProperties | undefined = c.minWidth === undefined ? undefined : { minWidth: c.minWidth };
              return (
                <th key={c.key} scope="col" className={c.numeric ? 'num' : undefined} style={style}>
                  {c.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowKey(row)} className={cx(isActivatable && 'activatable')}>
              {columns.map((c, i) =>
                i === 0 ? (
                  <th key={c.key} scope="row" className={cellClass(c)}>
                    <FirstCell row={row} content={c.cell(row)} props={props} />
                  </th>
                ) : (
                  <td key={c.key} className={cellClass(c)}>
                    {c.cell(row)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
