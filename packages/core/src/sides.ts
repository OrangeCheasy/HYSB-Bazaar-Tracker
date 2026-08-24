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
