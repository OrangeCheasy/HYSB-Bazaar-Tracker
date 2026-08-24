import { describe, expect, it } from "vitest";
import {
  bestBuyWindow,
  bestContiguousWindow,
  bestSellWindow,
  computeHourProfile,
} from "../src/profile.js";
import { makeBar } from "./helpers.js";
import type { Bar } from "../src/sides.js";

/**
 * Buckets are UTC. Epoch 0 is 1970-01-01T00:00:00Z, so hour = floor(ts/3600) % 24
 * with no calendar maths and no timezone database. Conversion to the reader's local
 * time happens in the browser (CLAUDE.md section 5).
 */

/** days x 24 hourly bars, with the ask price set by a per-hour shape function. */
function daysOfHours(days: number, shape: (hour: number) => number): Bar[] {
  const out: Bar[] = [];
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      const ask = shape(h);
      out.push(
        makeBar({
          ts: d * 86_400 + h * 3600,
          askAvg: ask,
          askMin: ask,
          askMax: ask,
          bidAvg: ask - 1,
          bidMin: ask - 1,
          bidMax: ask - 1,
        }),
      );
    }
  }
  return out;
}

describe("computeHourProfile", () => {
  it("rejects an empty series", () => {
    const r = computeHourProfile([]);
    expect(r.ok === false && r.error).toBe("empty-series");
  });

  it("always returns 24 buckets, flagging empty hours with a zero sample count", () => {
    const r = computeHourProfile([makeBar({ ts: 0 }), makeBar({ ts: 3600 })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.buckets).toHaveLength(24);
    expect(r.value.buckets[0]?.samples).toBe(1);
    expect(r.value.buckets[1]?.samples).toBe(1);
    expect(r.value.buckets[2]?.samples).toBe(0);
    expect(r.value.buckets.map((b) => b.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it("buckets by UTC hour of day across multiple days", () => {
    const r = computeHourProfile(daysOfHours(3, (h) => 10 + h));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.totalSamples).toBe(72);
    expect(r.value.days).toBe(3);
    expect(r.value.buckets[5]?.samples).toBe(3);
    expect(r.value.buckets[5]?.askMean).toBe(15);
  });

  it("indexes each hour against the 24h baseline, where 1.0 is average", () => {
    // Flat series: every hour must index at exactly 1.0.
    const r = computeHourProfile(daysOfHours(2, () => 10));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const b of r.value.buckets) {
      expect(b.askIndex).toBeCloseTo(1, 12);
      expect(b.bidIndex).toBeCloseTo(1, 12);
    }
  });

  it("indexes a cheap hour below one and a dear hour above one", () => {
    // Hour 3 is half price, hour 15 is double. Baseline is the mean over all bars.
    const r = computeHourProfile(daysOfHours(2, (h) => (h === 3 ? 5 : h === 15 ? 20 : 10)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cheap = r.value.buckets[3];
    const dear = r.value.buckets[15];
    expect(cheap?.askIndex).toBeLessThan(1);
    expect(dear?.askIndex).toBeGreaterThan(1);
    // baseline = (22*10 + 5 + 20)/24 = 245/24
    expect(r.value.askBaseline).toBeCloseTo(245 / 24, 12);
    expect(cheap?.askIndex).toBeCloseTo(5 / (245 / 24), 12);
  });

  it("reports zero index rather than NaN when the baseline is zero", () => {
    const r = computeHourProfile(
      daysOfHours(1, () => 1).map((b) => ({
        ...b,
        askAvg: 0,
        bidAvg: 0,
        askMin: 0,
        askMax: 0,
        bidMin: 0,
        bidMax: 0,
      })),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.buckets.every((b) => b.askIndex === 0)).toBe(true);
  });
});

describe("best window search", () => {
  it("finds the cheapest contiguous run to buy in", () => {
    // A trough at hours 2-4.
    const r = computeHourProfile(daysOfHours(3, (h) => (h >= 2 && h <= 4 ? 6 : 10)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = bestBuyWindow(r.value, 3);
    expect(w?.startHour).toBe(2);
    expect(w?.lengthHours).toBe(3);
    expect(w?.wraps).toBe(false);
    expect(w?.meanIndex).toBeLessThan(1);
  });

  it("finds the dearest contiguous run to sell in", () => {
    const r = computeHourProfile(daysOfHours(3, (h) => (h >= 18 && h <= 20 ? 14 : 10)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = bestSellWindow(r.value, 3);
    expect(w?.startHour).toBe(18);
    expect(w?.meanIndex).toBeGreaterThan(1);
  });

  /**
   * The wrap case is the common one in practice - the quiet hours of a game server
   * straddle midnight UTC. A search that cannot wrap silently reports the second-best
   * window, which is worse than reporting nothing.
   */
  it("finds a window that wraps past midnight", () => {
    const cheap = new Set([22, 23, 0, 1]);
    const r = computeHourProfile(daysOfHours(3, (h) => (cheap.has(h) ? 6 : 10)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = bestBuyWindow(r.value, 4);
    expect(w?.startHour).toBe(22);
    expect(w?.wraps).toBe(true);
    expect(w?.lengthHours).toBe(4);
  });

  it("accepts a full 24-hour window", () => {
    const r = computeHourProfile(daysOfHours(2, () => 10));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = bestBuyWindow(r.value, 24);
    expect(w?.lengthHours).toBe(24);
    expect(w?.meanIndex).toBeCloseTo(1, 12);
  });

  it("skips windows containing an hour with no data", () => {
    // Only hours 0-5 have data, so no 3-hour window may include hour 6 or later.
    const bars = Array.from({ length: 6 }, (_, h) => makeBar({ ts: h * 3600 }));
    const r = computeHourProfile(bars);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = bestBuyWindow(r.value, 3);
    expect(w).toBeDefined();
    expect(w && w.startHour + w.lengthHours).toBeLessThanOrEqual(6);
  });

  it("returns undefined when no window of that length has complete data", () => {
    const r = computeHourProfile([makeBar({ ts: 0 }), makeBar({ ts: 7200 })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(bestBuyWindow(r.value, 5)).toBeUndefined();
  });

  it("rejects out-of-range window lengths", () => {
    const r = computeHourProfile(daysOfHours(1, () => 10));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(bestContiguousWindow(r.value, 0, "min")).toBeUndefined();
    expect(bestContiguousWindow(r.value, 25, "min")).toBeUndefined();
    expect(bestContiguousWindow(r.value, 2.5, "min")).toBeUndefined();
  });
});
