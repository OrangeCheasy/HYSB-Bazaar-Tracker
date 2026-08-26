/**
 * Why a craft has no analysis, in words a user can act on.
 *
 * `runScan` keeps unscored rows deliberately — "no data yet" is information — but the
 * reasons arrive as internal identifiers: `no-base-data`, `incomparable-windows`. Rendering
 * those straight into a table cell leaks a variable name to a reader and, on a phone, wraps
 * it across three lines. On a fresh database this is the majority of rows, so it is not a
 * rare edge worth being sloppy about.
 */

interface ErrorCopy {
  /** Fits one table cell. */
  readonly short: string;
  /** The explanation, for the cell's title and the detail page. */
  readonly detail: string;
}

const COPY: Readonly<Record<string, ErrorCopy>> = {
  "no-base-data": {
    short: "awaiting data",
    detail:
      "No price history has been collected for the base material yet. Nothing is wrong with the recipe — this row will start scoring once the material has been trading for a day.",
  },
  "no-product-data": {
    short: "awaiting data",
    detail:
      "No price history has been collected for the enchanted product yet. The base material has data, so this row will start scoring once the product has been trading for a day.",
  },
  "buying-beats-merging": {
    short: "buy, don't merge",
    detail:
      "Every merge route into this book costs more than simply buying the finished book. That is a real answer rather than a failure — there is just no craft here to price.",
  },
  "zero-price": {
    short: "no price",
    detail:
      "One side of this craft has a recorded price of zero, which means nothing is resting on that side of the book. There is no market to trade against.",
  },
  "zero-ratio": {
    short: "bad recipe",
    detail:
      "This recipe's ratio is zero or missing, so the craft cannot be priced at all. That is a data fault rather than a market condition.",
  },
  "incomparable-windows": {
    short: "mismatched history",
    detail:
      "The base and the product have price history covering different periods, so comparing them would produce a number with no meaning. This resolves itself once both have been collected over the same window.",
  },
  "insufficient-data": {
    short: "awaiting data",
    detail:
      "There is some history for this craft, but not yet enough hours to compute anything trustworthy from.",
  },
  "no-bars": {
    short: "awaiting data",
    detail: "No usable hourly rows exist for this craft in the window being looked at.",
  },
};

const FALLBACK: ErrorCopy = {
  short: "unavailable",
  detail: "This craft could not be analysed, and the reason given is not one we have copy for.",
};

/** Never swallows an unknown code — the raw value is appended so a new reason shows up as
 *  something findable rather than as a silently generic message. */
export function errorCopy(error: string | undefined): ErrorCopy {
  if (error === undefined) return FALLBACK;
  const known = COPY[error];
  if (known !== undefined) return known;
  return { short: FALLBACK.short, detail: `${FALLBACK.detail} (${error})` };
}
