import { err, ok, type Result } from "./result.js";
import type { Bar } from "./sides.js";
import { percentile, sliceWindow } from "./stats.js";

/**
 * The weekly band — what this site is actually for (CLAUDE.md section 8).
 *
 * Rest a BUY ORDER at the trailing weekly low and a SELL OFFER at the trailing weekly
 * high, and collect the difference. Per section 1 this is a bid->ask strategy, so it
 * inherits that caveat in full: it is the realistic case CONDITIONAL ON BOTH ORDERS
 * FILLING. That conditional is why no band leaves this module without its hit-rate.
 *
 * Two different statistics do two different jobs here, and confusing them is the subtle
 * way this goes wrong:
 *
 *   - The BAND is a percentile of the hourly AVERAGES. It answers "what price can I
 *     realistically rest an order at?", and a percentile is what keeps a single
 *     five-minute wick from setting a level nobody can transact at.
 *   - A TOUCH is tested against the hour's EXTREME (`bidMin` / `askMax`). It answers "did
 *     price actually get there?", and for that the extreme is exactly right — an order
 *     resting at the band fills the moment the hour dips to it, regardless of where that
 *     hour averaged out.
 */

const HOUR = 3600;
const WEEK_DAYS = 7;

/** p10 of hourly bid averages. User-adjustable — CLAUDE.md section 8 is explicit that
 *  this is an input, not a constant. */
export const DEFAULT_LOW_PERCENTILE = 0.1;
/** p90 of hourly ask averages. */
export const DEFAULT_HIGH_PERCENTILE = 0.9;

export const DEFAULT_WINDOW_DAYS = 7;

/** Below this the band rests on too few hours to mean anything. */
const MIN_BARS = 24;

/** `hourly.samples` below this means the hour was assembled from a fraction of its ticks
 *  (CLAUDE.md section 3b) — the band is still computed, but says so. */
const THIN_SAMPLE_THRESHOLD = 6;

/** The 30-day retention cap allows at most four (ADR-021). */
const FULL_HISTORY_WEEKS = 4;

export interface BandInputs {
  /** Hourly bars. Anything outside the window is ignored, so a caller may pass more. */
  readonly bars: readonly Bar[];
  readonly asOf: number;
  readonly windowDays?: number;
  readonly lowPercentile?: number;
  readonly highPercentile?: number;
}

export interface BandHitRate {
  readonly hoursTouched: number;
  readonly hoursTotal: number;
  /** 0..1. By construction a p10 buy band is low — that is the point, not a defect. */
  readonly rate: number;
}

export type BandFlag =
  /** Fewer than four weeks of history, so any multi-week claim rests on small n. */
  | "short-history"
  /** Some hours were built from a fraction of their five-minute ticks. */
  | "thin-samples"
  /** Neither side was ever touched in a complete week — the band is a chart annotation,
   *  not a trade. */
  | "never-both-filled";

export interface WeeklyBand {
  /** Rest a BUY ORDER here. Derived from the BID side, because a buy order competes at
   *  the bid (CLAUDE.md section 1). */
  readonly buyBand: number;
  /** Rest a SELL OFFER here. Derived from the ASK side, because a sell offer competes at
   *  the ask. */
  readonly sellBand: number;
  readonly spread: number;
  readonly spreadPct: number;
  readonly buyHits: BandHitRate;
  readonly sellHits: BandHitRate;
  /** Weeks in which BOTH bands were touched — the fill-feasibility number for a strategy
   *  whose profit is conditional on two orders filling. */
  readonly bothHitWeeks: number;
  /** n. At most 4 under the retention cap; report it beside any multi-week claim. */
  readonly weekCount: number;
  readonly flags: readonly BandFlag[];
}

export type BandError =
  | "no-bars"
  | "insufficient-data"
  | "invalid-percentile"
  /** The band came out inverted. Returned as an error rather than a value: a buy price
   *  above a sell price is not a degraded answer, it is one that loses money if acted on. */
  | "crossed-band";

function validPercentile(p: number): boolean {
  return Number.isFinite(p) && p >= 0 && p <= 1;
}

export function computeBand(inputs: BandInputs): Result<WeeklyBand, BandError> {
  const windowDays = inputs.windowDays ?? DEFAULT_WINDOW_DAYS;
  const low = inputs.lowPercentile ?? DEFAULT_LOW_PERCENTILE;
  const high = inputs.highPercentile ?? DEFAULT_HIGH_PERCENTILE;

  if (!validPercentile(low) || !validPercentile(high) || low >= high) {
    return err("invalid-percentile");
  }
  if (inputs.bars.length === 0) return err("no-bars");

  const fromTs = inputs.asOf - windowDays * 86_400;
  const window = sliceWindow(inputs.bars, fromTs, inputs.asOf);
  if (window.length < MIN_BARS) return err("insufficient-data");

  // Sides follow CLAUDE.md section 1 with no exceptions. Reading these two lines in
  // reverse is the single most damaging edit possible in this file: it produces a buy
  // price above a sell price, i.e. orders that never fill or fill at a guaranteed loss.
  const buyBand = percentile(
    window.map((b) => b.bidAvg),
    low,
  );
  const sellBand = percentile(
    window.map((b) => b.askAvg),
    high,
  );
  if (buyBand === undefined || sellBand === undefined) return err("insufficient-data");
  if (!(buyBand < sellBand)) return err("crossed-band");

  // A touch uses the hour's extreme, not its average — see the header. An order resting
  // at the band fills the moment the hour reaches it.
  let buyTouched = 0;
  let sellTouched = 0;
  for (const b of window) {
    if (b.bidMin <= buyBand) buyTouched++;
    if (b.askMax >= sellBand) sellTouched++;
  }

  // Bucket by whole weeks back from asOf, so "a week" is a fixed 168-hour span rather
  // than a calendar week whose boundary would slice the window arbitrarily.
  //
  // The clamp matters more than it looks. A bar landing exactly on the window edge —
  // `asOf - 7 days`, which sliceWindow includes — divides to exactly 1.0 and would open a
  // second bucket holding a single hour, so a 7-day window would report TWO weeks. Since
  // weekCount is the n behind every multi-week claim, inflating it is precisely the kind
  // of quiet overstatement CLAUDE.md section 8 asks this number to prevent.
  const weekSpan = Math.max(1, Math.ceil(windowDays / WEEK_DAYS));
  const weeks = new Map<number, { buy: boolean; sell: boolean }>();
  for (const b of window) {
    const raw = Math.floor((inputs.asOf - b.ts) / (WEEK_DAYS * 86_400));
    const index = Math.min(Math.max(raw, 0), weekSpan - 1);
    const entry = weeks.get(index) ?? { buy: false, sell: false };
    if (b.bidMin <= buyBand) entry.buy = true;
    if (b.askMax >= sellBand) entry.sell = true;
    weeks.set(index, entry);
  }
  let bothHitWeeks = 0;
  for (const w of weeks.values()) if (w.buy && w.sell) bothHitWeeks++;

  const flags: BandFlag[] = [];
  if (weeks.size < FULL_HISTORY_WEEKS) flags.push("short-history");
  if (window.some((b) => b.samples < THIN_SAMPLE_THRESHOLD)) flags.push("thin-samples");
  if (bothHitWeeks === 0) flags.push("never-both-filled");

  const spread = sellBand - buyBand;
  return ok({
    buyBand,
    sellBand,
    spread,
    spreadPct: (spread / buyBand) * 100,
    buyHits: {
      hoursTouched: buyTouched,
      hoursTotal: window.length,
      rate: buyTouched / window.length,
    },
    sellHits: {
      hoursTouched: sellTouched,
      hoursTotal: window.length,
      rate: sellTouched / window.length,
    },
    bothHitWeeks,
    weekCount: weeks.size,
    flags,
  });
}

/** Hours per week, exported so callers sizing a window do not re-derive it. */
export const HOURS_PER_WEEK = (WEEK_DAYS * 86_400) / HOUR;

/**
 * What a band is worth per day.
 *
 * Ranking is by profit/day, never by spread (CLAUDE.md section 8: rank by profit-per-day,
 * never by margin). A 40% spread on a book that trades twice a week loses to a 0.5% spread
 * on something moving 200k units, and only this figure says so.
 *
 * Two haircuts, both load-bearing:
 *
 *   - **Volume.** You cannot sell into demand that is not there. `isWeek` is the units
 *     instant-sold per week — the flow that fills YOUR buy orders — and `ibWeek` is the
 *     flow that fills your sell offers. Both legs must clear, so the binding one is the
 *     smaller.
 *   - **Hit-rate.** An order resting at the p10 band only fills during the hours price
 *     actually visits it. Both legs must fill for the round trip to happen, so the
 *     limiting side is `min(buyRate, sellRate)`. Skipping this is how a band strategy
 *     gets sold as passive income: the spread looks real, but the orders sit untouched.
 *
 * Tax lands on the sell offer only, never on the buy (CLAUDE.md section 8).
 */
export interface BandMarket {
  readonly sellTaxRate: number;
  /** Fraction of market flow you realistically capture against competing orders. */
  readonly captureFraction: number;
}

export interface BandVolume {
  /** Units instant-BOUGHT per week — fills your sell offers. */
  readonly ibWeek: number;
  /** Units instant-SOLD per week — fills your buy orders. */
  readonly isWeek: number;
}

export interface BandThroughput {
  /** Units/day the market moves on the binding side, before any haircut. */
  readonly marketUnitsPerDay: number;
  /** After capture and hit-rate — what you could actually turn over. */
  readonly unitsPerDay: number;
  readonly limitedBy: "buy-side-flow" | "sell-side-flow" | "hit-rate";
}

export interface BandEconomics {
  readonly grossPerUnit: number;
  readonly taxPerUnit: number;
  readonly netPerUnit: number;
  /** Coins tied up per unit while the round trip completes. */
  readonly capitalPerUnit: number;
  readonly profitPerDay: number;
  readonly throughput: BandThroughput;
  /** Net margin against the buy band, as a percentage. */
  readonly marginPct: number;
}

export function bandEconomics(
  band: WeeklyBand,
  volume: BandVolume,
  market: BandMarket,
): BandEconomics {
  const grossPerUnit = band.sellBand - band.buyBand;
  const taxPerUnit = band.sellBand * market.sellTaxRate;
  const netPerUnit = grossPerUnit - taxPerUnit;

  const buyFlowPerDay = volume.isWeek / 7;
  const sellFlowPerDay = volume.ibWeek / 7;
  const marketUnitsPerDay = Math.min(buyFlowPerDay, sellFlowPerDay);

  const fillRate = Math.min(band.buyHits.rate, band.sellHits.rate);
  const unitsPerDay = marketUnitsPerDay * market.captureFraction * fillRate;

  // Which haircut actually bound the result — the number a user needs to know what to fix.
  const limitedBy: BandThroughput["limitedBy"] =
    fillRate <= market.captureFraction && fillRate < 1
      ? "hit-rate"
      : buyFlowPerDay <= sellFlowPerDay
        ? "buy-side-flow"
        : "sell-side-flow";

  return {
    grossPerUnit,
    taxPerUnit,
    netPerUnit,
    capitalPerUnit: band.buyBand,
    profitPerDay: netPerUnit * unitsPerDay,
    throughput: { marketUnitsPerDay, unitsPerDay, limitedBy },
    marginPct: band.buyBand > 0 ? (netPerUnit / band.buyBand) * 100 : 0,
  };
}
