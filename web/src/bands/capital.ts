import type { BandScanRow } from "@core/index.js";

/**
 * What a band position actually ties up, and whether you can afford it.
 *
 * Filtering happens HERE, in the client, rather than as an `?capital=` parameter on
 * `/api/bands`. That is deliberate: any non-default parameter drops the request off the
 * single precomputed KV read onto a live D1 scan, so a capital filter served by the API
 * would cost every filtering visitor the fast path — to compute something the client
 * already has every input for. Filtering a few hundred rows in the browser is free and
 * instant.
 */

/**
 * Coins to run a full day of this band.
 *
 * `capitalPerUnit` is what one unit ties up; the constraint someone actually feels is a
 * day's worth of them, because the profit figure next to it is also per day. Comparing a
 * per-unit cost against a capital balance would call a 20M-coin book "affordable" on the
 * strength of buying one.
 */
export function capitalPerDay(row: BandScanRow): number {
  return row.economics.capitalPerUnit * row.economics.throughput.unitsPerDay;
}

/** `null` capital means no constraint, which is not the same as a constraint of 0. */
export function isAffordable(row: BandScanRow, capital: number | null): boolean {
  if (capital === null) return true;
  return capitalPerDay(row) <= capital;
}

export interface CapitalSplit {
  readonly affordable: readonly BandScanRow[];
  /** Counted, never silently dropped — the view says how many rows the filter is hiding
   *  and offers to clear it. A filter that removes 90% of the table without saying so is
   *  indistinguishable from having no data. */
  readonly hiddenCount: number;
}

export function splitByCapital(
  rows: readonly BandScanRow[],
  capital: number | null,
): CapitalSplit {
  if (capital === null) return { affordable: rows, hiddenCount: 0 };
  const affordable = rows.filter((row) => isAffordable(row, capital));
  return { affordable, hiddenCount: rows.length - affordable.length };
}
