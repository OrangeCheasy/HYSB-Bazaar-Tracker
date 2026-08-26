import { Link } from "react-router";
import type { ScanRow } from "@core/index.js";
import { formatCoins, formatPercent } from "../format.js";
import { displayTag } from "../tagName.js";
import { DataTable, type Column } from "../ui/DataTable.js";
import { columnList, pairedColumns } from "../ui/pairedColumns.js";
import { CraftFlags } from "./CraftFlags.js";
import {
  HEADLINE_SCENARIO,
  nextScanSort,
  productName,
  type ScanSort,
  type ScanSortKey,
} from "./rank.js";

/**
 * The craft scan: column definitions over the shared DataTable.
 *
 * The margin is declared through `pairedColumns` with its fill feasibility, so the two are
 * emitted together or not at all (CLAUDE.md §7.6). Both figures are read from the SAME
 * scenario — quoting a timed margin beside an orders fill rate would describe two
 * different trades.
 */

/** A fill feasibility below this means the trade essentially does not happen. */
const COLD_FEASIBILITY = 0.15;

/** Hours to accumulate one craft, past which "slow" is an understatement. */
const SLOW_HOURS = 14;

function headline(row: ScanRow) {
  return row.analysis?.scenarios[HEADLINE_SCENARIO];
}

/** Every unscored cell reads the same, so a row with no analysis is visibly a row with no
 *  analysis rather than one that happens to be worth zero. */
const NO_DATA = <span className="text-ink-faint">—</span>;

/**
 * The recipe, and the unverified marking.
 *
 * Every recipe ships unverified — all compaction rows and every anvil edge — so this
 * marking is on essentially every row at launch, which sets the design constraint: it has
 * to stay legible at 100% density without shouting. A dotted underline plus a superscript
 * marker reads as "qualified" at a glance and stays out of the way of the numbers, and the
 * control bar states the count outright so the scale of it is never a surprise.
 */
const RECIPE: Column<ScanRow> = {
  key: "product",
  label: "Craft",
  area: "name",
  sortKey: "product",
  align: "left",
  render: (row) => (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <Link
        to={`/craft/${encodeURIComponent(row.kind === "anvil" ? row.recipe.enchTag : row.recipe.baseTag)}`}
        title={
          row.recipe.verified
            ? row.recipe.enchTag
            : `${row.recipe.enchTag} — ratio unverified: ${row.recipe.ratio}:1 has not been confirmed against a crafting grid`
        }
        className={`text-ink hover:underline ${
          row.recipe.verified
            ? ""
            : "decoration-late/60 underline decoration-dotted underline-offset-4"
        }`}
      >
        {productName(row)}
        {!row.recipe.verified && (
          <sup className="ml-0.5 text-late" aria-label="unverified ratio">
            ?
          </sup>
        )}
      </Link>
      <span className="text-[11px] text-ink-faint">
        {/* The route, which for an anvil merge is the decision the solver made on your
            behalf: which rung it is cheapest to enter the chain at. */}
        {row.plan !== undefined && row.plan.entryTag !== row.plan.targetTag
          ? `${row.plan.entryUnits}x ${displayTag(row.plan.entryTag)}`
          : `${row.recipe.ratio}x ${displayTag(row.recipe.baseTag)}`}
      </span>
      {row.analysis !== undefined && <CraftFlags flags={row.analysis.flags} />}
    </span>
  ),
};

const KIND: Column<ScanRow> = {
  key: "kind",
  label: "Type",
  area: "type",
  title: "Compaction packs n base items into one; anvil merges two books into the next level",
  sortKey: "kind",
  align: "right",
  cellClassName: "text-xs text-ink-dim",
  render: (row) => row.kind,
};

const MARGIN: Column<ScanRow> = {
  key: "margin",
  label: "Margin",
  area: "margin",
  title: "Profit per craft over its cost, after tax, in the timed scenario",
  sortKey: "marginPct",
  align: "right",
  cellClassName: (row) => {
    const scenario = headline(row);
    if (scenario === undefined) return "num";
    return `num ${scenario.profitPerCraft >= 0 ? "text-profit" : "text-loss"}`;
  },
  render: (row) => {
    const scenario = headline(row);
    if (scenario === undefined) return NO_DATA;
    // A FRACTION here, unlike WeeklyBand.spreadPct which is already percentage points.
    // Same field name, different units, one file apart in core — see formatPercentPoints.
    return formatPercent(scenario.marginPct);
  },
};

const FILL: Column<ScanRow> = {
  key: "fill",
  label: "Fill",
  area: "fill",
  title:
    "How likely both sides of this trade are to fill, against the queue already ahead of you. A margin you cannot fill is not a margin.",
  sortKey: "fillFeasibility",
  align: "right",
  cellClassName: (row) => {
    const scenario = headline(row);
    if (scenario === undefined) return "num text-xs";
    return `num text-xs ${scenario.fillFeasibility < COLD_FEASIBILITY ? "text-outage" : "text-ink-dim"}`;
  },
  render: (row) => {
    const scenario = headline(row);
    if (scenario === undefined) return NO_DATA;
    return formatPercent(scenario.fillFeasibility, 0);
  },
};

const COLUMNS = columnList<ScanRow>([
  RECIPE,
  KIND,
  pairedColumns(MARGIN, FILL),
  {
    key: "profit",
    label: "Profit/d",
    area: "profit",
    title: "Volume-adjusted, after tax. The ranking key — never rank by margin.",
    sortKey: "profitPerDay",
    align: "right",
    cellClassName: (row) =>
      `num ${
        row.analysis === undefined
          ? ""
          : row.analysis.profitPerDay >= 0
            ? "text-profit"
            : "text-loss"
      }`,
    render: (row) =>
      row.analysis === undefined ? (
        // The reason takes the place of the number, so an unscored row explains itself
        // where the figure would have been rather than just being blank.
        <span className="text-xs text-ink-faint">{row.error ?? "no data"}</span>
      ) : (
        formatCoins(row.analysis.profitPerDay)
      ),
  },
  {
    key: "crafts",
    label: "Crafts/d",
    area: "crafts",
    title: "How many of these you could actually turn over in a day, after volume capture",
    sortKey: "craftsPerDay",
    align: "right",
    cellClassName: "num text-ink-dim",
    render: (row) =>
      row.analysis === undefined ? NO_DATA : formatCoins(row.analysis.throughput.craftsPerDay),
  },
  {
    key: "hours",
    label: "Fill 1x",
    title:
      "Hours of base-material flow needed to accumulate a single craft. For anvil merges this is the headline constraint, not a footnote.",
    sortKey: "hoursToFillOneCraft",
    align: "right",
    hideOnMobile: true,
    cellClassName: (row) => {
      const hours = row.analysis?.throughput.hoursToFillOneCraft;
      return `num text-xs ${hours !== undefined && hours > SLOW_HOURS ? "text-late" : "text-ink-dim"}`;
    },
    render: (row) => {
      const hours = row.analysis?.throughput.hoursToFillOneCraft;
      if (hours === undefined) return NO_DATA;
      if (!Number.isFinite(hours)) return <span title="No base flow at all">never</span>;
      // A high-volume material fills a craft in seconds, and rendering that as "0.00h"
      // reads as no time rather than as no wait. Below an hour, switch units.
      if (hours >= 1) return `${hours.toFixed(1)}h`;
      const minutes = hours * 60;
      return minutes >= 1 ? `${Math.round(minutes)}m` : "<1m";
    },
  },
  {
    key: "capital",
    label: "Capital/d",
    title: "Coins tied up running a full day of these crafts",
    sortKey: "capitalRequired",
    align: "right",
    hideOnMobile: true,
    cellClassName: "num text-ink-dim",
    render: (row) =>
      row.analysis === undefined ? NO_DATA : formatCoins(row.analysis.capitalRequired),
  },
]);

/**
 * Two lines. The margin and its fill sit side by side on the second, so "adjacent" is as
 * literal on a phone as it is on a desktop. `Fill 1x` and capital drop off; profit and
 * crafts/day stay because they are what the ranking means.
 */
const MOBILE_AREAS = `
  "name name name type"
  "margin fill profit crafts"
`;

export function ScanTable({
  rows,
  sort,
  onSortChange,
}: {
  readonly rows: readonly ScanRow[];
  readonly sort: ScanSort;
  readonly onSortChange: (sort: ScanSort) => void;
}): React.JSX.Element {
  return (
    <DataTable
      rows={rows}
      columns={COLUMNS}
      sort={sort}
      onSortChange={(key) => onSortChange(nextScanSort(sort, key as ScanSortKey))}
      // Recipes are unique per (base, product) pair, and a base can chain into more than
      // one product — so neither tag alone is a key.
      rowKey={(row) => `${row.recipe.baseTag}->${row.recipe.enchTag}`}
      mobileAreas={MOBILE_AREAS}
      rowClassName={(row) => (row.analysis === undefined ? "opacity-60" : "")}
    />
  );
}

export { COLUMNS as SCAN_COLUMNS };
