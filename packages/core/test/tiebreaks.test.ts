import { describe, expect, it } from "vitest";
import { deriveBarSides, type RawBarSide } from "../src/sides.js";
import { analyzeCraft } from "../src/economics.js";
import { computeHourProfile } from "../src/profile.js";
import { computeStats, percentile } from "../src/stats.js";
import { constantSeries, makeBar } from "./helpers.js";
import type { Recipe } from "../src/recipes.js";
import type { Stats } from "../src/stats.js";

/**
 * The tiebreak ladder in compareBarSides exists so a book whose two sides are identical
 * on price still resolves to the same ask/bid regardless of which upstream field each
 * side arrived in. Every rung needs its own test, because a rung that is never exercised
 * is a rung that can be deleted by accident without any test going red.
 */
describe("deriveBarSides tiebreak ladder", () => {
  const side = (over: Partial<RawBarSide>): RawBarSide => ({
    avg: 10,
    min: 9,
    max: 11,
    volume: 100,
    movingWeek: 1000,
    ...over,
  });

  function bothOrders(a: RawBarSide, b: RawBarSide) {
    return [
      deriveBarSides(0, 3600, 1, "hypixel", a, b),
      deriveBarSides(0, 3600, 1, "hypixel", b, a),
    ] as const;
  }

  it("breaks a tied average on the higher max", () => {
    const [x, y] = bothOrders(side({ max: 12 }), side({ max: 11 }));
    expect(x.askMax).toBe(12);
    expect(y).toEqual(x);
  });

  it("breaks a tied average and max on the higher min", () => {
    const [x, y] = bothOrders(side({ min: 9.5 }), side({ min: 9 }));
    expect(x.askMin).toBe(9.5);
    expect(y).toEqual(x);
  });

  it("breaks a tied price triple on the larger volume", () => {
    const [x, y] = bothOrders(side({ volume: 500 }), side({ volume: 100 }));
    expect(x.askDepth).toBe(500);
    expect(y).toEqual(x);
  });

  it("breaks a fully tied book on the larger moving week", () => {
    const [x, y] = bothOrders(side({ movingWeek: 9000 }), side({ movingWeek: 1000 }));
    expect(x.ibWeek).toBe(9000);
    expect(y).toEqual(x);
  });

  it("is stable for two genuinely identical sides", () => {
    const [x, y] = bothOrders(side({}), side({}));
    expect(y).toEqual(x);
  });
});

describe("hour bucketing below the epoch", () => {
  it("uses a non-negative modulo so pre-1970 timestamps do not index out of range", () => {
    // -3600 is 1969-12-31T23:00:00Z, i.e. hour 23 — not hour -1.
    const r = computeHourProfile([makeBar({ ts: -3600 })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.buckets[23]?.samples).toBe(1);
    expect(r.value.buckets.every((b) => b.hour >= 0 && b.hour <= 23)).toBe(true);
  });
});

describe("percentile clamping", () => {
  it("clamps q outside [0, 1] rather than reading past the array", () => {
    expect(percentile([1, 2, 3], -5)).toBe(1);
    expect(percentile([1, 2, 3], 5)).toBe(3);
  });
});

describe("fill feasibility at the degenerate boundary", () => {
  const RECIPE: Recipe = {
    id: 1,
    baseTag: "COAL",
    enchTag: "ENCHANTED_COAL",
    ratio: 160,
    verified: true,
    note: null,
  };

  function statsOf(bars: ReturnType<typeof constantSeries>): Stats {
    const r = computeStats(bars);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  }

  /**
   * With no capture there is nothing to queue behind and nothing to place, so the
   * denominator is zero. Feasibility must fall back to "the flow exists, so an
   * infinitesimal order fills" rather than dividing by zero.
   */
  it("returns 1 when there is flow but an empty queue and no size to place", () => {
    const base = statsOf(
      constantSeries(24, {
        askAvg: 10,
        askMin: 10,
        askMax: 10,
        bidAvg: 9,
        bidMin: 9,
        bidMax: 9,
        askDepth: 0,
        bidDepth: 0,
        ibWeek: 3_500_000,
        isWeek: 7_000_000,
      }),
    );
    const product = statsOf(
      constantSeries(24, {
        askAvg: 1800,
        askMin: 1800,
        askMax: 1800,
        bidAvg: 1700,
        bidMin: 1700,
        bidMax: 1700,
        askDepth: 0,
        bidDepth: 0,
        ibWeek: 700_000,
        isWeek: 350_000,
      }),
    );

    const r = analyzeCraft({
      recipe: RECIPE,
      base,
      product,
      market: { sellTaxRate: 0.0125, captureFraction: 0, tick: 0.1 },
      asOf: base.to,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.throughput.craftsPerDay).toBe(0);
    expect(r.value.scenarios.orders.fillFeasibility).toBe(1);
    expect(r.value.flags).toContain("single-sided-book");
  });

  it("returns 0 when there is neither flow nor a queue", () => {
    const dead = statsOf(
      constantSeries(24, {
        askAvg: 10,
        askMin: 10,
        askMax: 10,
        bidAvg: 9,
        bidMin: 9,
        bidMax: 9,
        askDepth: 0,
        bidDepth: 0,
        ibWeek: 0,
        isWeek: 0,
      }),
    );
    const product = statsOf(
      constantSeries(24, {
        askAvg: 1800,
        askMin: 1800,
        askMax: 1800,
        bidAvg: 1700,
        bidMin: 1700,
        bidMax: 1700,
        askDepth: 0,
        bidDepth: 0,
        ibWeek: 0,
        isWeek: 0,
      }),
    );

    const r = analyzeCraft({
      recipe: RECIPE,
      base: dead,
      product,
      market: { sellTaxRate: 0.0125, captureFraction: 0.1, tick: 0.1 },
      asOf: dead.to,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scenarios.orders.fillFeasibility).toBe(0);
    expect(r.value.scenarios.timed.fillFeasibility).toBe(0);
    expect(r.value.flags).toContain("product-rarely-instant-bought");
    expect(r.value.flags).toContain("slow-fill");
  });

  it("rejects a non-finite ratio the same way it rejects zero", () => {
    const base = statsOf(constantSeries(24));
    const r = analyzeCraft({
      recipe: { ...RECIPE, ratio: Number.NaN },
      base,
      product: base,
      market: { sellTaxRate: 0.0125, captureFraction: 0.1, tick: 0.1 },
      asOf: base.to,
    });
    expect(r.ok === false && r.error).toBe("zero-ratio");
  });
});
