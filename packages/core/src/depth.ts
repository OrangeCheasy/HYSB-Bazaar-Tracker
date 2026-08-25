import type { Point, RawQuickStatus } from "./sides.js";

/**
 * One resting price level from Hypixel's `buy_summary` / `sell_summary` arrays.
 * `amount` is units resting at this level, `orders` is how many distinct orders are
 * stacked there — a single 10,000-unit order and fifty 200-unit orders summing to the
 * same amount are different signals, which is why orderCount is tracked separately from
 * amount below.
 */
export interface RawOrderLevel {
  readonly amount: number;
  readonly pricePerUnit: number;
  readonly orders: number;
}

export interface DepthMetrics {
  readonly depth1pct: number;
  readonly depth5pct: number;
  readonly maxWall: number;
  readonly orderCount: number;
}

const ZERO_DEPTH: DepthMetrics = { depth1pct: 0, depth5pct: 0, maxWall: 0, orderCount: 0 };

/**
 * Sum resting depth within 1%/5% of the best price, the largest single order, and total
 * order count, from one side of an order book.
 *
 * `levels` MUST already be sorted best-price-first — this function trusts that ordering
 * and does not sort or validate it. Hypixel's `buy_summary` (ascending: lowest price
 * first) and `sell_summary` (descending: highest price first) are both best-first, just
 * in opposite directions; measuring distance from `levels[0]` rather than from a min/max
 * makes this function correct for either without needing to know which array it was
 * given. Verify this ordering against a live fixture, not just this comment, if Hypixel's
 * API ever changes shape.
 *
 * Empty input (Hypixel occasionally returns an empty summary for a dead product) returns
 * zeroed metrics rather than throwing.
 */
export function computeDepthMetrics(levels: readonly RawOrderLevel[]): DepthMetrics {
  const first = levels[0];
  if (!first) return ZERO_DEPTH;
  const top = first.pricePerUnit;

  let depth1pct = 0;
  let depth5pct = 0;
  let maxWall = 0;
  let orderCount = 0;

  for (const level of levels) {
    const distance = top === 0 ? 0 : Math.abs(level.pricePerUnit - top) / top;
    if (distance <= 0.01) depth1pct += level.amount;
    if (distance <= 0.05) depth5pct += level.amount;
    if (level.amount > maxWall) maxWall = level.amount;
    orderCount += level.orders;
  }

  return { depth1pct, depth5pct, maxWall, orderCount };
}

/**
 * Assigns pre-computed buy_summary/sell_summary depth metrics to ask/bid using the SAME
 * structural decision normalizeQuickStatus already made for this point — never a
 * hardcoded guess about which raw array is which side.
 *
 * Hypixel's buy_summary (resting sell offers you'd instant-buy against) and sell_summary
 * (resting buy orders) carry the same buy/sell naming inversion CLAUDE.md section 1 warns
 * about for the scalar buyPrice/sellPrice fields. Hardcoding "buy_summary -> ask" would
 * be exactly the bug class the whole ask/bid derivation module exists to prevent.
 *
 * point.ask === raw.buyPrice is a safe equality check: deriveSides passes the winning
 * price straight through with no floating-point math, so this reliably tells us whether
 * the buyPrice/buyVolume/buyMovingWeek group (and therefore buy_summary, which shares its
 * side) landed on ask or bid for this particular point.
 */
export function assignDepthToSides(
  point: Point,
  raw: RawQuickStatus,
  buySummaryMetrics: DepthMetrics,
  sellSummaryMetrics: DepthMetrics,
): { readonly ask: DepthMetrics; readonly bid: DepthMetrics } {
  return point.ask === raw.buyPrice
    ? { ask: buySummaryMetrics, bid: sellSummaryMetrics }
    : { ask: sellSummaryMetrics, bid: buySummaryMetrics };
}
