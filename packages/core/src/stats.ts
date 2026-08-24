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

  readonly spreadMean: number;
  readonly spreadPctMean: number;
  /** Population stdev of mid divided by mean mid. Unitless, so items are comparable. */
  readonly volatility: number;

  /**
   * Flow rates, units per day.
   *
   * Derived as `mean(trailing-week counter) / 7`. This is an ESTIMATE, not a measurement:
   * the upstream counters are rolling weekly totals, so averaging them across bars is
   * smoothed by construction. It is the denominator of every throughput cap, so treat a
   * figure derived from a short window with suspicion.
   */
  readonly ibPerDay: number;
  readonly isPerDay: number;

  readonly askDepthMean: number;
  readonly bidDepthMean: number;
}

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

export function computeStats(bars: readonly Bar[]): Result<Stats, StatsError> {
  if (bars.length === 0) return err("empty-series");

  const sorted = [...bars].sort((a, b) => a.ts - b.ts);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return err("empty-series");

  const mids = sorted.map(mid);
  const midMean = mean(mids) ?? 0;
  if (midMean === 0) return err("zero-mean-price");

  const askMean = mean(sorted.map((b) => b.askAvg)) ?? 0;
  const bidMean = mean(sorted.map((b) => b.bidAvg)) ?? 0;

  const intervalSeconds = first.intervalSeconds;
  const span = last.ts - first.ts;
  // A single bar covers its own slot fully. Denser-than-nominal series clamp to 1 rather
  // than reporting coverage above 100%, which would be meaningless.
  const expected = intervalSeconds > 0 ? Math.floor(span / intervalSeconds) + 1 : sorted.length;
  const coverage = expected > 0 ? Math.min(1, sorted.length / expected) : 1;

  return ok({
    n: sorted.length,
    from: first.ts,
    to: last.ts,
    intervalSeconds,
    coverage,

    askMean,
    bidMean,
    midMean,

    askAvgLow: mean(sorted.map((b) => b.askMin)) ?? 0,
    askAvgHigh: mean(sorted.map((b) => b.askMax)) ?? 0,
    bidAvgLow: mean(sorted.map((b) => b.bidMin)) ?? 0,
    bidAvgHigh: mean(sorted.map((b) => b.bidMax)) ?? 0,

    askFloor: Math.min(...sorted.map((b) => b.askMin)),
    askCeiling: Math.max(...sorted.map((b) => b.askMax)),
    bidFloor: Math.min(...sorted.map((b) => b.bidMin)),
    bidCeiling: Math.max(...sorted.map((b) => b.bidMax)),

    spreadMean: mean(sorted.map(spread)) ?? 0,
    spreadPctMean: mean(sorted.map(spreadPct)) ?? 0,
    volatility: (stdev(mids) ?? 0) / midMean,

    ibPerDay: (mean(sorted.map((b) => b.ibWeek)) ?? 0) / 7,
    isPerDay: (mean(sorted.map((b) => b.isWeek)) ?? 0) / 7,

    askDepthMean: mean(sorted.map((b) => b.askDepth)) ?? 0,
    bidDepthMean: mean(sorted.map((b) => b.bidDepth)) ?? 0,
  });
}
