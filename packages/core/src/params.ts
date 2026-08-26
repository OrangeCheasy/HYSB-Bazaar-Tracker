/**
 * The query-parameter contract, in one place.
 *
 * `/api/scan`, `/api/craft/:baseTag`, `/api/bands` and `/api/bands/:tag` reject an
 * out-of-range parameter with a 400 rather than clamping it or silently substituting a
 * default (ADR-019) — `?tax=1.25` meaning "1.25%" is 100x too big and, clamped, would
 * render every craft as a catastrophic loss with no error shown.
 *
 * That rule only works if the settings UI cannot produce a value the API refuses. So the
 * ranges live here, in core, where both the Worker's parsers and the web app's settings
 * validation read the SAME table. A second hand-written copy in `web/` would drift the
 * day someone widens a bound on one side only.
 *
 * Deliberately takes `string | null` rather than a `URL`: `URL`/`URLSearchParams` are
 * platform globals, and core does not get to reach for those (CLAUDE.md section 4). The
 * caller does the `searchParams.get()`.
 */

import {
  DEFAULT_HIGH_PERCENTILE,
  DEFAULT_LOW_PERCENTILE,
  DEFAULT_WINDOW_DAYS,
} from "./bands.js";

export interface ParamRange {
  readonly min: number;
  readonly max: number;
  /** Completes the sentence "must be ..." in both error messages below. */
  readonly hint: string;
}

/**
 * Ranges are deliberately wider than reality — real sell tax tops out near 2.25% under
 * Mayor Aura — because the job here is to catch inputs that are wrong by a FACTOR, not to
 * second-guess a user modelling something unusual.
 */
export const SCAN_PARAM_RANGES = {
  // The percent-vs-fraction trap, and the reason this table exists at all.
  tax: { min: 0, max: 0.5, hint: "a fraction, so 1.25% is 0.0125" },
  capture: { min: 0, max: 1, hint: "a fraction of market volume between 0 and 1" },
  tick: { min: 0.000001, max: 1_000_000, hint: "a positive price step in coins" },
  sleepStart: { min: 0, max: 23, hint: "an hour of the day, 0-23 UTC" },
  sleepEnd: { min: 0, max: 23, hint: "an hour of the day, 0-23 UTC" },
  window: { min: 1, max: 24, hint: "a sell-window length in hours, 1-24" },
  capital: { min: 0, max: Number.MAX_SAFE_INTEGER, hint: "a non-negative coin amount" },
} as const satisfies Readonly<Record<string, ParamRange>>;

export const BAND_PARAM_RANGES = {
  days: { min: 1, max: 30, hint: "a trailing window in days, 1-30" },
  pLow: { min: 0, max: 1, hint: "a percentile as a fraction, so p10 is 0.1" },
  pHigh: { min: 0, max: 1, hint: "a percentile as a fraction, so p90 is 0.9" },
} as const satisfies Readonly<Record<string, ParamRange>>;

export type ScanParamName = keyof typeof SCAN_PARAM_RANGES;
export type BandParamName = keyof typeof BAND_PARAM_RANGES;

/**
 * The default every scan parameter falls back to when absent. Single-sourced here so the
 * Worker's `DEFAULT_MARKET` and the web app's settings defaults cannot disagree about
 * what "unset" means — which matters because `/api/scan` forks to a KV read only when
 * every parameter is exactly the default.
 *
 * `capital` is absent on purpose: no capital constraint is a different scan from one
 * constrained to 0 coins, so its "default" is the sentinel `undefined`, not a number.
 */
export const DEFAULT_SCAN_QUERY = {
  tax: 0.0125,
  capture: 0.2,
  /**
   * The bazaar's minimum price increment, measured rather than assumed.
   *
   * Across every product's live order book the smallest gap between adjacent resting
   * orders is exactly 0.1, and cheap items sit on 0.1 boundaries throughout — COAL's top
   * buy orders read 9.5, 9.8, 10, 10.1, 10.2. So 0.1 is what undercutting actually costs.
   *
   * This was 1, and on a cheap material that is not a rounding difference: stepping a
   * 5.31-coin bid by a whole coin inflated the cost of a 160x craft by **18.8%**, which is
   * larger than the entire margin on most crafts and made COAL-to-ENCHANTED_COAL look far
   * worse than it is. The error grew as the base got cheaper — precisely the items where
   * compaction is worth doing.
   *
   * Still one global step rather than a per-item one, which remains a simplification: real
   * traders undercut a 20M book by more than 0.1. But it is now a floor that is true
   * everywhere instead of a guess that is wrong at the bottom of the market.
   */
  tick: 0.1,
  sleepStart: 23,
  sleepEnd: 7,
  window: 8,
} as const satisfies Readonly<Record<Exclude<ScanParamName, "capital">, number>>;

export const DEFAULT_BAND_QUERY = {
  days: DEFAULT_WINDOW_DAYS,
  pLow: DEFAULT_LOW_PERCENTILE,
  pHigh: DEFAULT_HIGH_PERCENTILE,
} as const satisfies Readonly<Record<BandParamName, number>>;

export type ParamCheck =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string };

/**
 * Validate one raw parameter against its range.
 *
 * `raw === null` (or empty) means "not supplied" and yields `fallback` — absent is not an
 * error. Anything supplied and unusable is an error naming the offending parameter, never
 * a clamp: a scan is a number someone may act on with real coins (CLAUDE.md section 7.6),
 * and quietly answering a different question than the one asked produces a
 * plausible-looking answer nobody requested.
 */
export function checkParam(
  name: string,
  range: ParamRange,
  raw: string | null,
  fallback: number,
): ParamCheck {
  if (raw === null || raw === "") return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { ok: false, message: `'${name}' must be a number (${range.hint}); got '${raw}'` };
  }
  if (value < range.min || value > range.max) {
    return {
      ok: false,
      message: `'${name}' must be between ${range.min} and ${range.max} — ${range.hint}; got ${value}`,
    };
  }
  return { ok: true, value };
}

/**
 * The in-range check on a value that is already a number — what a settings form needs,
 * where there is no string to parse and no "absent" case. Same bounds, same message.
 */
export function checkParamValue(name: string, range: ParamRange, value: number): ParamCheck {
  return checkParam(name, range, String(value), value);
}
