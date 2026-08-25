import { describe, expect, it } from "vitest";
import { aggregateBars } from "../src/sides.js";
import { makeBar } from "./helpers.js";

const DAY = 86_400;

describe("aggregateBars", () => {
  it("returns an empty array for no bars", () => {
    expect(aggregateBars([], DAY)).toEqual([]);
  });

  it("returns an empty array for a non-positive interval", () => {
    expect(aggregateBars([makeBar()], 0)).toEqual([]);
  });

  it("widens a single bar unchanged, apart from the new interval length", () => {
    const bar = makeBar({ ts: 0, samples: 12 });
    const [out] = aggregateBars([bar], DAY);
    expect(out).toMatchObject({
      askAvg: bar.askAvg,
      askMin: bar.askMin,
      askMax: bar.askMax,
      samples: 12,
      intervalSeconds: DAY,
    });
  });

  // The load-bearing one: an hour built from 2 snapshots must not out-vote one built
  // from 12. A flat mean of askAvg values would give both hours equal weight; this must
  // weight by each bar's own samples count.
  it("weights the merged average by each bar's samples, not a flat mean", () => {
    const thin = makeBar({ ts: 0, askAvg: 100, bidAvg: 90, samples: 2 });
    const full = makeBar({ ts: 3600, askAvg: 200, bidAvg: 190, samples: 12 });
    const [out] = aggregateBars([thin, full], DAY);
    // (100*2 + 200*12) / 14 = 185.71..., NOT (100+200)/2 = 150
    expect(out!.askAvg).toBeCloseTo((100 * 2 + 200 * 12) / 14, 10);
    expect(out!.bidAvg).toBeCloseTo((90 * 2 + 190 * 12) / 14, 10);
    expect(out!.samples).toBe(14);
  });

  it("takes true min/max across bars, never the average of each bar's own min/max", () => {
    const low = makeBar({ ts: 0, askMin: 5, askMax: 50, bidMin: 4, bidMax: 40 });
    const high = makeBar({ ts: 3600, askMin: 60, askMax: 500, bidMin: 45, bidMax: 400 });
    const [out] = aggregateBars([low, high], DAY);
    expect(out!.askMin).toBe(5);
    expect(out!.askMax).toBe(500);
    expect(out!.bidMin).toBe(4);
    expect(out!.bidMax).toBe(400);
  });

  it("takes ibWeek/isWeek from the LAST bar by ts, not a sum or average", () => {
    const bars = [
      makeBar({ ts: 3600, ibWeek: 1000, isWeek: 900 }),
      makeBar({ ts: 0, ibWeek: 5000, isWeek: 4000 }), // unordered input on purpose
      makeBar({ ts: 7200, ibWeek: 3000, isWeek: 2500 }), // this one is last by ts
    ];
    const [out] = aggregateBars(bars, DAY);
    expect(out!.ibWeek).toBe(3000);
    expect(out!.isWeek).toBe(2500);
  });

  it("buckets by the interval boundary and sorts buckets ascending", () => {
    const today = makeBar({ ts: 0 });
    const tomorrow = makeBar({ ts: DAY });
    const [first, second] = aggregateBars([tomorrow, today], DAY); // reverse input order
    expect(first!.ts).toBe(0);
    expect(second!.ts).toBe(DAY);
  });

  it("labels the merge 'hypixel' if any input bar is hypixel-sourced", () => {
    const [out] = aggregateBars(
      [makeBar({ ts: 0, source: "coflnet" }), makeBar({ ts: 3600, source: "hypixel" })],
      DAY,
    );
    expect(out!.source).toBe("hypixel");
  });

  it("labels the merge 'coflnet' only when every input bar is coflnet-sourced", () => {
    const [out] = aggregateBars(
      [makeBar({ ts: 0, source: "coflnet" }), makeBar({ ts: 3600, source: "coflnet" })],
      DAY,
    );
    expect(out!.source).toBe("coflnet");
  });
});
