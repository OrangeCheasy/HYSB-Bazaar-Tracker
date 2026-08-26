import type { ReactNode } from "react";

/**
 * The one table implementation.
 *
 * Both the band table and the craft scan are column definitions over this. That is not
 * only DRY: the layout below carries two properties the non-negotiables depend on, and
 * having a second implementation means a second place for either to quietly stop being
 * true.
 *
 * **One `<table>`, two layouts.** At ≥640px it is an ordinary column grid — single-line
 * rows, every companion figure lining up under its own header, ~20 rows on screen. Below
 * 640px each row becomes a two-line CSS grid laid out by `mobileAreas`, which fits ~10
 * rows on a 375px phone against ~5 for a card layout, with no horizontal scrolling and
 * nothing hidden behind a tap.
 *
 * **The ARIA roles are load-bearing.** Changing `display` on `<tr>`/`<td>` drops their
 * implicit table roles in every browser, so a screen reader would stop announcing this as
 * a table at exactly the width where it is hardest to read. The explicit roles put them
 * back.
 */

export interface Column<Row> {
  /** Stable identity for React keys and for matching the active sort. */
  readonly key: string;
  readonly label: string;
  /** Named area in `mobileAreas`. Omit for a column that does not survive the reflow. */
  readonly area?: string;
  /** Longer explanation on the header, which is also the sort control. */
  readonly title?: string;
  readonly align?: "left" | "right";
  /** Absent means the column is not sortable — a flags column, say. */
  readonly sortKey?: string;
  /** Dropped below 640px. A column with no `area` must set this. */
  readonly hideOnMobile?: boolean;
  readonly render: (row: Row) => ReactNode;
  /** Extra classes for the cell, on top of alignment and padding. */
  readonly cellClassName?: string | ((row: Row) => string);
}

export interface TableSort {
  readonly key: string;
  readonly direction: "asc" | "desc";
}

function cellClasses<Row>(column: Column<Row>, row: Row): string {
  const extra =
    typeof column.cellClassName === "function"
      ? column.cellClassName(row)
      : (column.cellClassName ?? "");
  const align = column.align === "left" ? "text-left" : "text-right";
  const mobile = column.hideOnMobile === true ? "hidden sm:table-cell" : "";
  return `min-w-0 px-2 py-1 ${align} ${mobile} ${extra}`.trim();
}

function SortHeader<Row>({
  column,
  sort,
  onSort,
}: {
  readonly column: Column<Row>;
  readonly sort: TableSort;
  readonly onSort: (key: string) => void;
}): React.JSX.Element {
  const sortKey = column.sortKey;
  const active = sortKey !== undefined && sort.key === sortKey;
  const align = column.align === "left" ? "text-left" : "text-right";

  return (
    <th
      scope="col"
      className={`px-2 py-1 font-medium ${align}`}
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      {sortKey === undefined ? (
        <span className="text-ink-faint">{column.label}</span>
      ) : (
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          title={column.title}
          className={`inline-flex items-center gap-1 hover:text-ink ${
            active ? "text-ink" : "text-ink-faint"
          }`}
        >
          {column.label}
          {/* The caret's width is reserved on every header so columns do not shift by a
              few pixels each time the sort moves. */}
          <span aria-hidden className={active ? "" : "opacity-0"}>
            {sort.direction === "asc" ? "▲" : "▼"}
          </span>
        </button>
      )}
    </th>
  );
}

export function DataTable<Row>({
  rows,
  columns,
  sort,
  onSortChange,
  rowKey,
  mobileAreas,
  mobileColumns = 4,
  rowClassName,
}: {
  readonly rows: readonly Row[];
  readonly columns: readonly Column<Row>[];
  readonly sort: TableSort;
  readonly onSortChange: (key: string) => void;
  readonly rowKey: (row: Row) => string;
  /** `grid-template-areas` for the sub-640px layout. Every column with an `area` must
   *  appear in it, or that cell is placed implicitly and the row grows a line. */
  readonly mobileAreas: string;
  readonly mobileColumns?: number;
  readonly rowClassName?: (row: Row) => string;
}): React.JSX.Element {
  return (
    /*
     * `block` below 640px, `table` above it.
     *
     * This is load-bearing, not tidying. A `<table>` sizes itself from its content, and
     * below 640px its rows are `display: grid` with `1fr` columns that size themselves from
     * the table — a circular constraint, which CSS resolves by falling back to max-content.
     * The result was a table wider than the viewport, scrolling the whole page sideways and
     * pushing the sell-side fill rate off-screen entirely. A rule that says a figure must be
     * adjacent and visible is not satisfied by being in the DOM 40px past the right edge.
     * Making the outer box `block` breaks the cycle, so `1fr` resolves against the viewport.
     */
    <table role="table" className="block w-full border-collapse text-sm sm:table">
      {/* Hidden on mobile: with no column grid there is nothing for a header row to label,
          and the sort moves to the select in the control bar. */}
      <thead className="hidden border-b border-rule-strong text-xs text-ink-faint sm:table-header-group">
        <tr>
          {columns.map((column) => (
            <SortHeader key={column.key} column={column} sort={sort} onSort={onSortChange} />
          ))}
        </tr>
      </thead>
      <tbody className="block sm:table-row-group">
        {rows.map((row) => (
          <tr
            key={rowKey(row)}
            role="row"
            className={`grid border-b border-rule last:border-b-0 hover:bg-raised sm:table-row ${
              rowClassName?.(row) ?? ""
            }`}
            style={{
              gridTemplateAreas: mobileAreas,
              gridTemplateColumns: `repeat(${mobileColumns}, 1fr)`,
            }}
          >
            {columns.map((column) => (
              <td
                key={column.key}
                role="cell"
                className={cellClasses(column, row)}
                style={column.area === undefined ? undefined : { gridArea: column.area }}
              >
                {column.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
