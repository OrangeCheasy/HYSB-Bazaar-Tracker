import type { BandScanRow } from "@core/index.js";
import { capitalPerDay } from "./capital.js";
import { displayTag } from "../tagName.js";

/**
 * Sorting the band table.
 *
 * Pure and separate from the component so the comparators can be tested directly — a
 * table that silently sorts by the wrong key is the kind of bug that survives a visual
 * review, because every row still looks plausible.
 */

export type SortKey =
  | "profitPerDay"
  | "spreadPct"
  | "buyBand"
  | "sellBand"
  | "buyHitRate"
  | "sellHitRate"
  | "bothHitWeeks"
  | "capitalPerDay"
  | "tag";

export type SortDirection = "asc" | "desc";

export interface Sort {
  readonly key: SortKey;
  readonly direction: SortDirection;
}

/**
 * Profit per day, descending. CLAUDE.md section 8 is explicit: rank by profit-per-day,
 * never by margin. A 40% spread on a tag that trades twice a week is not a better trade
 * than a 3% spread on coal, and sorting by margin puts the dead item on top.
 */
export const DEFAULT_SORT: Sort = { key: "profitPerDay", direction: "desc" };

/** Which direction a column starts in when you first click it. Money and rates start
 *  descending because "the biggest" is the question being asked; the tag starts
 *  ascending because that is alphabetical order. */
const INITIAL_DIRECTION: Readonly<Record<SortKey, SortDirection>> = {
  profitPerDay: "desc",
  spreadPct: "desc",
  buyBand: "desc",
  sellBand: "desc",
  buyHitRate: "desc",
  sellHitRate: "desc",
  bothHitWeeks: "desc",
  capitalPerDay: "asc",
  tag: "asc",
};

/** Clicking a column header: a new column starts in its natural direction, the current
 *  column flips. */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key !== key) return { key, direction: INITIAL_DIRECTION[key] };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

/** Choosing from the mobile sort menu: pick the column, never flip. The direction has its
 *  own control there, and a menu that silently reversed itself when you re-picked the
 *  option already selected would be a trap. */
export function sortByKey(current: Sort, key: SortKey): Sort {
  if (current.key === key) return current;
  return { key, direction: INITIAL_DIRECTION[key] };
}

function valueOf(row: BandScanRow, key: SortKey): number | string {
  switch (key) {
    case "profitPerDay":
      return row.economics.profitPerDay;
    case "spreadPct":
      return row.band.spreadPct;
    case "buyBand":
      return row.band.buyBand;
    case "sellBand":
      return row.band.sellBand;
    case "buyHitRate":
      return row.band.buyHits.rate;
    case "sellHitRate":
      return row.band.sellHits.rate;
    case "bothHitWeeks":
      return row.band.bothHitWeeks;
    case "capitalPerDay":
      return capitalPerDay(row);
    case "tag":
      // Sorted by what is on screen, not by the raw tag: a user looking at "Ultimate Wise
      // 5" should not have to know it sorts under E for ENCHANTMENT_.
      return displayTag(row.tag);
  }
}

export function sortRows(rows: readonly BandScanRow[], sort: Sort): readonly BandScanRow[] {
  const factor = sort.direction === "asc" ? 1 : -1;
  // Copy: the fetched array is shared state and Array.prototype.sort mutates in place.
  return [...rows].sort((a, b) => {
    const left = valueOf(a, sort.key);
    const right = valueOf(b, sort.key);

    let comparison: number;
    if (typeof left === "string" || typeof right === "string") {
      comparison = String(left).localeCompare(String(right));
    } else if (!Number.isFinite(left) || !Number.isFinite(right)) {
      // A non-finite economics figure (a zero-volume tag divides by zero somewhere) sorts
      // last in EITHER direction rather than floating to the top of an ascending sort,
      // where it would look like the cheapest thing on the board.
      comparison = Number.isFinite(left)
        ? -1 * factor
        : Number.isFinite(right)
          ? 1 * factor
          : 0;
    } else {
      comparison = left - right;
    }

    // Tag as the tiebreak so the order is total: without it, two rows with equal profit
    // swap places between renders and the table appears to shuffle on its own.
    if (comparison === 0 && sort.key !== "tag") {
      return displayTag(a.tag).localeCompare(displayTag(b.tag));
    }
    return comparison * factor;
  });
}
