import { describe, expect, it } from "vitest";
import { assignDepthToSides, computeDepthMetrics, type RawOrderLevel } from "../src/depth.js";
import { normalizeQuickStatus, type RawQuickStatus } from "../src/sides.js";
import { makePoint } from "./helpers.js";

// Best-price-first, ascending: mirrors Hypixel's real buy_summary shape (lowest price
// first — the level you'd fill first when instant-buying).
const ASCENDING: readonly RawOrderLevel[] = [
  { amount: 1472, pricePerUnit: 100, orders: 2 },
  { amount: 943, pricePerUnit: 148, orders: 1 }, // 48% away, outside both bands
  { amount: 2240, pricePerUnit: 149, orders: 2 },
  { amount: 366, pricePerUnit: 101, orders: 1 }, // 1% away, inside the 1% band
  { amount: 5000, pricePerUnit: 104.9, orders: 3 }, // 4.9% away, inside the 5% band only
];

describe("computeDepthMetrics", () => {
  it("returns zeroed metrics for an empty book", () => {
    expect(computeDepthMetrics([])).toEqual({
      depth1pct: 0,
      depth5pct: 0,
      maxWall: 0,
      orderCount: 0,
    });
  });

  it("returns the single level as all three depth figures", () => {
    const m = computeDepthMetrics([{ amount: 500, pricePerUnit: 10, orders: 4 }]);
    expect(m).toEqual({ depth1pct: 500, depth5pct: 500, maxWall: 500, orderCount: 4 });
  });

  it("sums amount within 1% and 5% of the best (first) price, direction-agnostic", () => {
    const m = computeDepthMetrics(ASCENDING);
    // within 1%: level 0 (itself) + level at 101 (exactly 1% away)
    expect(m.depth1pct).toBe(1472 + 366);
    // within 5%: the above plus the 4.9%-away level
    expect(m.depth5pct).toBe(1472 + 366 + 5000);
  });

  it("takes the single largest amount as maxWall, not a sum", () => {
    const m = computeDepthMetrics(ASCENDING);
    expect(m.maxWall).toBe(5000);
  });

  it("sums orders across every level, not just those within band", () => {
    const m = computeDepthMetrics(ASCENDING);
    expect(m.orderCount).toBe(2 + 1 + 2 + 1 + 3);
  });

  it("works identically on a descending (best-first, highest-price-first) book", () => {
    // Same shape as a real sell_summary: descending price, still best (=highest) first.
    const descending: readonly RawOrderLevel[] = [
      { amount: 1472, pricePerUnit: 200, orders: 2 },
      { amount: 366, pricePerUnit: 198, orders: 1 }, // 1% away
      { amount: 5000, pricePerUnit: 190.2, orders: 3 }, // 4.9% away
      { amount: 943, pricePerUnit: 104, orders: 1 }, // far outside both bands
    ];
    const m = computeDepthMetrics(descending);
    expect(m.depth1pct).toBe(1472 + 366);
    expect(m.depth5pct).toBe(1472 + 366 + 5000);
    expect(m.maxWall).toBe(5000);
  });

  it("treats a zero best price as zero distance for every level, not NaN/Infinity", () => {
    const m = computeDepthMetrics([
      { amount: 10, pricePerUnit: 0, orders: 1 },
      { amount: 20, pricePerUnit: 5, orders: 1 },
    ]);
    expect(Number.isFinite(m.depth1pct)).toBe(true);
    expect(Number.isFinite(m.depth5pct)).toBe(true);
  });
});

describe("assignDepthToSides", () => {
  const SAMPLE: RawQuickStatus = {
    buyPrice: 5.43,
    buyVolume: 1_204_337,
    buyMovingWeek: 88_412_009,
    sellPrice: 4.98,
    sellVolume: 9_881_022,
    sellMovingWeek: 91_003_774,
  };

  const buyMetrics = { depth1pct: 1, depth5pct: 2, maxWall: 3, orderCount: 4 };
  const sellMetrics = { depth1pct: 10, depth5pct: 20, maxWall: 30, orderCount: 40 };

  it("assigns buy_summary's metrics to ask when buyPrice is the higher (ask) price", () => {
    const point = normalizeQuickStatus(0, SAMPLE); // buyPrice 5.43 > sellPrice 4.98
    const { ask, bid } = assignDepthToSides(point, SAMPLE, buyMetrics, sellMetrics);
    expect(ask).toBe(buyMetrics);
    expect(bid).toBe(sellMetrics);
  });

  // The load-bearing one: with the raw buy/sell fields swapped (mirrors sides.test.ts's
  // own inversion regression), buyPrice is now the LOWER price, so buy_summary's data
  // must flip to bid. A hardcoded "buy_summary -> ask" implementation would get this
  // wrong; this implementation reads it off the same structural comparison
  // normalizeQuickStatus itself used, so it flips correctly.
  it("flips buy_summary's side when the raw buy/sell fields are inverted", () => {
    const inverted: RawQuickStatus = {
      buyPrice: SAMPLE.sellPrice,
      buyVolume: SAMPLE.sellVolume,
      buyMovingWeek: SAMPLE.sellMovingWeek,
      sellPrice: SAMPLE.buyPrice,
      sellVolume: SAMPLE.buyVolume,
      sellMovingWeek: SAMPLE.buyMovingWeek,
    };
    const point = normalizeQuickStatus(0, inverted);
    // The derived Point itself is unaffected by the relabeling (that's the sides.ts
    // inversion test) — ask is still 5.43, but now carried in what used to be sellPrice.
    expect(point.ask).toBe(5.43);
    expect(point.ask).not.toBe(inverted.buyPrice);
    // So buy_summary's metrics (buyMetrics) now belong on bid, not ask.
    const { ask, bid } = assignDepthToSides(point, inverted, buyMetrics, sellMetrics);
    expect(ask).toBe(sellMetrics);
    expect(bid).toBe(buyMetrics);
  });

  it("assigns buy_summary's metrics to bid when sellPrice is the higher (ask) price", () => {
    const point = makePoint({ ask: 100, bid: 50 });
    const raw: RawQuickStatus = {
      buyPrice: 50, // lower price this time -> lands on bid
      buyVolume: 0,
      buyMovingWeek: 0,
      sellPrice: 100,
      sellVolume: 0,
      sellMovingWeek: 0,
    };
    const { ask, bid } = assignDepthToSides(point, raw, buyMetrics, sellMetrics);
    expect(ask).toBe(sellMetrics);
    expect(bid).toBe(buyMetrics);
  });
});
