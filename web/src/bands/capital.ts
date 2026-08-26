import type { BandScanRow } from "@core/index.js";
import { splitByCapital as split, type CapitalSplit } from "../ui/capitalFilter.js";

/**
 * What a band position ties up. The filtering itself lives in `ui/capitalFilter.ts`,
 * shared with the craft scan — this file only says what "capital" means for a band row.
 */

/**
 * Coins to run a full day of this band.
 *
 * `capitalPerUnit` is what one unit ties up; the constraint someone actually feels is a
 * day's worth of them, because the profit figure next to it is also per day.
 */
export function capitalPerDay(row: BandScanRow): number {
  return row.economics.capitalPerUnit * row.economics.throughput.unitsPerDay;
}

/** `null` capital means no constraint, which is not the same as a constraint of 0. */
export function isAffordable(row: BandScanRow, capital: number | null): boolean {
  if (capital === null) return true;
  return capitalPerDay(row) <= capital;
}

export function splitByCapital(
  rows: readonly BandScanRow[],
  capital: number | null,
): CapitalSplit<BandScanRow> {
  return split(rows, capital, capitalPerDay);
}
