import { describe, expect, it } from "vitest";
import { analyzeCraft, applySellTax, type MarketConfig } from "../src/economics.js";
import type { Recipe } from "../src/recipes.js";
import { computeStats } from "../src/stats.js";
import { constantSeries } from "./helpers.js";
import type { Bar } from "../src/sides.js";
import type { Stats } from "../src/stats.js";

/**
 * KNOWN-VALUE TESTS - the arithmetic is written out in full so it can be checked by
 * hand, independently of the implementation. Scenario shapes follow bzcraft/model.py
 * `craft_economics`.
 *
 * Fixture, 24 identical hourly bars per item, so every mean equals the last value and
 * the stated numbers hold whichever the code reads:
 *
 *   COAL (base)              ask 10      bid 9
 *                            askDepth      500,000   bidDepth   1,900,000
 *                            ibWeek      3,500,000   isWeek     7,000,000
 *
 *   ENCHANTED_COAL (product) ask 1800    bid 1700
 *                            askDepth       50,000   bidDepth      30,000
 *                            ibWeek        700,000   isWeek       350,000
 *
 *   ratio 160 (verified)   tax 1.25%   capture 10%   tick 0.1
 *
 * Flow rates come from the NEWEST trailing-week counter, divided by 168 or 7:
 *   base.isPerHour    = 7,000,000 / 168 = 41,666.67   base.isPerDay    = 1,000,000
 *   product.ibPerHour =   700,000 / 168 =  4,166.67   product.ibPerDay =   100,000
 *
 * THROUGHPUT
 *   baseUnitsPerDay    = 41,666.67 x 24 x 0.10 = 100,000
 *   craftsFromSupply   =   100,000 / 160       =     625
 *   productUnitsPerDay =  4,166.67 x 24 x 0.10 =  10,000
 *   craftsFromDemand   =                          10,000
 *   craftsPerDay       = min(625, 10,000)      =     625   -> limited by base supply
 *   hoursToFillOneCraft = 160 / (41,666.67 x 0.10)        = 0.0384h
 *
 * FILL FEASIBILITY
 *   buy order on base     = isPerDay / (bidDepth + ratio x craftsPerDay)
 *                         = 1,000,000 / (1,900,000 + 100,000) = 0.5
 *   sell offer on product = ibPerDay / (askDepth + craftsPerDay)
 *                         = 100,000 / 50,625 = 1.975...  -> clamped to 1.0
 *   combined (orders and timed)                            = 0.5
 *
 * SCENARIO "floor" - instant both ways. Always available; the true worst case.
 *   cost   = 10 x 160              = 1600
 *   gross  = 1700
 *   tax    = 1700 x 0.0125         =   21.25
 *   profit = 1700 - 21.25 - 1600   =   78.75
 *   margin = 78.75 / 1600          =    0.04921875
 *   feasibility                    =    1.0
 *
 * SCENARIO "orders" - orders on the current book, each stepped one tick inside.
 *   buy    = 9 + 0.1               =    9.1
 *   sell   = 1800 - 0.1            = 1799.9
 *   cost   = 9.1 x 160             = 1456
 *   tax    = 1799.9 x 0.0125       =   22.49875
 *   profit = 1799.9 - 22.49875 - 1456 = 321.40125
 *   margin = 321.40125 / 1456      =    0.2207426...
 *   feasibility                    =    0.5
 *
 * SCENARIO "timed" - the same orders, priced from the overnight and peak windows. The
 * inputs are the RAW window prices; the tick is applied here exactly as for the book.
 *   window bid 8.4    -> buy  = 8.4 + 0.1    =    8.5
 *   window ask 1850.1 -> sell = 1850.1 - 0.1 = 1850
 *   cost   = 8.5 x 160             = 1360
 *   tax    = 1850 x 0.0125         =   23.125
 *   profit = 1850 - 23.125 - 1360  =  466.875
 *   margin = 466.875 / 1360        =    0.3432904...
 *   feasibility                    =    0.5
 *
 * HEADLINE (ranked on timed, per model.py profit_per_day)
 *   profitPerDay    = 466.875 x 625 = 291,796.875
 *   capitalPerCraft = 1360
 */

const BASE_BARS: Bar[] = constantSeries(24, {
  askAvg: 10,
  askMin: 10,
  askMax: 10,
  bidAvg: 9,
  bidMin: 9,
  bidMax: 9,
  askDepth: 500_000,
  bidDepth: 1_900_000,
  ibWeek: 3_500_000,
  isWeek: 7_000_000,
});

const PRODUCT_BARS: Bar[] = constantSeries(24, {
  askAvg: 1800,
  askMin: 1800,
  askMax: 1800,
  bidAvg: 1700,
  bidMin: 1700,
  bidMax: 1700,
  askDepth: 50_000,
  bidDepth: 30_000,
  ibWeek: 700_000,
  isWeek: 350_000,
});

const RECIPE: Recipe = {
  id: 1,
  baseTag: "COAL",
  enchTag: "ENCHANTED_COAL",
  ratio: 160,
  verified: true,
  note: null,
};

const MARKET: MarketConfig = { sellTaxRate: 0.0125, captureFraction: 0.1, tick: 0.1 };

function statsOf(bars: Bar[]): Stats {
  const r = computeStats(bars);
  if (!r.ok) throw new Error(`fixture failed to compute stats: ${r.error}`);
  return r.value;
}

const BASE = statsOf(BASE_BARS);
const PRODUCT = statsOf(PRODUCT_BARS);

function analyze(over: Partial<Parameters<typeof analyzeCraft>[0]> = {}) {
  return analyzeCraft({
    recipe: RECIPE,
    base: BASE,
    product: PRODUCT,
    market: MARKET,
    asOf: BASE.to,
    ...over,
  });
}

describe("fixture sanity - the inputs really are what the arithmetic above assumes", () => {
  it("has the stated flow rates, depths and last prices", () => {
    expect(BASE.isPerDay).toBe(1_000_000);
    expect(BASE.isPerHour).toBeCloseTo(7_000_000 / 168, 9);
    expect(BASE.lastBidDepth).toBe(1_900_000);
    expect(BASE.lastAsk).toBe(10);
    expect(BASE.lastBid).toBe(9);
    expect(PRODUCT.ibPerDay).toBe(100_000);
    expect(PRODUCT.ibPerHour).toBeCloseTo(700_000 / 168, 9);
    expect(PRODUCT.lastAskDepth).toBe(50_000);
    expect(PRODUCT.lastAsk).toBe(1800);
    expect(PRODUCT.lastBid).toBe(1700);
  });
});

describe("applySellTax", () => {
  it("takes the tax off the gross", () => {
    expect(applySellTax(1700, 0.0125)).toBe(1678.75);
    expect(applySellTax(1800, 0.0125)).toBe(1777.5);
  });

  it("supports the Bazaar Flipper II and Mayor Aura rates", () => {
    expect(applySellTax(1000, 0.01)).toBe(990);
    expect(applySellTax(1000, 0.0225)).toBe(977.5);
  });

  it("is a no-op at a zero rate", () => {
    expect(applySellTax(1000, 0)).toBe(1000);
  });
});

describe("analyzeCraft - known values", () => {
  const r = analyze({ timedBuyWindowBid: 8.4, timedSellWindowAsk: 1850.1 });

  it("succeeds on the fixture", () => {
    expect(r.ok).toBe(true);
  });

  it("computes the floor scenario: cost 1600, tax 21.25, profit 78.75", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value.scenarios.floor;
    expect(s.baseUnitPrice).toBe(10);
    expect(s.productUnitPrice).toBe(1700);
    expect(s.costPerCraft).toBe(1600);
    expect(s.grossPerCraft).toBe(1700);
    expect(s.taxPerCraft).toBe(21.25);
    expect(s.profitPerCraft).toBe(78.75);
    expect(s.marginPct).toBeCloseTo(0.04921875, 12);
    expect(s.fillFeasibility).toBe(1);
  });

  it("computes orders one tick inside the book: cost 1456, profit 321.40125", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value.scenarios.orders;
    expect(s.baseUnitPrice).toBeCloseTo(9.1, 12);
    expect(s.productUnitPrice).toBeCloseTo(1799.9, 12);
    expect(s.costPerCraft).toBeCloseTo(1456, 9);
    expect(s.taxPerCraft).toBeCloseTo(22.49875, 9);
    expect(s.profitPerCraft).toBeCloseTo(321.40125, 9);
    expect(s.marginPct).toBeCloseTo(321.40125 / 1456, 12);
    expect(s.fillFeasibility).toBeCloseTo(0.5, 12);
  });

  it("computes the timed scenario from window prices: cost 1360, profit 466.875", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value.scenarios.timed;
    expect(s.baseUnitPrice).toBeCloseTo(8.5, 12);
    expect(s.productUnitPrice).toBeCloseTo(1850, 9);
    expect(s.costPerCraft).toBeCloseTo(1360, 9);
    expect(s.taxPerCraft).toBeCloseTo(23.125, 9);
    expect(s.profitPerCraft).toBeCloseTo(466.875, 9);
    expect(s.marginPct).toBeCloseTo(466.875 / 1360, 12);
    expect(s.fillFeasibility).toBeCloseTo(0.5, 12);
  });

  it("ranks profitPerDay on the timed scenario, not the current book", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.profitPerDay).toBeCloseTo(291_796.875, 6);
    expect(r.value.capitalPerCraft).toBe(1360);
    expect(r.value.capitalRequired).toBeCloseTo(1360 * 625, 6);
  });

  it("orders the scenarios floor < orders < timed, feasibility running the other way", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { floor, orders, timed } = r.value.scenarios;
    expect(floor.profitPerCraft).toBeLessThan(orders.profitPerCraft);
    expect(orders.profitPerCraft).toBeLessThan(timed.profitPerCraft);
    expect(floor.fillFeasibility).toBeGreaterThan(timed.fillFeasibility);
  });

  it("computes throughput: 625 crafts/day, limited by base supply", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.value.throughput;
    expect(t.baseUnitsPerDay).toBeCloseTo(100_000, 6);
    expect(t.productUnitsPerDay).toBeCloseTo(10_000, 6);
    expect(t.craftsFromSupply).toBeCloseTo(625, 9);
    expect(t.craftsFromDemand).toBeCloseTo(10_000, 6);
    expect(t.craftsPerDay).toBeCloseTo(625, 9);
    expect(t.limitedBy).toBe("base-supply");
    expect(t.hoursToFillOneCraft).toBeCloseTo(160 / ((7_000_000 / 168) * 0.1), 9);
  });

  it("raises no flags on a healthy, verified craft", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.flags).toEqual([]);
  });
});

describe("analyzeCraft - the timed fallback", () => {
  /**
   * model.py: `buy_price = timed_buy_price if timed_buy_price else order_buy`. With no
   * hour profile the timed scenario must equal the current-book one rather than silently
   * pricing at zero.
   */
  it("falls back to current-book order pricing when no window prices are given", () => {
    const r = analyze();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { orders, timed } = r.value.scenarios;
    expect(timed.baseUnitPrice).toBe(orders.baseUnitPrice);
    expect(timed.productUnitPrice).toBe(orders.productUnitPrice);
    expect(timed.profitPerCraft).toBeCloseTo(orders.profitPerCraft, 12);
  });

  it("ignores a non-positive window price rather than pricing a craft at zero", () => {
    const r = analyze({ timedBuyWindowBid: 0, timedSellWindowAsk: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scenarios.timed.baseUnitPrice).toBeCloseTo(9.1, 12);
    expect(r.value.scenarios.timed.productUnitPrice).toBeCloseTo(1799.9, 12);
  });
});

describe("analyzeCraft - the tick", () => {
  it("prices orders at the book itself when the tick is zero", () => {
    const r = analyze({ market: { ...MARKET, tick: 0 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scenarios.orders.baseUnitPrice).toBe(9);
    expect(r.value.scenarios.orders.productUnitPrice).toBe(1800);
  });

  it("never lets an oversized tick drive the sell price below zero", () => {
    const r = analyze({ market: { ...MARKET, tick: 99_999 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scenarios.orders.productUnitPrice).toBe(0);
    expect(r.value.scenarios.orders.profitPerCraft).toBeLessThan(0);
  });
});

describe("analyzeCraft - throughput limits", () => {
  it("switches to product-demand when the product cannot absorb the crafts", () => {
    const product = statsOf(
      constantSeries(24, {
        askAvg: 1800,
        askMin: 1800,
        askMax: 1800,
        bidAvg: 1700,
        bidMin: 1700,
        bidMax: 1700,
        askDepth: 50_000,
        bidDepth: 30_000,
        ibWeek: 7_000,
        isWeek: 3_500,
      }),
    );
    const r = analyze({ product });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.throughput.craftsPerDay).toBeCloseTo(100, 9);
    expect(r.value.throughput.limitedBy).toBe("product-demand");
  });

  it("caps by capital when the wallet is the binding constraint", () => {
    // 145,600 / 1456 per craft at order pricing = 100 crafts, below the market's 625.
    const r = analyze({ capitalAvailable: 145_600 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.throughput.craftsPerDay).toBeCloseTo(100, 9);
    expect(r.value.throughput.limitedBy).toBe("capital");
  });

  it("does not cap when capital exceeds what the market allows", () => {
    const r = analyze({ capitalAvailable: 10_000_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.throughput.craftsPerDay).toBeCloseTo(625, 9);
    expect(r.value.throughput.limitedBy).toBe("base-supply");
  });

  /**
   * Throughput is bounded by market flow, NOT by how long the player is logged in.
   * An earlier version scaled it by waking hours, which contradicts the premise: the buy
   * order is supposed to fill overnight while you sleep. model.py `craft_economics` takes
   * no sleep parameter at all - the sleep window prices the timed buy, nothing more.
   */
  it("does not scale throughput by the player's waking hours", () => {
    const r = analyze();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.throughput.craftsPerDay).toBeCloseTo(625, 9);
    expect(r.value.throughput.craftsPerDay).toBe(
      Math.min(r.value.throughput.craftsFromSupply, r.value.throughput.craftsFromDemand),
    );
  });

  it("reports an infinite fill time when no base flows at all", () => {
    const dead = statsOf(
      constantSeries(24, {
        askAvg: 10,
        askMin: 10,
        askMax: 10,
        bidAvg: 9,
        bidMin: 9,
        bidMax: 9,
        askDepth: 500_000,
        bidDepth: 1_900_000,
        ibWeek: 0,
        isWeek: 0,
      }),
    );
    const r = analyze({ base: dead });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.throughput.hoursToFillOneCraft).toBe(Number.POSITIVE_INFINITY);
    expect(r.value.flags).toContain("slow-fill");
  });
});

describe("analyzeCraft - warning flags", () => {
  it("flags an unverified recipe", () => {
    const r = analyze({ recipe: { ...RECIPE, verified: false } });
    expect(r.ok && r.value.flags).toContain("unverified-recipe");
  });

  it("flags an implausible margin - the recipe is wrong or the item is walled", () => {
    const r = analyze({ timedSellWindowAsk: 10_000 });
    expect(r.ok && r.value.flags).toContain("implausible-margin");
  });

  it("flags below-ratio parity - the Super Compactor 3000 case", () => {
    // Product ask 1,200 is BELOW base ask x 160 = 1,600. Enchanted trades under parity
    // because minions dump price-insensitive supply into the book. CLAUDE.md section 8.
    const product = statsOf(
      constantSeries(24, {
        askAvg: 1200,
        askMin: 1200,
        askMax: 1200,
        bidAvg: 1150,
        bidMin: 1150,
        bidMax: 1150,
        askDepth: 50_000,
        bidDepth: 30_000,
        ibWeek: 700_000,
        isWeek: 350_000,
      }),
    );
    const r = analyze({ product });
    expect(r.ok && r.value.flags).toContain("below-ratio-parity");
  });

  /**
   * model.py: "deep buy-order queue (~Nh of flow resting)". Depth divided by hourly flow
   * is how long the queue ahead of your order takes to clear, which is the number that
   * decides whether an overnight buy order fills.
   */
  it("flags a buy-order queue deeper than 48 hours of flow", () => {
    // 9,000,000 / 41,666.67 per hour = 216h of resting flow, well past 48.
    const clogged = statsOf(
      constantSeries(24, {
        askAvg: 10,
        askMin: 10,
        askMax: 10,
        bidAvg: 9,
        bidMin: 9,
        bidMax: 9,
        askDepth: 500_000,
        bidDepth: 9_000_000,
        ibWeek: 3_500_000,
        isWeek: 7_000_000,
      }),
    );
    const r = analyze({ base: clogged });
    expect(r.ok && r.value.flags).toContain("deep-buy-queue");
  });

  it("flags a product that is barely ever instant-bought", () => {
    const quiet = statsOf(
      constantSeries(24, {
        askAvg: 1800,
        askMin: 1800,
        askMax: 1800,
        bidAvg: 1700,
        bidMin: 1700,
        bidMax: 1700,
        askDepth: 50_000,
        bidDepth: 30_000,
        ibWeek: 100,
        isWeek: 100,
      }),
    );
    const r = analyze({ product: quiet });
    expect(r.ok && r.value.flags).toContain("product-rarely-instant-bought");
  });

  it("flags a volatile base", () => {
    // Ask alternates 8 and 12 around a mean of 10: pstdev 2, volatility 0.20 > 0.12.
    const swings: Bar[] = constantSeries(24, {
      askDepth: 500_000,
      bidDepth: 1_900_000,
      ibWeek: 3_500_000,
      isWeek: 7_000_000,
    }).map((b, i) => {
      const ask = i % 2 === 0 ? 8 : 12;
      return { ...b, askAvg: ask, askMin: ask, askMax: ask, bidAvg: 7, bidMin: 7, bidMax: 7 };
    });
    const r = analyze({ base: statsOf(swings) });
    expect(r.ok && r.value.flags).toContain("volatile-base");
  });

  /**
   * The single most important flag on the site: the craft only works if both orders
   * fill. model.py raises it when the timed plan profits but the instant floor does not.
   */
  it("flags a craft whose profit depends entirely on both orders filling", () => {
    // Product bid 1500 makes the floor negative while the timed scenario stays positive.
    const product = statsOf(
      constantSeries(24, {
        askAvg: 1800,
        askMin: 1800,
        askMax: 1800,
        bidAvg: 1500,
        bidMin: 1500,
        bidMax: 1500,
        askDepth: 50_000,
        bidDepth: 30_000,
        ibWeek: 700_000,
        isWeek: 350_000,
      }),
    );
    const r = analyze({ product });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scenarios.floor.profitPerCraft).toBeLessThan(0);
    expect(r.value.scenarios.timed.profitPerCraft).toBeGreaterThan(0);
    expect(r.value.flags).toContain("profit-needs-both-fills");
  });

  it("flags a wide spread", () => {
    const wide = statsOf(
      constantSeries(24, {
        askAvg: 20,
        askMin: 20,
        askMax: 20,
        bidAvg: 9,
        bidMin: 9,
        bidMax: 9,
        askDepth: 500_000,
        bidDepth: 1_900_000,
        ibWeek: 3_500_000,
        isWeek: 7_000_000,
      }),
    );
    const r = analyze({ base: wide });
    expect(r.ok && r.value.flags).toContain("wide-spread");
  });

  it("flags stale data", () => {
    const r = analyze({ asOf: BASE.to + 6 * 3600 });
    expect(r.ok && r.value.flags).toContain("stale-data");
  });

  it("flags a single-sided book", () => {
    const oneSided = statsOf(
      constantSeries(24, {
        askAvg: 10,
        askMin: 10,
        askMax: 10,
        bidAvg: 9,
        bidMin: 9,
        bidMax: 9,
        askDepth: 0,
        bidDepth: 1_900_000,
        ibWeek: 3_500_000,
        isWeek: 7_000_000,
      }),
    );
    const r = analyze({ base: oneSided });
    expect(r.ok && r.value.flags).toContain("single-sided-book");
  });
});

describe("analyzeCraft - the instant-sell tax flag", () => {
  /**
   * model.py taxes the instant-sell in scenario A:
   *   floor_revenue_net = ench.last_bid * (1 - tax)
   * which confirms the conservative default. Kept as a flag because CLAUDE.md section 8
   * words it ambiguously. See ADR-008.
   *
   * Untaxed floor arithmetic: 1700 - 0 - 1600 = 100, margin 100 / 1600 = 0.0625.
   */
  it("taxes instant-sells by default, matching model.py", () => {
    const r = analyze();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scenarios.floor.taxPerCraft).toBe(21.25);
  });

  it("drops the tax from the floor when told to, leaving order scenarios taxed", () => {
    const r = analyze({
      market: { ...MARKET, taxOnInstantSell: false },
      timedBuyWindowBid: 8.4,
      timedSellWindowAsk: 1850.1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { floor, timed } = r.value.scenarios;

    expect(floor.taxPerCraft).toBe(0);
    expect(floor.profitPerCraft).toBe(100);
    expect(floor.marginPct).toBeCloseTo(0.0625, 12);

    // A sell offer is taxed under either reading, so the headline is untouched.
    expect(timed.taxPerCraft).toBeCloseTo(23.125, 9);
    expect(timed.profitPerCraft).toBeCloseTo(466.875, 9);
  });
});

describe("analyzeCraft - errors", () => {
  it("rejects a zero ratio rather than dividing by it", () => {
    const r = analyze({ recipe: { ...RECIPE, ratio: 0 } });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("zero-ratio");
  });

  /**
   * An item with no resting buy orders has bid 0. model.py drops such points during
   * normalization; we keep them in D1 as real history and reject here instead, because a
   * row reading "Infinity%" on the scan page is worse than an absent row.
   */
  it("rejects a zero cost basis - an item with no buy orders at all", () => {
    const noBids = statsOf(
      constantSeries(24, {
        askAvg: 10,
        askMin: 10,
        askMax: 10,
        bidAvg: 0,
        bidMin: 0,
        bidMax: 0,
        askDepth: 500_000,
        bidDepth: 0,
        ibWeek: 3_500_000,
        isWeek: 7_000_000,
      }),
    );
    const r = analyze({ base: noBids });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("zero-price");
  });

  it("refuses to compare series covering different windows", () => {
    const shifted = statsOf(
      constantSeries(
        24,
        {
          askAvg: 1800,
          askMin: 1800,
          askMax: 1800,
          bidAvg: 1700,
          bidMin: 1700,
          bidMax: 1700,
          askDepth: 50_000,
          bidDepth: 30_000,
          ibWeek: 700_000,
          isWeek: 350_000,
        },
        1_000_000,
      ),
    );
    const r = analyze({ product: shifted });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("incomparable-windows");
  });
});
