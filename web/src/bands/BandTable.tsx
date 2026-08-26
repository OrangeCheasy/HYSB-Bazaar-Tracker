import { Link } from "react-router";
import type { BandHitRate, BandScanRow, WeeklyBand } from "@core/index.js";
import { formatCoins, formatPercentPoints } from "../format.js";
import { displayTag } from "../tagName.js";
import { DataTable, type Column } from "../ui/DataTable.js";
import { Flags } from "../ui/Flags.js";
import { columnList, pairedColumns } from "../ui/pairedColumns.js";
import { capitalPerDay } from "./capital.js";
import { nextSort, type Sort } from "./sort.js";

/**
 * The band table: column definitions over the shared DataTable.
 *
 * Every band column is declared through `pairedColumns`, so a band and its hit-rate are
 * emitted together or not at all (CLAUDE.md §7.6). The same applies to the spread and its
 * both-hit week count, which is this view's fill-feasibility figure — the profit is
 * conditional on TWO orders filling, not one.
 */

/** Below this an order at the band essentially never filled in the window. It drives
 *  emphasis, not filtering — a cold band is information, not an error. */
const COLD_RATE = 0.05;

/** The most weeks the 30-day retention cap can contain (ADR-021). */
const FULL_HISTORY_WEEKS = 4;

function hitRateColumn(side: "buy" | "sell"): Column<BandScanRow> {
  return {
    key: `${side}Fill`,
    label: "Fill",
    area: `${side}fill`,
    title: `Hours in the window that touched the ${side} band`,
    sortKey: side === "buy" ? "buyHitRate" : "sellHitRate",
    align: "right",
    cellClassName: (row) =>
      `num text-xs ${hitsOf(row, side).rate < COLD_RATE ? "text-outage" : "text-ink-dim"}`,
    render: (row) => {
      const hits = hitsOf(row, side);
      return (
        <span
          title={`${hits.hoursTouched} of ${hits.hoursTotal} hours touched this ${side} band`}
        >
          {Math.round(hits.rate * 100)}%
        </span>
      );
    },
  };
}

function hitsOf(row: BandScanRow, side: "buy" | "sell"): BandHitRate {
  return side === "buy" ? row.band.buyHits : row.band.sellHits;
}

function bandColumn(side: "buy" | "sell"): Column<BandScanRow> {
  return {
    key: side,
    label: side === "buy" ? "Buy" : "Sell",
    area: side,
    title:
      side === "buy"
        ? "Rest a buy order here — the trailing low band"
        : "Rest a sell offer here — the trailing high band",
    sortKey: side === "buy" ? "buyBand" : "sellBand",
    align: "right",
    cellClassName: "num text-ink text-left sm:text-right",
    render: (row) => (
      <>
        {/* The side is spelled out on mobile, where the column headers are gone. On
            desktop the header says it once for the whole column instead. */}
        <span className="mr-1 text-[11px] text-ink-faint sm:hidden">{side}</span>
        {formatCoins(side === "buy" ? row.band.buyBand : row.band.sellBand)}
      </>
    ),
  };
}

const SPREAD: Column<BandScanRow> = {
  key: "spread",
  label: "Spread",
  area: "spread",
  title: "Sell band over buy band, before tax",
  sortKey: "spreadPct",
  align: "right",
  cellClassName: "num text-ink",
  // Percentage POINTS at the source, not a fraction — see formatPercentPoints.
  render: (row) => formatPercentPoints(row.band.spreadPct),
};

const BOTH_HIT: Column<BandScanRow> = {
  key: "both",
  label: "Both",
  area: "both",
  title: "Weeks in which BOTH bands were touched",
  sortKey: "bothHitWeeks",
  align: "right",
  cellClassName: (row) =>
    `num text-xs ${row.band.bothHitWeeks === 0 ? "text-outage" : "text-ink-dim"}`,
  render: (row) => <BothHit band={row.band} />,
};

function BothHit({ band }: { readonly band: WeeklyBand }): React.JSX.Element {
  const never = band.bothHitWeeks === 0;
  return (
    <span
      title={
        never
          ? "Neither week saw both bands touched — this spread is a chart annotation, not a trade"
          : `Both bands were touched in ${band.bothHitWeeks} of ${band.weekCount} weeks`
      }
    >
      {band.bothHitWeeks}/{band.weekCount}
      {/* Inline, not a footnote: a "2/2 weeks" that looks perfect is resting on two weeks
          of data, and that has to be legible at the number itself. */}
      {band.weekCount < FULL_HISTORY_WEEKS && (
        <span className="ml-1 text-late">n={band.weekCount}w</span>
      )}
    </span>
  );
}

const COLUMNS = columnList<BandScanRow>([
  {
    key: "tag",
    label: "Tag",
    area: "tag",
    sortKey: "tag",
    align: "left",
    render: (row) => (
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
        {/* `short-history` is dropped, not because it is untrue but because the week count
            renders inline at the both-hit figure it qualifies. A chip repeating it on
            every row turns a signal into wallpaper. */}
        <Flags flags={row.band.flags.filter((flag) => flag !== "short-history")} />
      </span>
    ),
  },
  pairedColumns(bandColumn("buy"), hitRateColumn("buy")),
  pairedColumns(bandColumn("sell"), hitRateColumn("sell")),
  pairedColumns(SPREAD, BOTH_HIT),
  {
    key: "profit",
    label: "Profit/d",
    title: "Volume-adjusted, after tax. The ranking key.",
    sortKey: "profitPerDay",
    align: "right",
    hideOnMobile: true,
    cellClassName: "num text-ink",
    render: (row) => formatCoins(row.economics.profitPerDay),
  },
  {
    key: "capital",
    label: "Capital/d",
    title: "Coins tied up running a full day",
    sortKey: "capitalPerDay",
    align: "right",
    hideOnMobile: true,
    cellClassName: "num text-ink-dim",
    render: (row) => formatCoins(capitalPerDay(row)),
  },
]);

/**
 * Exactly two lines: identity plus the two headline figures on top, both bands with their
 * fill rates below. Profit and capital drop off — they are the sort keys, and the active
 * one is restated in the control bar. The bands, the fills and the both-hit count never
 * drop, because those are the figures the non-negotiables cover.
 */
const MOBILE_AREAS = `
  "tag tag both spread"
  "buy buyfill sell sellfill"
`;

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
    <DataTable
      rows={rows}
      columns={COLUMNS}
      sort={sort}
      onSortChange={(key) => onSortChange(nextSort(sort, key as Sort["key"]))}
      rowKey={(row) => row.tag}
      mobileAreas={MOBILE_AREAS}
    />
  );
}

export { COLUMNS as BAND_COLUMNS };
