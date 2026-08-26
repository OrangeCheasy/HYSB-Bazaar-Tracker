import { describe, expect, it } from "vitest";
import { bandEconomics, computeBand } from "../src/bands.js";
import { analyzeCraft } from "../src/economics.js";
import { computeStats } from "../src/stats.js";
import type { Bar } from "../src/sides.js";

/**
 * What unit each `*Pct` field is in.
 *
 * This file exists because core is NOT consistent about it, and the two conventions live
 * one file apart:
 *
 *   - `Stats.spreadPct` and `ScenarioResult.marginPct` are FRACTIONS (0.0127 = 1.27%)
 *   - `WeeklyBand.spreadPct` and `BandEconomics.marginPct` are PERCENTAGE POINTS (10.48)
 *
 * Both conventions are defensible; having both under names that differ by nothing is not.
 * The display layer nearly shipped a hundredfold error in each direction — a band spread
 * of 10.48 formatted as a fraction reads "1047.8%", which looks like a spectacular find
 * rather than a units mistake, and is exactly the class of number CLAUDE.md §8 says should
 * be disbelieved.
 *
 * Until the conventions are reconciled, these tests are the documentation: a change that
 * alters either one fails here with the convention spelled out, instead of silently
 * moving a decimal point three screens away in the UI.
 */

const HOUR = 3600;

/** A flat, well-formed series: bid 90, ask 110, so the spread is a known 20 on 110. */
function flatBars(count: number, asOf: number): Bar[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: asOf - (count - 1 - i) * HOUR,
    intervalSeconds: HOUR,
    askAvg: 110,
    askMin: 105,
    askMax: 115,
    bidAvg: 90,
    bidMin: 85,
    bidMax: 95,
    askDepth: 1000,
    bidDepth: 1000,
    ibWeek: 100_000,
    isWeek: 100_000,
    samples: 12,
    source: "hypixel" as const,
  }));
}

const ASOF = 1_700_000_000;

describe("Stats.spreadPct is a FRACTION", () => {
  it("reports (ask - bid) / ask, not a percentage", () => {
    const stats = computeStats(flatBars(48, ASOF));
    expect(stats.ok).toBe(true);
    if (!stats.ok) return;
    // (110 - 90) / 110 = 0.1818..., NOT 18.18.
    expect(stats.value.spreadPct).toBeCloseTo(0.1818, 3);
    expect(stats.value.spreadPct).toBeLessThan(1);
  });
});

describe("WeeklyBand.spreadPct is PERCENTAGE POINTS", () => {
  it("reports a number already multiplied by 100", () => {
    const band = computeBand({ bars: flatBars(168, ASOF), asOf: ASOF });
    expect(band.ok).toBe(true);
    if (!band.ok) return;

    const { buyBand, sellBand, spread, spreadPct } = band.value;
    expect(spread).toBeCloseTo(sellBand - buyBand, 6);
    // The relationship that fixes the convention: spreadPct is (spread / buyBand) * 100.
    expect(spreadPct).toBeCloseTo((spread / buyBand) * 100, 6);
    // A flat 90/110 book bands at 20 over 90, which is ~22 POINTS, not 0.22.
    expect(spreadPct).toBeGreaterThan(1);
  });
});

describe("BandEconomics.marginPct is PERCENTAGE POINTS", () => {
  it("agrees with the band's own convention", () => {
    const band = computeBand({ bars: flatBars(168, ASOF), asOf: ASOF });
    expect(band.ok).toBe(true);
    if (!band.ok) return;

    const economics = bandEconomics(
      band.value,
      { ibWeek: 100_000, isWeek: 100_000 },
      { sellTaxRate: 0.0125, captureFraction: 0.2 },
    );
    expect(economics.marginPct).toBeCloseTo(
      (economics.netPerUnit / band.value.buyBand) * 100,
      6,
    );
    // Same trade as the band above, so the same order of magnitude — points, not fraction.
    expect(Math.abs(economics.marginPct)).toBeGreaterThan(1);
  });
});

describe("ScenarioResult.marginPct is a FRACTION", () => {
  it("reports profit over cost without multiplying by 100", () => {
    const stats = computeStats(flatBars(48, ASOF));
    expect(stats.ok).toBe(true);
    if (!stats.ok) return;

    const analysis = analyzeCraft({
      recipe: {
        id: 1,
        baseTag: "COAL",
        enchTag: "ENCHANTED_COAL",
        ratio: 160,
        verified: true,
        note: null,
      },
      base: stats.value,
      product: stats.value,
      market: { sellTaxRate: 0.0125, captureFraction: 0.2, tick: 1, taxOnInstantSell: true },
      asOf: ASOF,
    });
    expect(analysis.ok).toBe(true);
    if (!analysis.ok) return;

    for (const kind of ["floor", "orders", "timed"] as const) {
      const scenario = analysis.value.scenarios[kind];
      expect(scenario.marginPct).toBeCloseTo(
        scenario.profitPerCraft / scenario.costPerCraft,
        9,
      );
      // Buying 160 coal at ~110 to sell one enchanted coal at ~110 is a catastrophic
      // loss, so this is near -1 — a fraction. As points it would be near -100.
      expect(Math.abs(scenario.marginPct)).toBeLessThanOrEqual(1.0);
    }
  });
});

describe("fillFeasibility is a FRACTION on 0..1", () => {
  it("never exceeds 1, so it is never a percentage", () => {
    const stats = computeStats(flatBars(48, ASOF));
    expect(stats.ok).toBe(true);
    if (!stats.ok) return;

    const analysis = analyzeCraft({
      recipe: {
        id: 1,
        baseTag: "COAL",
        enchTag: "ENCHANTED_COAL",
        ratio: 160,
        verified: true,
        note: null,
      },
      base: stats.value,
      product: stats.value,
      market: { sellTaxRate: 0.0125, captureFraction: 0.2, tick: 1, taxOnInstantSell: true },
      asOf: ASOF,
    });
    expect(analysis.ok).toBe(true);
    if (!analysis.ok) return;

    for (const kind of ["floor", "orders", "timed"] as const) {
      const { fillFeasibility } = analysis.value.scenarios[kind];
      expect(fillFeasibility).toBeGreaterThanOrEqual(0);
      expect(fillFeasibility).toBeLessThanOrEqual(1);
    }
  });
});
