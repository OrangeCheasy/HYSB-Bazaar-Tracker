import { describe, expect, it } from "vitest";
import {
  computeStats,
  mid,
  sliceWindow,
  spread,
  spreadPct,
  mean,
  stdev,
  percentile,
} from "../src/stats.js";
import { constantSeries, makeBar } from "./helpers.js";

describe("per-bar helpers", () => {
  const b = makeBar({ askAvg: 11, bidAvg: 9 });

  it("computes mid, spread and spread percent", () => {
    expect(mid(b)).toBe(10);
    expect(spread(b)).toBe(2);
    expect(spreadPct(b)).toBe(0.2);
  });

  it("returns zero spread percent for a zero-priced book rather than NaN", () => {
    expect(spreadPct(makeBar({ askAvg: 0, bidAvg: 0 }))).toBe(0);
  });
});

describe("computeStats", () => {
  it("rejects an empty series", () => {
    const r = computeStats([]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("empty-series");
  });

  // Edge case: a single point.
  it("handles a single bar - volatility is zero, not NaN", () => {
    const r = computeStats([makeBar({ askAvg: 10, bidAvg: 9, ibWeek: 700, isWeek: 1400 })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value;
    expect(s.n).toBe(1);
    expect(s.from).toBe(0);
    expect(s.to).toBe(0);
    expect(s.askMean).toBe(10);
    expect(s.bidMean).toBe(9);
    expect(s.midMean).toBe(9.5);
    expect(s.volatility).toBe(0);
    expect(s.coverage).toBe(1);
    expect(s.ibPerDay).toBe(100);
    expect(s.isPerDay).toBe(200);
  });

  it("distinguishes avg-low/avg-high from absolute floor/ceiling", () => {
    // Two bars. Typical low is the MEAN of the per-bar lows; the floor is the WORST low.
    //   askMin: 9 and 5  -> askAvgLow = 7, askFloor = 5
    //   askMax: 11 and 21 -> askAvgHigh = 16, askCeiling = 21
    const bars = [
      makeBar({ ts: 0, askAvg: 10, askMin: 9, askMax: 11, bidAvg: 8, bidMin: 7, bidMax: 9 }),
      makeBar({
        ts: 3600,
        askAvg: 12,
        askMin: 5,
        askMax: 21,
        bidAvg: 10,
        bidMin: 3,
        bidMax: 15,
      }),
    ];
    const r = computeStats(bars);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.askAvgLow).toBe(7);
    expect(r.value.askAvgHigh).toBe(16);
    expect(r.value.askFloor).toBe(5);
    expect(r.value.askCeiling).toBe(21);
    expect(r.value.bidAvgLow).toBe(5);
    expect(r.value.bidAvgHigh).toBe(12);
    expect(r.value.bidFloor).toBe(3);
    expect(r.value.bidCeiling).toBe(15);
  });

  it("computes volatility as population stdev over mean of mid", () => {
    // mids: 10 and 20 -> mean 15, population stdev 5 -> volatility 5/15 = 0.3333...
    const bars = [
      makeBar({ ts: 0, askAvg: 10, bidAvg: 10 }),
      makeBar({ ts: 3600, askAvg: 20, bidAvg: 20 }),
    ];
    const r = computeStats(bars);
    expect(r.ok && r.value.volatility).toBeCloseTo(1 / 3, 12);
  });

  it("derives flow rates by dividing the trailing-week counters by seven", () => {
    const r = computeStats(constantSeries(4, { ibWeek: 7_000_000, isWeek: 14_000_000 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ibPerDay).toBe(1_000_000);
    expect(r.value.isPerDay).toBe(2_000_000);
  });

  // Edge case: zero volume (a dead item).
  it("survives a dead item with zero volume and zero flow", () => {
    const r = computeStats(
      constantSeries(3, { askDepth: 0, bidDepth: 0, ibWeek: 0, isWeek: 0 }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ibPerDay).toBe(0);
    expect(r.value.isPerDay).toBe(0);
    expect(r.value.askDepthMean).toBe(0);
    expect(r.value.bidDepthMean).toBe(0);
  });

  it("rejects a series whose mid price is zero rather than dividing by it", () => {
    const r = computeStats(
      constantSeries(3, { askAvg: 0, askMin: 0, askMax: 0, bidAvg: 0, bidMin: 0, bidMax: 0 }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("zero-mean-price");
  });

  // Edge case: ask == bid.
  it("reports zero spread for a tied book", () => {
    const r = computeStats(
      constantSeries(3, { askAvg: 7, askMin: 7, askMax: 7, bidAvg: 7, bidMin: 7, bidMax: 7 }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spreadMean).toBe(0);
    expect(r.value.spreadPctMean).toBe(0);
  });

  it("reports coverage below one when bars are missing from the span", () => {
    // Bars at 0, 3600 and 10800: four hourly slots expected, three present.
    const bars = [makeBar({ ts: 0 }), makeBar({ ts: 3600 }), makeBar({ ts: 10_800 })];
    const r = computeStats(bars);
    expect(r.ok && r.value.coverage).toBeCloseTo(0.75, 12);
  });

  it("clamps coverage at one when bars are denser than the nominal interval", () => {
    const bars = [makeBar({ ts: 0 }), makeBar({ ts: 60 }), makeBar({ ts: 120 })];
    expect(computeStats(bars).ok && computeStats(bars)).toBeTruthy();
    const r = computeStats(bars);
    expect(r.ok && r.value.coverage).toBe(1);
  });

  it("sorts an unordered series before reporting from/to", () => {
    const bars = [makeBar({ ts: 7200 }), makeBar({ ts: 0 }), makeBar({ ts: 3600 })];
    const r = computeStats(bars);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.from).toBe(0);
    expect(r.value.to).toBe(7200);
  });
});

describe("sliceWindow", () => {
  const bars = constantSeries(5);

  it("keeps bars inside the inclusive range", () => {
    expect(sliceWindow(bars, 3600, 10_800).map((b) => b.ts)).toEqual([3600, 7200, 10_800]);
  });

  it("returns empty when the range excludes everything", () => {
    expect(sliceWindow(bars, 100_000, 200_000)).toEqual([]);
  });
});

describe("numeric helpers", () => {
  it("returns undefined for the mean and stdev of nothing", () => {
    expect(mean([])).toBeUndefined();
    expect(stdev([])).toBeUndefined();
  });

  it("reports zero stdev for a single value", () => {
    expect(stdev([5])).toBe(0);
  });

  it("interpolates percentiles and handles the bounds", () => {
    const xs = [1, 2, 3, 4];
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 1)).toBe(4);
    expect(percentile(xs, 0.5)).toBeCloseTo(2.5, 12);
  });

  it("returns undefined for the percentile of nothing", () => {
    expect(percentile([], 0.5)).toBeUndefined();
  });

  it("does not mutate the caller array when computing a percentile", () => {
    const xs = [3, 1, 2];
    percentile(xs, 0.5);
    expect(xs).toEqual([3, 1, 2]);
  });
});
