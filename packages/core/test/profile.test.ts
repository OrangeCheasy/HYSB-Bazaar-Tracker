import { describe, expect, it } from "vitest";
import {
  bestBuyWindow,
  bestContiguousWindow,
  bestSellWindow,
  computeHourProfile,
  hourRange,
  meanOverHours,
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
    // Hour 3 is half price, hour 15 is double. The baseline is the mean of the populated
    // HOURLY means; every hour here has the same sample count, so it equals 245/24.
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

  /**
   * Coflnet coarsens history the further back you go, so a 30-day backfill legitimately
   * leaves half the hour slots empty. Requiring every hour in a window to be populated
   * returns nothing at all on that data, which is worse than returning a partial answer
   * that says it is partial — hence `hoursPresent`. Matches model.py `best_window`.
   */
  it("scores a window on the hours it does have, and reports how many", () => {
    // Every other hour populated, priced flat.
    const bars = Array.from({ length: 12 }, (_, i) => makeBar({ ts: i * 2 * 3600 }));
    const r = computeHourProfile(bars);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = bestBuyWindow(r.value, 4);
    expect(w).toBeDefined();
    expect(w?.lengthHours).toBe(4);
    expect(w?.hoursPresent).toBe(2);
  });

  it("reports a full count when every hour of the window has data", () => {
    const r = computeHourProfile(daysOfHours(2, (h) => (h >= 2 && h <= 4 ? 6 : 10)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = bestBuyWindow(r.value, 3);
    expect(w?.startHour).toBe(2);
    expect(w?.hoursPresent).toBe(3);
  });

  it("returns undefined when fewer than half the window's hours have data", () => {
    // One populated hour cannot carry a 5-hour window, which needs at least two.
    const r = computeHourProfile([makeBar({ ts: 0 })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(bestBuyWindow(r.value, 5)).toBeUndefined();
    // ...but a 2-hour window needs only one, so that one still scores.
    expect(bestBuyWindow(r.value, 2)?.hoursPresent).toBe(1);
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

describe("hourRange", () => {
  /**
   * config.json defaults sleep_window to "23-07": the hours a buy order sits unattended.
   * That window wraps midnight, which is exactly why it is expressed as a range and not
   * a start plus a length.
   */
  it("builds the default overnight window, wrapping past midnight", () => {
    expect(hourRange(23, 7)).toEqual([23, 0, 1, 2, 3, 4, 5, 6]);
  });

  it("builds a same-day window", () => {
    expect(hourRange(9, 12)).toEqual([9, 10, 11]);
  });

  it("treats a start equal to the end as the whole day, not an empty window", () => {
    expect(hourRange(23, 23)).toHaveLength(24);
    expect(hourRange(0, 0)).toHaveLength(24);
  });

  it("normalizes out-of-range and fractional inputs", () => {
    expect(hourRange(25, 27)).toEqual([1, 2]);
    expect(hourRange(-1, 1)).toEqual([23, 0]);
    expect(hourRange(9.7, 11.2)).toEqual([9, 10]);
  });
});

describe("meanOverHours", () => {
  it("averages a field across the named hours, ignoring empty ones", () => {
    // Hours 0-5 populated at ask 10; hours 6+ empty.
    const r = computeHourProfile(
      Array.from({ length: 6 }, (_, h) => makeBar({ ts: h * 3600 })),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(meanOverHours(r.value, [0, 1, 2], "askMean")).toBe(10);
    // Hours 4, 5 have data; 6, 7 do not - the mean must come from the two that do.
    expect(meanOverHours(r.value, [4, 5, 6, 7], "askMean")).toBe(10);
  });

  it("weights the populated hours by their own means", () => {
    const r = computeHourProfile([
      makeBar({ ts: 0, askAvg: 10, askMin: 10, askMax: 10 }),
      makeBar({ ts: 3600, askAvg: 20, askMin: 20, askMax: 20 }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(meanOverHours(r.value, [0, 1], "askMean")).toBe(15);
    expect(meanOverHours(r.value, [0], "askMean")).toBe(10);
  });

  /**
   * Returns undefined, not 0, so the caller falls back to the current book. model.py
   * returns 0.0 and leans on `or last_bid`; 0 is a legitimate price for a dead item, so a
   * "no data" sentinel must not also be a possible answer.
   */
  it("returns undefined when none of the named hours has data", () => {
    const r = computeHourProfile([makeBar({ ts: 0 })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(meanOverHours(r.value, [5, 6, 7], "askMean")).toBeUndefined();
  });

  it("wraps out-of-range hour numbers rather than reading past the array", () => {
    const r = computeHourProfile([makeBar({ ts: 0, askAvg: 10, askMin: 10, askMax: 10 })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(meanOverHours(r.value, [24], "askMean")).toBe(10);
    expect(meanOverHours(r.value, [-24], "askMean")).toBe(10);
  });

  it("reads the overnight bid the way the craft model does", () => {
    // Bid dips to 6 during 23-02 and sits at 10 the rest of the day.
    const overnight = new Set([23, 0, 1]);
    const bars = Array.from({ length: 24 }, (_, h) => {
      const bid = overnight.has(h) ? 6 : 10;
      return makeBar({
        ts: h * 3600,
        askAvg: 12,
        askMin: 12,
        askMax: 12,
        bidAvg: bid,
        bidMin: bid,
        bidMax: bid,
      });
    });
    const r = computeHourProfile(bars);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(meanOverHours(r.value, hourRange(23, 2), "bidMean")).toBe(6);
  });
});
