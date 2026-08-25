import { err, ok, type Result } from "./result.js";
import type { Bar } from "./sides.js";

/**
 * Price statistics over a normalized series.
 *
 * Consumes `Bar[]` and nothing else. It does not know or care whether the bars came from
 * Hypixel's cron, a Coflnet backfill, or a D1 rollup — that is the whole point of the
 * seam in sides.ts.
 */

export interface Stats {
  readonly n: number;
  /** UTC epoch seconds of the first and last bar. */
  readonly from: number;
  readonly to: number;
  /** Nominal bar width, taken from the series. Needed to compare two series honestly. */
  readonly intervalSeconds: number;
  /** Bars present divided by bars expected across the span. 1 means no gaps. */
  readonly coverage: number;

  readonly askMean: number;
  readonly bidMean: number;
  readonly midMean: number;

  /** Mean of the per-bar lows/highs — the TYPICAL low, not the worst one. */
  readonly askAvgLow: number;
  readonly askAvgHigh: number;
  readonly bidAvgLow: number;
  readonly bidAvgHigh: number;

  /** Absolute extremes across the whole span — the WORST it got. */
  readonly askFloor: number;
  readonly askCeiling: number;
  readonly bidFloor: number;
  readonly bidCeiling: number;

  /** Mean absolute spread, in coins. */
  readonly spreadMean: number;
  /** `(askMean - bidMean) / askMean`. Unitless; the display layer multiplies by 100. */
  readonly spreadPct: number;
  /**
   * Population stdev of ask over mean ask. Unitless.
   *
   * Measured on the ask rather than the mid: the ask is what you pay to instant-buy and
   * what your own sell offer competes against, so it is the side your plan is exposed to.
   */
  readonly volatility: number;

  /**
   * Current book state, taken from the LAST bar rather than averaged.
   *
   * Averaging these would lag. `askDepth` is a queue that exists right now, and the
   * moving-week counters are already rolling seven-day totals — the newest reading is the
   * best estimate of current flow, while a mean across bars averages stale windows.
   */
  readonly lastAsk: number;
  readonly lastBid: number;
  readonly lastAskDepth: number;
  readonly lastBidDepth: number;

  /** Flow rates from the newest trailing-week counters. */
  readonly ibPerHour: number;
  readonly isPerHour: number;
  readonly ibPerDay: number;
  readonly isPerDay: number;
}

/** The upstream moving-week counters are seven-day rolling totals. */
const HOURS_PER_WEEK = 168;
const DAYS_PER_WEEK = 7;

export type StatsError = "empty-series" | "zero-mean-price";

export function mid(b: Bar): number {
  return (b.askAvg + b.bidAvg) / 2;
}

export function spread(b: Bar): number {
  return b.askAvg - b.bidAvg;
}

export function spreadPct(b: Bar): number {
  const m = mid(b);
  return m === 0 ? 0 : spread(b) / m;
}

export function mean(xs: readonly number[]): number | undefined {
  if (xs.length === 0) return undefined;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Population standard deviation. Zero for a single value, rather than undefined or NaN. */
export function stdev(xs: readonly number[]): number | undefined {
  const m = mean(xs);
  if (m === undefined) return undefined;
  let acc = 0;
  for (const x of xs) acc += (x - m) * (x - m);
  return Math.sqrt(acc / xs.length);
}

/** Linear-interpolated percentile, `q` in [0, 1]. Does not mutate the input. */
export function percentile(xs: readonly number[], q: number): number | undefined {
  if (xs.length === 0) return undefined;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = Math.min(Math.max(q, 0), 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo];
  const b = sorted[hi];
  if (a === undefined || b === undefined) return undefined;
  return a + (b - a) * (pos - lo);
}

/** Bars whose start falls in the inclusive range. */
export function sliceWindow(
  bars: readonly Bar[],
  fromTs: number,
  toTs: number,
): readonly Bar[] {
  return bars.filter((b) => b.ts >= fromTs && b.ts <= toTs);
}

/**
 * Accumulated in a single pass rather than as fifteen separate `map` + `mean` calls over
 * the same array. Two reasons beyond the obvious allocation churn:
 *
 *  - `Math.min(...bars.map(f))` spreads every element onto the call stack. Harmless at
 *    2,000 bars, a crash waiting for whoever widens the retention window.
 *  - Each `mean(...) ?? 0` was an unreachable fallback that existed only to satisfy the
 *    type checker, so the code carried branches no test could ever cover.
 */
export function computeStats(bars: readonly Bar[]): Result<Stats, StatsError> {
  const n = bars.length;
  if (n === 0) return err("empty-series");

  const sorted = [...bars].sort((a, b) => a.ts - b.ts);

  let askSum = 0;
  let bidSum = 0;
  let midSum = 0;
  let askLowSum = 0;
  let askHighSum = 0;
  let bidLowSum = 0;
  let bidHighSum = 0;
  let spreadSum = 0;

  // Book state. The series is sorted ascending, so the final iteration wins — assigning
  // unconditionally avoids indexing a possibly-empty array to find the last element.
  let lastAsk = 0;
  let lastBid = 0;
  let lastAskDepth = 0;
  let lastBidDepth = 0;
  let lastIbWeek = 0;
  let lastIsWeek = 0;

  let askFloor = Number.POSITIVE_INFINITY;
  let askCeiling = Number.NEGATIVE_INFINITY;
  let bidFloor = Number.POSITIVE_INFINITY;
  let bidCeiling = Number.NEGATIVE_INFINITY;

  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  let intervalSeconds = 0;

  const asks: number[] = [];

  for (const b of sorted) {
    asks.push(b.askAvg);
    midSum += mid(b);

    askSum += b.askAvg;
    bidSum += b.bidAvg;
    askLowSum += b.askMin;
    askHighSum += b.askMax;
    bidLowSum += b.bidMin;
    bidHighSum += b.bidMax;
    spreadSum += spread(b);

    lastAsk = b.askAvg;
    lastBid = b.bidAvg;
    lastAskDepth = b.askDepth;
    lastBidDepth = b.bidDepth;
    lastIbWeek = b.ibWeek;
    lastIsWeek = b.isWeek;

    if (b.askMin < askFloor) askFloor = b.askMin;
    if (b.askMax > askCeiling) askCeiling = b.askMax;
    if (b.bidMin < bidFloor) bidFloor = b.bidMin;
    if (b.bidMax > bidCeiling) bidCeiling = b.bidMax;

    // The series is sorted, so the first iteration sets both bounds and the nominal
    // interval in one go — no indexing into a possibly-empty array to find them.
    if (b.ts < from) {
      from = b.ts;
      intervalSeconds = b.intervalSeconds;
    }
    if (b.ts > to) to = b.ts;
  }

  const midMean = midSum / n;
  if (midMean === 0) return err("zero-mean-price");

  const askMean = askSum / n;
  const bidMean = bidSum / n;

  // Second pass for variance rather than a sum-of-squares shortcut: prices reach eight
  // figures at 160x multipliers, where the shortcut loses precision to cancellation.
  let varianceAcc = 0;
  for (const a of asks) varianceAcc += (a - askMean) * (a - askMean);

  // A single bar covers its own slot fully. Denser-than-nominal series clamp to 1 rather
  // than reporting coverage above 100%, which would be meaningless.
  const expected = intervalSeconds > 0 ? Math.floor((to - from) / intervalSeconds) + 1 : n;
  const coverage = Math.min(1, n / expected);

  return ok({
    n,
    from,
    to,
    intervalSeconds,
    coverage,

    askMean,
    bidMean,
    midMean,

    askAvgLow: askLowSum / n,
    askAvgHigh: askHighSum / n,
    bidAvgLow: bidLowSum / n,
    bidAvgHigh: bidHighSum / n,

    askFloor,
    askCeiling,
    bidFloor,
    bidCeiling,

    spreadMean: spreadSum / n,
    spreadPct: askMean === 0 ? 0 : (askMean - bidMean) / askMean,
    volatility: askMean === 0 ? 0 : Math.sqrt(varianceAcc / n) / askMean,

    lastAsk,
    lastBid,
    lastAskDepth,
    lastBidDepth,

    ibPerHour: lastIbWeek / HOURS_PER_WEEK,
    isPerHour: lastIsWeek / HOURS_PER_WEEK,
    ibPerDay: lastIbWeek / DAYS_PER_WEEK,
    isPerDay: lastIsWeek / DAYS_PER_WEEK,
  });
}
