import type { ScanRow, WarningFlag } from "@core/index.js";
import { displayTag } from "../tagName.js";

/**
 * Ordering the craft scan.
 *
 * Three tiers, in this order, and the tiering runs BEFORE the sort key rather than as part
 * of it:
 *
 *   1. Scored rows with no suspicious flag.
 *   2. Scored rows carrying a suspicious flag.
 *   3. Rows with no analysis at all.
 *
 * **Why demote rather than filter or merely mark.** 59% of scored rows currently carry
 * `implausible-margin`. CLAUDE.md §8 is blunt about what such a number means — "the recipe
 * is wrong, the item is dead, or someone is walling it" — so leaving them interleaved puts
 * a row that cannot be traded at the top of a table whose entire job is answering "what
 * should I set up tonight". Filtering them out instead would hide the evidence; a user who
 * wonders why a famous craft is missing deserves to find it, flagged, further down. So
 * they sink, keeping their relative order, and keep their marks.
 *
 * Within a tier, the sort key applies normally.
 */

/**
 * Flags that mean "this number is probably not real", as opposed to flags that qualify a
 * real number.
 *
 * `unverified-recipe` is deliberately NOT here. Every recipe ships unverified — all 43
 * compaction rows and every anvil edge — so demoting on it would demote the entire table
 * and order nothing. It is marked on the row instead, which is what the rule actually
 * asks for.
 */
const SUSPICIOUS_FLAGS: readonly WarningFlag[] = [
  // A margin past 50% on a 1-5% market. The single strongest signal that a row is wrong.
  "implausible-margin",
  // The product sells below what its inputs cost at ratio — arithmetic that should not
  // survive contact with a real market.
  "below-ratio-parity",
  // One side of the book is empty, so a "price" here is one quote, not a market.
  "single-sided-book",
];

export function isSuspicious(row: ScanRow): boolean {
  const flags = row.analysis?.flags;
  if (flags === undefined) return false;
  return flags.some((flag) => SUSPICIOUS_FLAGS.includes(flag));
}

/** 0 = clean and scored, 1 = scored but suspect, 2 = no analysis. */
export function tierOf(row: ScanRow): number {
  if (row.analysis === undefined) return 2;
  return isSuspicious(row) ? 1 : 0;
}

export type ScanSortKey =
  | "profitPerDay"
  | "marginPct"
  | "fillFeasibility"
  | "craftsPerDay"
  | "hoursToFillOneCraft"
  | "capitalRequired"
  | "kind"
  | "product";

export interface ScanSort {
  readonly key: ScanSortKey;
  readonly direction: "asc" | "desc";
}

/** Profit per day, descending. CLAUDE.md §8: rank by profit-per-day, never by margin. */
export const DEFAULT_SCAN_SORT: ScanSort = { key: "profitPerDay", direction: "desc" };

const INITIAL_DIRECTION: Readonly<Record<ScanSortKey, ScanSort["direction"]>> = {
  profitPerDay: "desc",
  marginPct: "desc",
  fillFeasibility: "desc",
  craftsPerDay: "desc",
  // Fewer hours to fill one craft is better, so this one starts ascending.
  hoursToFillOneCraft: "asc",
  capitalRequired: "asc",
  kind: "asc",
  product: "asc",
};

export function nextScanSort(current: ScanSort, key: ScanSortKey): ScanSort {
  if (current.key !== key) return { key, direction: INITIAL_DIRECTION[key] };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

/** The mobile menu picks a column and never flips it — direction has its own control. */
export function scanSortByKey(current: ScanSort, key: ScanSortKey): ScanSort {
  if (current.key === key) return current;
  return { key, direction: INITIAL_DIRECTION[key] };
}

/** The scenario every headline figure is read from. `profitPerDay` is derived from it, so
 *  the margin shown beside the profit has to come from the same scenario or the row is
 *  quoting two different trades. */
export const HEADLINE_SCENARIO = "timed" as const;

export function productName(row: ScanRow): string {
  return displayTag(row.recipe.enchTag);
}

function valueOf(row: ScanRow, key: ScanSortKey): number | string {
  const analysis = row.analysis;
  const scenario = analysis?.scenarios[HEADLINE_SCENARIO];

  switch (key) {
    case "profitPerDay":
      return analysis?.profitPerDay ?? Number.NaN;
    case "marginPct":
      return scenario?.marginPct ?? Number.NaN;
    case "fillFeasibility":
      return scenario?.fillFeasibility ?? Number.NaN;
    case "craftsPerDay":
      return analysis?.throughput.craftsPerDay ?? Number.NaN;
    case "hoursToFillOneCraft":
      return analysis?.throughput.hoursToFillOneCraft ?? Number.NaN;
    case "capitalRequired":
      return analysis?.capitalRequired ?? Number.NaN;
    case "kind":
      return row.kind;
    case "product":
      return productName(row);
  }
}

export function sortScanRows(rows: readonly ScanRow[], sort: ScanSort): readonly ScanRow[] {
  const factor = sort.direction === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    // Tier first, and never inverted by the direction: flipping a sort must not float
    // unscored rows to the top of the table.
    const tierDiff = tierOf(a) - tierOf(b);
    if (tierDiff !== 0) return tierDiff;

    const left = valueOf(a, sort.key);
    const right = valueOf(b, sort.key);

    let comparison: number;
    if (typeof left === "string" || typeof right === "string") {
      comparison = String(left).localeCompare(String(right));
    } else if (!Number.isFinite(left) || !Number.isFinite(right)) {
      // A non-finite figure sinks in EITHER direction rather than heading an ascending
      // sort. `hoursToFillOneCraft` is Infinity when nothing flows, and "never fills"
      // must not read as "fills fastest".
      comparison = Number.isFinite(left)
        ? -1 * factor
        : Number.isFinite(right)
          ? 1 * factor
          : 0;
    } else {
      comparison = left - right;
    }

    // Total order, so rows do not swap places between renders.
    if (comparison === 0 && sort.key !== "product") {
      return productName(a).localeCompare(productName(b));
    }
    return comparison * factor;
  });
}

/** Coins to run a full day of this craft. Undefined for an unscored row — the capital
 *  filter keeps those rather than guessing. */
export function capitalRequired(row: ScanRow): number | undefined {
  return row.analysis?.capitalRequired;
}
