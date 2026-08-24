import { describe, expect, it } from "vitest";
import { analyzeCraft, applySellTax, type MarketConfig } from "../src/economics.js";
import type { Recipe } from "../src/recipes.js";
import { computeStats } from "../src/stats.js";
import { constantSeries } from "./helpers.js";
import type { Bar } from "../src/sides.js";
import type { Stats } from "../src/stats.js";

/**
 * KNOWN-VALUE TESTS - the arithmetic is written out in full so it can be checked by
 * hand, independently of the implementation.
 *
 * Fixture, 24 identical hourly bars per item so every mean equals the stated value:
 *
 *   COAL (base)              ask 10      bid 9
 *                            askDepth      500,000   bidDepth   1,900,000
 *                            ibWeek      3,500,000   isWeek     7,000,000
 *
 *   ENCHANTED_COAL (product) ask 1800    bid 1700
 *                            askDepth       50,000   bidDepth      30,000
 *                            ibWeek        700,000   isWeek       350,000
 *
 *   recipe ratio 160 (verified)   sell tax 1.25%   capture 10%
 *
 * Derived flow rates (trailing-week counters divided by 7):
 *   base.isPerDay    = 7,000,000 / 7 = 1,000,000   <- instant-sells that fill MY buy order
 *   base.ibPerDay    = 3,500,000 / 7 =   500,000
 *   product.ibPerDay =   700,000 / 7 =   100,000   <- instant-buys that fill MY sell offer
 *
 * THROUGHPUT
 *   baseUnitsPerDay     = 1,000,000 x 0.10 = 100,000
 *   craftsFromBase      =   100,000 / 160  =     625
 *   productUnitsPerDay  =   100,000 x 0.10 =  10,000
 *   craftsFromProduct   =                     10,000
 *   craftsPerDay        = min(625, 10,000) =     625   -> limited by base supply
 *
 * FILL FEASIBILITY
 *   buy order on base   = isPerDay / (bidDepth + ratio x craftsPerDay)
 *                       = 1,000,000 / (1,900,000 + 160 x 625)
 *                       = 1,000,000 / 2,000,000                     = 0.5
 *   sell offer on product = ibPerDay / (askDepth + craftsPerDay)
 *                       = 100,000 / (50,000 + 625) = 1.975...  -> clamped to 1.0
 *
 * SCENARIO 1 - "instant": instant-buy the base, instant-sell the product. The floor.
 *   cost    = 10 x 160                    = 1600
 *   gross   = 1700                        = 1700
 *   tax     = 1700 x 0.0125               =   21.25
 *   profit  = 1700 - 21.25 - 1600         =   78.75
 *   margin  = 78.75 / 1600                =    0.04921875   (4.921875%)
 *   feasibility                           =    1.0          (always fills)
 *
 * SCENARIO 2 - "mixed": buy order on the base, instant-sell the product.
 *   cost    = 9 x 160                     = 1440
 *   gross   = 1700
 *   tax     = 1700 x 0.0125               =   21.25
 *   profit  = 1700 - 21.25 - 1440         =  238.75
 *   margin  = 238.75 / 1440               =    0.16579861...
 *   feasibility                           =    0.5          (buy order must fill)
 *
 * SCENARIO 3 - "orders": buy order on the base, sell offer on the product.
 *   cost    = 9 x 160                     = 1440
 *   gross   = 1800
 *   tax     = 1800 x 0.0125               =   22.5
 *   profit  = 1800 - 22.5 - 1440          =  337.5
 *   margin  = 337.5 / 1440                =    0.234375      (23.4375%)
 *   feasibility = 0.5 x 1.0               =    0.5           (BOTH must fill)
 *
 * HEADLINE
 *   profitPerDay    = 337.5 x 625         = 210,937.5
 *   capitalRequired = 1440  x 625         = 900,000
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

const MARKET: MarketConfig = { sellTaxRate: 0.0125, captureFraction: 0.1 };

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
  it("has the stated flow rates and depths", () => {
    expect(BASE.isPerDay).toBe(1_000_000);
    expect(BASE.ibPerDay).toBe(500_000);
    expect(BASE.bidDepthMean).toBe(1_900_000);
    expect(BASE.askMean).toBe(10);
    expect(BASE.bidMean).toBe(9);
    expect(PRODUCT.ibPerDay).toBe(100_000);
    expect(PRODUCT.askDepthMean).toBe(50_000);
    expect(PRODUCT.askMean).toBe(1800);
    expect(PRODUCT.bidMean).toBe(1700);
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
  const r = analyze();

  it("succeeds on the fixture", () => {
    expect(r.ok).toBe(true);
  });

  it("computes the instant scenario: cost 1600, tax 21.25, profit 78.75", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value.scenarios.instant;
    expect(s.baseUnitPrice).toBe(10);
    expect(s.productUnitPrice).toBe(1700);
    expect(s.costPerCraft).toBe(1600);
    expect(s.grossPerCraft).toBe(1700);
    expect(s.taxPerCraft).toBe(21.25);
    expect(s.profitPerCraft).toBe(78.75);
    expect(s.marginPct).toBeCloseTo(0.04921875, 12);
    expect(s.fillFeasibility).toBe(1);
  });

  it("computes the mixed scenario: cost 1440, tax 21.25, profit 238.75", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value.scenarios.mixed;
    expect(s.baseUnitPrice).toBe(9);
    expect(s.productUnitPrice).toBe(1700);
    expect(s.costPerCraft).toBe(1440);
    expect(s.taxPerCraft).toBe(21.25);
    expect(s.profitPerCraft).toBe(238.75);
    expect(s.marginPct).toBeCloseTo(238.75 / 1440, 12);
    expect(s.fillFeasibility).toBeCloseTo(0.5, 12);
  });

  it("computes the orders scenario: cost 1440, tax 22.5, profit 337.5", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value.scenarios.orders;
    expect(s.baseUnitPrice).toBe(9);
    expect(s.productUnitPrice).toBe(1800);
    expect(s.costPerCraft).toBe(1440);
    expect(s.grossPerCraft).toBe(1800);
    expect(s.taxPerCraft).toBe(22.5);
    expect(s.profitPerCraft).toBe(337.5);
    expect(s.marginPct).toBeCloseTo(0.234375, 12);
    expect(s.fillFeasibility).toBeCloseTo(0.5, 12);
  });

  it("orders the three scenarios floor < mixed < orders", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { instant, mixed, orders } = r.value.scenarios;
    expect(instant.profitPerCraft).toBeLessThan(mixed.profitPerCraft);
    expect(mixed.profitPerCraft).toBeLessThan(orders.profitPerCraft);
    // ...and the feasibility runs the other way. That is the entire point.
    expect(instant.fillFeasibility).toBeGreaterThanOrEqual(orders.fillFeasibility);
  });

  it("computes throughput: 625 crafts/day, limited by base supply", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.throughput.baseUnitsPerDay).toBe(100_000);
    expect(r.value.throughput.productUnitsPerDay).toBe(10_000);
    expect(r.value.throughput.craftsPerDay).toBeCloseTo(625, 12);
    expect(r.value.throughput.limitedBy).toBe("base-supply");
  });

  it("computes profitPerDay 210937.5 and capitalRequired 900000", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.profitPerDay).toBeCloseTo(210_937.5, 6);
    expect(r.value.capitalRequired).toBeCloseTo(900_000, 6);
  });

  it("raises no flags on a healthy, verified craft", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.flags).toEqual([]);
  });
});

describe("analyzeCraft - throughput limits", () => {
  it("switches to product-demand when the product cannot absorb the crafts", () => {
    // Product ibWeek 7,000 -> ibPerDay 1,000 -> x0.10 = 100 crafts/day, below 625.
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
    expect(r.value.throughput.craftsPerDay).toBeCloseTo(100, 12);
    expect(r.value.throughput.limitedBy).toBe("product-demand");
  });

  it("caps by capital when the wallet is the binding constraint", () => {
    // 144,000 / 1440 per craft = 100 crafts, below the 625 the market would allow.
    const r = analyze({ capitalAvailable: 144_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.throughput.craftsPerDay).toBeCloseTo(100, 12);
    expect(r.value.throughput.limitedBy).toBe("capital");
    expect(r.value.capitalRequired).toBeCloseTo(144_000, 6);
  });

  it("does not cap when capital exceeds what the market allows", () => {
    const r = analyze({ capitalAvailable: 10_000_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.throughput.craftsPerDay).toBeCloseTo(625, 12);
    expect(r.value.throughput.limitedBy).toBe("base-supply");
  });

  it("scales throughput down by the hours the player is asleep", () => {
    // 8 sleeping hours -> 16/24 of the day -> 625 x 2/3 = 416.666...
    const r = analyze({
      market: { ...MARKET, sleepHours: [0, 1, 2, 3, 4, 5, 6, 7] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.throughput.craftsPerDay).toBeCloseTo((625 * 2) / 3, 9);
  });
});

describe("analyzeCraft - warning flags", () => {
  it("flags an unverified recipe", () => {
    const r = analyze({ recipe: { ...RECIPE, verified: false } });
    expect(r.ok && r.value.flags).toContain("unverified-recipe");
  });

  it("flags an implausible margin - the recipe is wrong or the item is walled", () => {
    // Product ask 10,000 against a 1,600 parity cost: a >500% margin does not happen.
    const product = statsOf(
      constantSeries(24, {
        askAvg: 10_000,
        askMin: 10_000,
        askMax: 10_000,
        bidAvg: 9_900,
        bidMin: 9_900,
        bidMax: 9_900,
        askDepth: 50_000,
        bidDepth: 30_000,
        ibWeek: 700_000,
        isWeek: 350_000,
      }),
    );
    expect(analyze({ product }).ok).toBe(true);
    const r = analyze({ product });
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

  it("flags thin volume on either side", () => {
    const thinBase = statsOf(
      constantSeries(24, {
        askAvg: 10,
        askMin: 10,
        askMax: 10,
        bidAvg: 9,
        bidMin: 9,
        bidMax: 9,
        askDepth: 500,
        bidDepth: 500,
        ibWeek: 700,
        isWeek: 700,
      }),
    );
    const r = analyze({ base: thinBase });
    expect(r.ok && r.value.flags).toContain("thin-base-volume");
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

describe("analyzeCraft - errors", () => {
  it("rejects a zero ratio rather than dividing by it", () => {
    const r = analyze({ recipe: { ...RECIPE, ratio: 0 } });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("zero-ratio");
  });

  /**
   * An item with no resting buy orders has bid 0. Both order-based scenarios then have
   * a zero cost basis and an infinite margin. Erroring is deliberate: a margin of
   * Infinity on the scan page is worse than an absent row.
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
