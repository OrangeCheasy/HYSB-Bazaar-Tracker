/**
 * Filtering a table by the capital a user has available.
 *
 * Shared by the band table and the craft scan because the rule is the same in both: the
 * figure compared is a **full day's** capital, not one unit or one craft. The profit
 * figure beside it is per day, so anything else compares two different periods — and a
 * 20M-coin book would be called affordable on the strength of buying exactly one.
 *
 * Filtering happens in the client, not as an `?capital=` parameter. Any non-default
 * parameter drops `/api/scan` and `/api/bands` off their single precomputed KV read onto a
 * live D1 scan, so an API-side capital filter would cost every filtering visitor the fast
 * path to compute something the client already has every input for.
 */

export interface CapitalSplit<Row> {
  readonly affordable: readonly Row[];
  /** Counted, never silently dropped. A filter that removes 90% of a table without saying
   *  so is indistinguishable from having no data. */
  readonly hiddenCount: number;
}

/**
 * `capital === null` means no constraint, which is NOT the same as a constraint of zero —
 * the API draws the same distinction by the parameter's absence.
 *
 * A row whose capital requirement cannot be computed (an unscored scan row, a non-finite
 * figure) is kept rather than hidden: "we do not know what this costs" is not a reason to
 * remove it from view, and hiding it would make the filter look like it had found
 * something.
 */
export function splitByCapital<Row>(
  rows: readonly Row[],
  capital: number | null,
  capitalOf: (row: Row) => number | undefined,
): CapitalSplit<Row> {
  if (capital === null) return { affordable: rows, hiddenCount: 0 };

  const affordable = rows.filter((row) => {
    const required = capitalOf(row);
    if (required === undefined || !Number.isFinite(required)) return true;
    return required <= capital;
  });

  return { affordable, hiddenCount: rows.length - affordable.length };
}
