import { err, ok, type Result } from "./result.js";

/**
 * Structural ask/bid derivation.
 *
 * Hypixel's bazaar field names are inverted from intuition: `buyPrice` is what YOU pay
 * to instant-buy, i.e. the lowest sell offer. We never trust the names. We sort the two
 * sides by price and let the market's own invariant tell us which is which:
 *
 *   ask = the HIGHER price = lowest sell offer  (you pay this to instant-buy)
 *   bid = the LOWER price  = highest buy order  (you receive this to instant-sell)
 *
 * `ask >= bid` always, because a crossed book would have matched already. Volume and
 * moving-week figures travel with whichever side shares their prefix, so they follow the
 * price into whichever slot it lands in.
 *
 * This makes the derivation unfalsifiable: if Hypixel renames a field tomorrow, the
 * output is unchanged. See test/sides.test.ts — that test is load-bearing.
 */

/** One labelled side of the raw upstream payload, before we know which side it is. */
export interface RawSide {
  readonly price: number;
  /** Units resting on this side of the book. */
  readonly volume: number;
  /** Units transacted on this side over the trailing week. */
  readonly movingWeek: number;
}

/** The `quick_status` shape from api.hypixel.net/v2/skyblock/bazaar, loosely typed. */
export interface RawQuickStatus {
  readonly buyPrice: number;
  readonly buyVolume: number;
  readonly buyMovingWeek: number;
  readonly sellPrice: number;
  readonly sellVolume: number;
  readonly sellMovingWeek: number;
}

/** A normalized point. Every downstream calculation starts here, never from raw. */
export interface Point {
  /** UTC epoch seconds. */
  readonly ts: number;
  /** Higher price. Lowest sell offer. You pay this to instant-buy. */
  readonly ask: number;
  /** Lower price. Highest buy order. You receive this when you instant-sell. */
  readonly bid: number;
  /** Units resting in sell offers. */
  readonly askDepth: number;
  /** Units resting in buy orders — the queue ahead of your own buy order. */
  readonly bidDepth: number;
  /** Units instant-bought over the trailing week. */
  readonly ibWeek: number;
  /** Units instant-sold over the trailing week. These are what fill YOUR buy orders. */
  readonly isWeek: number;
}

/**
 * Order two sides deterministically: price desc, then volume desc, then movingWeek desc.
 *
 * The price comparison is the real rule. The volume/movingWeek tiebreaks only matter for
 * the degenerate `ask === bid` book, where prices alone cannot say which side owns which
 * depth. Without them, a tied book would produce different output depending on which
 * upstream field the data happened to arrive in — exactly the bug this module exists to
 * make impossible.
 */
function compareSides(a: RawSide, b: RawSide): number {
  if (a.price !== b.price) return b.price - a.price;
  if (a.volume !== b.volume) return b.volume - a.volume;
  return b.movingWeek - a.movingWeek;
}

/**
 * Derive ask/bid structurally from two unlabelled sides.
 *
 * @param ts UTC epoch seconds.
 */
export function deriveSides(ts: number, one: RawSide, other: RawSide): Point {
  const [high, low] = compareSides(one, other) <= 0 ? [one, other] : [other, one];

  return {
    ts,
    ask: high.price,
    bid: low.price,
    askDepth: high.volume,
    bidDepth: low.volume,
    ibWeek: high.movingWeek,
    isWeek: low.movingWeek,
  };
}

/** Normalize a raw Hypixel `quick_status` into a `Point`, ignoring what the fields are called. */
export function normalizeQuickStatus(ts: number, raw: RawQuickStatus): Point {
  return deriveSides(
    ts,
    { price: raw.buyPrice, volume: raw.buyVolume, movingWeek: raw.buyMovingWeek },
    { price: raw.sellPrice, volume: raw.sellVolume, movingWeek: raw.sellMovingWeek },
  );
}

/** The invariant, as a runtime check. Cheap enough to assert on every ingest batch. */
export function isWellFormed(p: Point): boolean {
  return (
    Number.isFinite(p.ask) &&
    Number.isFinite(p.bid) &&
    p.ask >= p.bid &&
    p.bid >= 0 &&
    p.askDepth >= 0 &&
    p.bidDepth >= 0
  );
}

// ---------------------------------------------------------------------------
// INTERVAL DATA
// ---------------------------------------------------------------------------
//
// A Point is one instant. A Bar is one interval, and carries the per-side extremes that
// a Point cannot represent. The D1 `hourly` and `daily` tables are Bars; `snapshots` is
// Points. Everything downstream of this module consumes Bars, so there is exactly one
// code path regardless of whether the data came from Hypixel, Coflnet or our own rows.

/** Where a series came from. Backfilled Coflnet data is coarser and must stay labelled. */
export type DataSource = "hypixel" | "coflnet";

/** One aggregated interval. `ts` is the interval START, UTC epoch seconds. */
export interface Bar {
  readonly ts: number;
  readonly intervalSeconds: number;
  readonly askAvg: number;
  readonly askMin: number;
  readonly askMax: number;
  readonly bidAvg: number;
  readonly bidMin: number;
  readonly bidMax: number;
  readonly askDepth: number;
  readonly bidDepth: number;
  readonly ibWeek: number;
  readonly isWeek: number;
  readonly samples: number;
  readonly source: DataSource;
}

/** One unlabelled side of an interval, before we know which side it is. */
export interface RawBarSide {
  readonly avg: number;
  readonly min: number;
  readonly max: number;
  readonly volume: number;
  readonly movingWeek: number;
}

export type NormalizeError = "missing-field" | "non-finite" | "negative-price" | "crossed-book";

/**
 * Order two interval sides deterministically. Average price is the real rule; the rest
 * are tiebreaks so that a tied book cannot produce different output depending on which
 * upstream field the data happened to arrive in.
 */
function compareBarSides(a: RawBarSide, b: RawBarSide): number {
  if (a.avg !== b.avg) return b.avg - a.avg;
  if (a.max !== b.max) return b.max - a.max;
  if (a.min !== b.min) return b.min - a.min;
  if (a.volume !== b.volume) return b.volume - a.volume;
  return b.movingWeek - a.movingWeek;
}

/** Derive ask/bid structurally from two unlabelled interval sides. */
export function deriveBarSides(
  ts: number,
  intervalSeconds: number,
  samples: number,
  source: DataSource,
  one: RawBarSide,
  other: RawBarSide,
): Bar {
  const [high, low] = compareBarSides(one, other) <= 0 ? [one, other] : [other, one];

  return {
    ts,
    intervalSeconds,
    samples,
    source,
    askAvg: high.avg,
    askMin: high.min,
    askMax: high.max,
    bidAvg: low.avg,
    bidMin: low.min,
    bidMax: low.max,
    askDepth: high.volume,
    bidDepth: low.volume,
    ibWeek: high.movingWeek,
    isWeek: low.movingWeek,
  };
}

/**
 * The Bar invariant.
 *
 * Note what is NOT checked: `askMin >= bidMax`. Over an interval the ask can dip below
 * where the bid peaked without any single instant having a crossed book, so requiring it
 * would reject legitimate volatile hours.
 */
export function isBarWellFormed(b: Bar): boolean {
  const finite = [b.askAvg, b.askMin, b.askMax, b.bidAvg, b.bidMin, b.bidMax].every((n) =>
    Number.isFinite(n),
  );
  return (
    finite &&
    b.askAvg >= b.bidAvg &&
    b.bidMin >= 0 &&
    b.askMin <= b.askMax &&
    b.bidMin <= b.bidMax &&
    b.askDepth >= 0 &&
    b.bidDepth >= 0 &&
    b.samples > 0
  );
}

// ---------------------------------------------------------------------------
// ADAPTERS — the seam between "raw upstream shape" and "normalized series"
// ---------------------------------------------------------------------------

/**
 * A point from sky.coflnet.com history. Used by scripts/backfill.ts only; the Worker
 * must never call Coflnet (CLAUDE.md section 2). min/max are optional because Coflnet
 * coarsens the further back you go and omits them on some ranges.
 */
export interface RawCoflnetPoint {
  readonly timestamp: string;
  readonly buy: number;
  readonly sell: number;
  readonly minBuy?: number;
  readonly maxBuy?: number;
  readonly minSell?: number;
  readonly maxSell?: number;
  readonly buyVolume?: number;
  readonly sellVolume?: number;
  readonly buyMovingWeek?: number;
  readonly sellMovingWeek?: number;
}

/** A row from the D1 `hourly` table, as D1 returns it. */
export interface RawHourlyRow {
  readonly hour_ts: number;
  readonly ask_avg: number;
  readonly ask_min: number;
  readonly ask_max: number;
  readonly bid_avg: number;
  readonly bid_min: number;
  readonly bid_max: number;
  readonly ask_depth: number;
  readonly bid_depth: number;
  readonly ib_week: number;
  readonly is_week: number;
  readonly samples: number;
  readonly source: string;
}

/** A row from the D1 `snapshots` table, as D1 returns it. */
export interface RawSnapshotRow {
  readonly ts: number;
  readonly ask: number;
  readonly bid: number;
  readonly ask_depth: number;
  readonly bid_depth: number;
  readonly ib_week: number;
  readonly is_week: number;
}

function toDataSource(s: string): DataSource {
  return s === "coflnet" ? "coflnet" : "hypixel";
}

/**
 * Normalize a Coflnet history point. This is one of only two places where the ask/bid
 * derivation actually runs — the other is normalizeQuickStatus. Everything else reads
 * already-derived data.
 */
export function normalizeCoflnetPoint(
  raw: RawCoflnetPoint,
  intervalSeconds: number,
): Result<Bar, NormalizeError> {
  const ms = Date.parse(raw.timestamp);
  if (!Number.isFinite(ms)) return err("missing-field");

  const prices = [raw.buy, raw.sell];
  if (!prices.every((n) => Number.isFinite(n))) return err("non-finite");
  if (prices.some((n) => n < 0)) return err("negative-price");

  // Missing min/max degrade to the average: a flat bar, which is exactly what a single
  // observation means. Never invent a range that was not measured.
  const buySide: RawBarSide = {
    avg: raw.buy,
    min: raw.minBuy ?? raw.buy,
    max: raw.maxBuy ?? raw.buy,
    volume: raw.buyVolume ?? 0,
    movingWeek: raw.buyMovingWeek ?? 0,
  };
  const sellSide: RawBarSide = {
    avg: raw.sell,
    min: raw.minSell ?? raw.sell,
    max: raw.maxSell ?? raw.sell,
    volume: raw.sellVolume ?? 0,
    movingWeek: raw.sellMovingWeek ?? 0,
  };

  const bar = deriveBarSides(
    Math.floor(ms / 1000),
    intervalSeconds,
    1,
    "coflnet",
    buySide,
    sellSide,
  );
  return isBarWellFormed(bar) ? ok(bar) : err("crossed-book");
}

/**
 * Map an hourly row to a Bar. Asserts the invariant rather than re-deriving it: D1 holds
 * already-derived sides, so a crossed row means ingest wrote bad data. Silently
 * re-sorting here would hide exactly the bug that matters.
 */
export function normalizeHourlyRow(row: RawHourlyRow): Result<Bar, NormalizeError> {
  const bar: Bar = {
    ts: row.hour_ts,
    intervalSeconds: 3600,
    askAvg: row.ask_avg,
    askMin: row.ask_min,
    askMax: row.ask_max,
    bidAvg: row.bid_avg,
    bidMin: row.bid_min,
    bidMax: row.bid_max,
    askDepth: row.ask_depth,
    bidDepth: row.bid_depth,
    ibWeek: row.ib_week,
    isWeek: row.is_week,
    samples: row.samples,
    source: toDataSource(row.source),
  };
  return isBarWellFormed(bar) ? ok(bar) : err("crossed-book");
}

/** Map a snapshot row to a Point. Same reasoning as normalizeHourlyRow: assert, do not fix. */
export function normalizeSnapshotRow(row: RawSnapshotRow): Result<Point, NormalizeError> {
  const p: Point = {
    ts: row.ts,
    ask: row.ask,
    bid: row.bid,
    askDepth: row.ask_depth,
    bidDepth: row.bid_depth,
    ibWeek: row.ib_week,
    isWeek: row.is_week,
  };
  return isWellFormed(p) ? ok(p) : err("crossed-book");
}

/** Widen an instantaneous Point into a degenerate Bar where min == avg == max. */
export function pointToBar(p: Point, intervalSeconds: number, source: DataSource): Bar {
  return {
    ts: p.ts,
    intervalSeconds,
    askAvg: p.ask,
    askMin: p.ask,
    askMax: p.ask,
    bidAvg: p.bid,
    bidMin: p.bid,
    bidMax: p.bid,
    askDepth: p.askDepth,
    bidDepth: p.bidDepth,
    ibWeek: p.ibWeek,
    isWeek: p.isWeek,
    samples: 1,
    source,
  };
}

/**
 * Bucket points into fixed intervals. This is the rollup arithmetic, kept here in core
 * so that src/worker/rollup.ts is nothing but SQL and plumbing.
 *
 * Trailing-week counters take the LAST value in the bucket, not the mean: they are a
 * running total, so the newest reading is the one that describes the interval's end.
 */
export function aggregate(
  points: readonly Point[],
  intervalSeconds: number,
  source: DataSource,
): readonly Bar[] {
  if (intervalSeconds <= 0 || points.length === 0) return [];

  const buckets = new Map<number, Point[]>();
  for (const p of points) {
    const key = Math.floor(p.ts / intervalSeconds) * intervalSeconds;
    const existing = buckets.get(key);
    if (existing) existing.push(p);
    else buckets.set(key, [p]);
  }

  const out: Bar[] = [];
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const group = buckets.get(key);
    if (!group || group.length === 0) continue;
    const ordered = [...group].sort((a, b) => a.ts - b.ts);
    const last = ordered[ordered.length - 1];
    if (!last) continue;

    let askSum = 0;
    let bidSum = 0;
    let depthAskSum = 0;
    let depthBidSum = 0;
    let askMin = Number.POSITIVE_INFINITY;
    let askMax = Number.NEGATIVE_INFINITY;
    let bidMin = Number.POSITIVE_INFINITY;
    let bidMax = Number.NEGATIVE_INFINITY;

    for (const p of ordered) {
      askSum += p.ask;
      bidSum += p.bid;
      depthAskSum += p.askDepth;
      depthBidSum += p.bidDepth;
      if (p.ask < askMin) askMin = p.ask;
      if (p.ask > askMax) askMax = p.ask;
      if (p.bid < bidMin) bidMin = p.bid;
      if (p.bid > bidMax) bidMax = p.bid;
    }

    const n = ordered.length;
    out.push({
      ts: key,
      intervalSeconds,
      askAvg: askSum / n,
      askMin,
      askMax,
      bidAvg: bidSum / n,
      bidMin,
      bidMax,
      askDepth: depthAskSum / n,
      bidDepth: depthBidSum / n,
      ibWeek: last.ibWeek,
      isWeek: last.isWeek,
      samples: n,
      source,
    });
  }
  return out;
}

/**
 * Bulk normalize, keeping the good and reporting the bad. Hypixel occasionally returns a
 * product with a missing quick_status; one bad product must not abort a whole ingest run
 * (ROADMAP Phase 2).
 */
export function normalizeMany<T, U>(
  rows: readonly T[],
  fn: (row: T) => Result<U, NormalizeError>,
): {
  readonly ok: readonly U[];
  readonly skipped: readonly { readonly index: number; readonly error: NormalizeError }[];
} {
  const good: U[] = [];
  const skipped: { index: number; error: NormalizeError }[] = [];
  for (const [index, row] of rows.entries()) {
    const r = fn(row);
    if (r.ok) good.push(r.value);
    else skipped.push({ index, error: r.error });
  }
  return { ok: good, skipped };
}
