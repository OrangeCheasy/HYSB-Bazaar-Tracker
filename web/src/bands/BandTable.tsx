import { Link } from "react-router";
import type { BandScanRow } from "@core/index.js";
import { formatCoins } from "../format.js";
import { displayTag } from "../tagName.js";
import { Flags } from "../ui/Flags.js";
import { BandCells } from "./BandCell.js";
import { SpreadCells } from "./SpreadCell.js";
import { capitalPerDay } from "./capital.js";
import { nextSort, type Sort, type SortKey } from "./sort.js";

/**
 * The band table.
 *
 * One `<table>`, two layouts. At ≥640px it is an ordinary column grid: single-line rows,
 * every hit-rate lining up under its own header, ~20 rows on screen. Below 640px each row
 * becomes a two-line CSS grid — name and spread on the first line, both bands with their
 * fill rates on the second — which fits ~10 rows on a 375px phone against ~5 for a card
 * layout, with no horizontal scrolling and nothing hidden behind a tap.
 *
 * The ARIA roles are not decoration. Changing `display` on `<tr>`/`<td>` drops their
 * implicit table roles in every browser, so a screen reader would stop announcing this as
 * a table exactly at the width where it is hardest to read. The explicit roles put them
 * back.
 */

interface Column {
  readonly key: SortKey;
  readonly label: string;
  /** Wider than a label because the header is also the sort control. */
  readonly title?: string;
  readonly numeric: boolean;
}

/**
 * Column order matters: each band is immediately followed by its own fill rate, so
 * "adjacent" is literal at every width.
 */
const COLUMNS: readonly Column[] = [
  { key: "tag", label: "Tag", numeric: false },
  {
    key: "buyBand",
    label: "Buy",
    title: "Rest a buy order here — the trailing low band",
    numeric: true,
  },
  {
    key: "buyHitRate",
    label: "Fill",
    title: "Hours in the window that touched the buy band",
    numeric: true,
  },
  {
    key: "sellBand",
    label: "Sell",
    title: "Rest a sell offer here — the trailing high band",
    numeric: true,
  },
  {
    key: "sellHitRate",
    label: "Fill",
    title: "Hours in the window that touched the sell band",
    numeric: true,
  },
  {
    key: "spreadPct",
    label: "Spread",
    title: "Sell band over buy band, before tax",
    numeric: true,
  },
  {
    key: "bothHitWeeks",
    label: "Both",
    title: "Weeks in which BOTH bands were touched",
    numeric: true,
  },
  {
    key: "profitPerDay",
    label: "Profit/d",
    title: "Volume-adjusted, after tax. The ranking key.",
    numeric: true,
  },
  {
    key: "capitalPerDay",
    label: "Capital/d",
    title: "Coins tied up running a full day",
    numeric: true,
  },
];

/**
 * The mobile grid. Exactly two lines: identity plus the two headline figures on top, both
 * bands with their fill rates below. Flags ride inside the tag cell rather than claiming a
 * third row, which would cost every row ~20px whether or not it had any.
 *
 * Profit and capital drop off — they are the sort keys, and the active one is restated in
 * the control bar above the table. The bands, the fills and the both-hit count never drop,
 * because those are the figures the non-negotiables cover.
 */
const MOBILE_AREAS = `
  "tag tag both spread"
  "buy buyfill sell sellfill"
`;

function SortHeader({
  column,
  sort,
  onSort,
}: {
  readonly column: Column;
  readonly sort: Sort;
  readonly onSort: (key: SortKey) => void;
}): React.JSX.Element {
  const active = sort.key === column.key;
  return (
    <th
      scope="col"
      className={`px-2 py-1 font-medium ${column.numeric ? "text-right" : "text-left"}`}
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(column.key)}
        title={column.title}
        className={`inline-flex items-center gap-1 hover:text-ink ${
          active ? "text-ink" : "text-ink-faint"
        }`}
      >
        {column.label}
        {/* Reserve the caret's width on every header so the columns do not shift by a few
            pixels each time the sort moves. */}
        <span aria-hidden className={active ? "" : "opacity-0"}>
          {sort.direction === "asc" ? "▲" : "▼"}
        </span>
      </button>
    </th>
  );
}

function BandRow({ row }: { readonly row: BandScanRow }): React.JSX.Element {
  return (
    <tr
      role="row"
      className="grid border-b border-rule last:border-b-0 hover:bg-raised sm:table-row"
      style={{ gridTemplateAreas: MOBILE_AREAS, gridTemplateColumns: "repeat(4, 1fr)" }}
    >
      <td role="cell" className="px-2 py-1 text-left" style={{ gridArea: "tag" }}>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Link
            to={`/bands/${encodeURIComponent(row.tag)}`}
            // The raw tag is what you type into the bazaar search in game, so it stays
            // reachable even though the readable name is what gets scanned.
            title={row.tag}
            className="text-ink hover:underline"
          >
            {displayTag(row.tag)}
          </Link>
          {/* `short-history` is dropped here, not because it is untrue but because the
              week count renders inline at the both-hit figure it qualifies — which is
              where ROADMAP Phase 5 wants it. A chip saying the same thing a second time,
              on every row, turns a signal into wallpaper. */}
          <Flags flags={row.band.flags.filter((flag) => flag !== "short-history")} />
        </span>
      </td>

      <BandCells price={row.band.buyBand} hits={row.band.buyHits} side="buy" />
      <BandCells price={row.band.sellBand} hits={row.band.sellHits} side="sell" />
      <SpreadCells band={row.band} />

      <td
        role="cell"
        className="num hidden px-2 py-1 text-right text-ink sm:table-cell"
        style={{ gridArea: "profit" }}
      >
        {formatCoins(row.economics.profitPerDay)}
      </td>
      <td
        role="cell"
        className="num hidden px-2 py-1 text-right text-ink-dim sm:table-cell"
        style={{ gridArea: "capital" }}
      >
        {formatCoins(capitalPerDay(row))}
      </td>
    </tr>
  );
}

export function BandTable({
  rows,
  sort,
  onSortChange,
}: {
  readonly rows: readonly BandScanRow[];
  readonly sort: Sort;
  readonly onSortChange: (sort: Sort) => void;
}): React.JSX.Element {
  return (
    <table role="table" className="w-full border-collapse text-sm">
      {/* Hidden on mobile: with no column grid there is nothing for a header row to label,
          and the sort moves to the select in the control bar. */}
      <thead className="hidden border-b border-rule-strong text-xs text-ink-faint sm:table-header-group">
        <tr>
          {COLUMNS.map((column) => (
            <SortHeader
              key={`${column.key}-${column.label}`}
              column={column}
              sort={sort}
              onSort={(key) => onSortChange(nextSort(sort, key))}
            />
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <BandRow key={row.tag} row={row} />
        ))}
      </tbody>
    </table>
  );
}

export { COLUMNS as BAND_COLUMNS };
