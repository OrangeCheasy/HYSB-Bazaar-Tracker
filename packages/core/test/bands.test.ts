import { describe, expect, it } from "vitest";
import {
  bandEconomics,
  computeBand,
  DEFAULT_HIGH_PERCENTILE,
  DEFAULT_LOW_PERCENTILE,
  type BandInputs,
} from "../src/bands.js";
import type { Bar } from "../src/sides.js";

const HOUR = 3600;
const NOW = 1_800_000_000;

function bar(tsOffsetHours: number, over: Partial<Bar> = {}): Bar {
  return {
    ts: NOW - tsOffsetHours * HOUR,
    intervalSeconds: HOUR,
    askAvg: 200,
    askMin: 195,
    askMax: 205,
    bidAvg: 100,
    bidMin: 95,
    bidMax: 105,
    askDepth: 1000,
    bidDepth: 1000,
    ibWeek: 50_000,
    isWeek: 50_000,
    samples: 12,
    source: "hypixel",
    ...over,
  };
}

/** 168 hours of clearly separated sides: bid near 100, ask near 200. */
function separatedWeek(): Bar[] {
  return Array.from({ length: 168 }, (_, i) =>
    bar(i, {
      bidAvg: 100 + (i % 20),
      bidMin: 95 + (i % 20),
      bidMax: 105 + (i % 20),
      askAvg: 200 + (i % 20),
      askMin: 195 + (i % 20),
      askMax: 205 + (i % 20),
    }),
  );
}

/**
 * THE LOAD-BEARING TEST.
 *
 * A buy order competes at the BID and a sell offer competes at the ASK (CLAUDE.md
 * section 1). Deriving the low band from the ask side, or the high band from the bid
 * side, inverts the whole strategy: it produces a "buy" price above the "sell" price, so
 * every order it suggests either never fills or fills at a guaranteed loss.
 *
 * The fixture separates the sides by 100 coins precisely so a flip cannot hide inside
 * noise — get it backwards and the bands cross, which is arithmetically impossible for a
 * correct implementation because ask > bid always holds (section 1).
 */
describe("sides — the buy band comes from bid, the sell band from ask", () => {
  it("puts the buy band in the bid range and the sell band in the ask range", () => {
    const result = computeBand({ bars: separatedWeek(), asOf: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { buyBand, sellBand } = result.value;

    // Bid side spans 100-119; ask side spans 200-219. No overlap, by construction.
    expect(buyBand).toBeGreaterThanOrEqual(100);
    expect(buyBand).toBeLessThan(120);
    expect(sellBand).toBeGreaterThanOrEqual(200);
    expect(sellBand).toBeLessThan(220);
  });

  it("never returns a crossed band", () => {
    const result = computeBand({ bars: separatedWeek(), asOf: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buyBand).toBeLessThan(result.value.sellBand);
    expect(result.value.spread).toBeGreaterThan(0);
  });

  /**
   * The inversion, stated as arithmetic rather than as a vibe. If the bands were taken
   * from the wrong sides the buy band would land near 218 (p90 of ask) and the sell band
   * near 101 (p10 of bid) — buy high, sell low. This asserts the real output is nowhere
   * near that, so a future flip fails here loudly instead of shipping quietly.
   */
  it("is nowhere near the inverted result", () => {
    const result = computeBand({ bars: separatedWeek(), asOf: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const invertedBuy = 218; // what p90-of-ask would give
    const invertedSell = 101; // what p10-of-bid would give
    expect(Math.abs(result.value.buyBand - invertedBuy)).toBeGreaterThan(50);
    expect(Math.abs(result.value.sellBand - invertedSell)).toBeGreaterThan(50);
  });

  /** Rejected rather than returned: a crossed band is not a degraded answer, it is a
   *  wrong one, and returning it would let a caller place losing orders. */
  it("refuses to return a band when the input itself is crossed", () => {
    const crossed = Array.from({ length: 168 }, (_, i) =>
      bar(i, { bidAvg: 300, bidMin: 295, bidMax: 305, askAvg: 100, askMin: 95, askMax: 105 }),
    );
    const result = computeBand({ bars: crossed, asOf: NOW });
    expect(result).toEqual({ ok: false, error: "crossed-band" });
  });
});

describe("percentiles, not min/max", () => {
  /**
   * A single five-minute wick is not a transactable price. One absurd outlier hour must
   * barely move a p10/p90 band — if it does move it, the implementation is really taking
   * MIN/MAX and will hand out orders that never fill.
   */
  it("ignores a single extreme outlier", () => {
    const clean = separatedWeek();
    const withWick = [...clean];
    withWick[0] = bar(0, {
      bidAvg: 1,
      bidMin: 1,
      bidMax: 1,
      askAvg: 99_999,
      askMin: 99_999,
      askMax: 99_999,
    });

    const a = computeBand({ bars: clean, asOf: NOW });
    const b = computeBand({ bars: withWick, asOf: NOW });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(Math.abs(a.value.buyBand - b.value.buyBand)).toBeLessThan(5);
    expect(Math.abs(a.value.sellBand - b.value.sellBand)).toBeLessThan(5);
  });

  it("exposes the percentiles as inputs with the documented defaults", () => {
    expect(DEFAULT_LOW_PERCENTILE).toBe(0.1);
    expect(DEFAULT_HIGH_PERCENTILE).toBe(0.9);
  });

  it("widens the band as the percentiles move outward", () => {
    const bars = separatedWeek();
    const tight = computeBand({ bars, asOf: NOW, lowPercentile: 0.4, highPercentile: 0.6 });
    const wide = computeBand({ bars, asOf: NOW, lowPercentile: 0.02, highPercentile: 0.98 });
    expect(tight.ok && wide.ok).toBe(true);
    if (!tight.ok || !wide.ok) return;

    expect(wide.value.buyBand).toBeLessThan(tight.value.buyBand);
    expect(wide.value.sellBand).toBeGreaterThan(tight.value.sellBand);
  });

  it.each([
    [-0.1, 0.9],
    [0.1, 1.5],
    [0.9, 0.1], // low above high
    [Number.NaN, 0.9],
  ])("rejects percentiles (%s, %s)", (lo, hi) => {
    const result = computeBand({
      bars: separatedWeek(),
      asOf: NOW,
      lowPercentile: lo,
      highPercentile: hi,
    });
    expect(result).toEqual({ ok: false, error: "invalid-percentile" });
  });
});

describe("hit-rate — a band without one is not shippable", () => {
  /**
   * By construction a p10 buy order sits unfilled most of the time. The band is only a
   * trade if price actually visits it, so the hit-rate is the fill-feasibility number
   * that non-negotiable #6 requires next to every band.
   */
  it("counts hours whose bid actually reached the buy band", () => {
    // 100 hours where the bid dips to 50, 68 where it never goes below 200.
    const bars = [
      ...Array.from({ length: 100 }, (_, i) => bar(i, { bidAvg: 100, bidMin: 50 })),
      ...Array.from({ length: 68 }, (_, i) => bar(100 + i, { bidAvg: 100, bidMin: 200 })),
    ];
    const result = computeBand({ bars, asOf: NOW, lowPercentile: 0.5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Buy band is p50 of bidAvg = 100. Only the 100 bars whose bidMin (50) reached it hit.
    expect(result.value.buyHits.hoursTouched).toBe(100);
    expect(result.value.buyHits.hoursTotal).toBe(168);
    expect(result.value.buyHits.rate).toBeCloseTo(100 / 168, 5);
  });

  it("counts hours whose ask actually reached the sell band", () => {
    const bars = [
      ...Array.from({ length: 40 }, (_, i) => bar(i, { askAvg: 200, askMax: 9999 })),
      ...Array.from({ length: 128 }, (_, i) => bar(40 + i, { askAvg: 200, askMax: 1 })),
    ];
    const result = computeBand({ bars, asOf: NOW, highPercentile: 0.5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sellHits.hoursTouched).toBe(40);
  });

  /**
   * Uses bidMin/askMax for TOUCHING while the band itself uses percentiles of the
   * averages. Both are correct and the distinction matters: the band is a price you can
   * realistically rest an order at, but whether it filled is a question about the extreme
   * the hour actually reached.
   */
  it("uses the hour's extreme to decide a touch, not its average", () => {
    // bidAvg never goes below 100, but bidMin dips to 10 — the order would have filled.
    const bars = Array.from({ length: 168 }, (_, i) => bar(i, { bidAvg: 100, bidMin: 10 }));
    const result = computeBand({ bars, asOf: NOW, lowPercentile: 0.5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buyHits.hoursTouched).toBe(168);
  });
});

describe("week count — small n must be visible", () => {
  /** The 30-day retention cap means this can never exceed 4 (CLAUDE.md section 8), so any
   *  multi-week claim has to show the n it rests on. */
  it("reports how many distinct weeks the window covers", () => {
    const fourWeeks = Array.from({ length: 28 * 24 }, (_, i) => bar(i));
    const result = computeBand({ bars: fourWeeks, asOf: NOW, windowDays: 28 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.weekCount).toBe(4);
  });

  it("reports a single week for a 7-day window", () => {
    const result = computeBand({ bars: separatedWeek(), asOf: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.weekCount).toBe(1);
  });

  it("counts weeks where BOTH bands were touched", () => {
    // Week 0: both sides reach. Week 1: only the buy side does.
    const weekBoth = Array.from({ length: 168 }, (_, i) =>
      bar(i, { bidMin: 1, askMax: 99_999 }),
    );
    const weekBuyOnly = Array.from({ length: 168 }, (_, i) =>
      bar(168 + i, { bidMin: 1, askMax: 1 }),
    );
    const result = computeBand({
      bars: [...weekBoth, ...weekBuyOnly],
      asOf: NOW,
      windowDays: 14,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.weekCount).toBe(2);
    expect(result.value.bothHitWeeks).toBe(1);
  });

  it("flags a window resting on fewer than four weeks", () => {
    const result = computeBand({ bars: separatedWeek(), asOf: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.flags).toContain("short-history");
  });
});

describe("guards", () => {
  it("rejects an empty series", () => {
    expect(computeBand({ bars: [], asOf: NOW })).toEqual({ ok: false, error: "no-bars" });
  });

  it("rejects a window too thin to say anything", () => {
    const result = computeBand({ bars: [bar(0), bar(1)], asOf: NOW });
    expect(result).toEqual({ ok: false, error: "insufficient-data" });
  });

  it("ignores bars outside the requested window", () => {
    const inside = separatedWeek();
    const ancient = Array.from({ length: 50 }, (_, i) =>
      bar(1000 + i, { bidAvg: 1, bidMin: 1, askAvg: 99_999, askMax: 99_999 }),
    );
    const result = computeBand({ bars: [...inside, ...ancient], asOf: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buyHits.hoursTotal).toBe(168);
  });

  it("flags a band built from thin hourly samples", () => {
    const thin = Array.from({ length: 168 }, (_, i) => bar(i, { samples: 2 }));
    const result = computeBand({ bars: thin, asOf: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.flags).toContain("thin-samples");
  });
});

describe("week bucketing at the window boundary", () => {
  /**
   * Regression. `sliceWindow` includes a bar sitting exactly on `asOf - windowDays`, and
   * that timestamp divides to exactly 1.0 week — opening a second bucket holding one
   * hour, so a 7-day window reported TWO weeks. weekCount is the n behind every
   * multi-week claim, so inflating it overstates the evidence.
   */
  it("reports one week when a bar lands exactly on the 7-day edge", () => {
    const bars = Array.from({ length: 168 }, (_, i) => bar(i + 1)); // oldest is exactly -168h
    const result = computeBand({ bars, asOf: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.weekCount).toBe(1);
  });

  it("never reports more weeks than the window spans", () => {
    for (const windowDays of [7, 14, 21, 28]) {
      const bars = Array.from({ length: windowDays * 24 }, (_, i) => bar(i + 1));
      const result = computeBand({ bars, asOf: NOW, windowDays });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.weekCount).toBeLessThanOrEqual(Math.ceil(windowDays / 7));
    }
  });
});

describe("band economics — what ranks best to worst", () => {
  const MARKET = { sellTaxRate: 0.0125, captureFraction: 0.2 };

  function bandFrom(bars: Bar[], over: Partial<BandInputs> = {}) {
    const r = computeBand({ bars, asOf: NOW, ...over });
    if (!r.ok) throw new Error(`band failed: ${r.error}`);
    return r.value;
  }

  /** Tax lands on the sell offer only, never on the buy (CLAUDE.md section 8). */
  it("taxes the sell side only", () => {
    const band = bandFrom(separatedWeek());
    const e = bandEconomics(band, { ibWeek: 70_000, isWeek: 70_000 }, MARKET);

    expect(e.taxPerUnit).toBeCloseTo(band.sellBand * 0.0125, 6);
    expect(e.grossPerUnit).toBeCloseTo(band.sellBand - band.buyBand, 6);
    expect(e.netPerUnit).toBeCloseTo(e.grossPerUnit - e.taxPerUnit, 6);
    expect(e.capitalPerUnit).toBe(band.buyBand);
  });

  /**
   * The headline rule. Identical bands, different volume — the liquid one has to win, or
   * the ranking is by spread and CLAUDE.md section 8 is being violated.
   */
  it("ranks a liquid tag above an illiquid one with the same spread", () => {
    const band = bandFrom(separatedWeek());
    const liquid = bandEconomics(band, { ibWeek: 500_000, isWeek: 500_000 }, MARKET);
    const thin = bandEconomics(band, { ibWeek: 500, isWeek: 500 }, MARKET);

    expect(liquid.netPerUnit).toBeCloseTo(thin.netPerUnit, 6); // same spread
    expect(liquid.profitPerDay).toBeGreaterThan(thin.profitPerDay * 100);
  });

  /** Both legs must clear, so the binding side is the smaller flow. */
  it("takes the smaller of the two flows", () => {
    const band = bandFrom(separatedWeek());
    const a = bandEconomics(band, { ibWeek: 700, isWeek: 70_000 }, MARKET);
    const b = bandEconomics(band, { ibWeek: 70_000, isWeek: 700 }, MARKET);
    expect(a.throughput.marketUnitsPerDay).toBeCloseTo(100, 6);
    expect(a.profitPerDay).toBeCloseTo(b.profitPerDay, 6);
  });

  /**
   * The haircut that stops a band being sold as passive income. A spread nobody's order
   * ever reaches is worth zero per day, no matter how wide it looks.
   */
  it("scales profit by the limiting hit-rate, and zeroes an untouched band", () => {
    const touched = Array.from({ length: 168 }, (_, i) =>
      bar(i, { bidMin: 1, askMax: 99_999 }),
    );
    const untouched = Array.from({ length: 168 }, (_, i) =>
      bar(i, { bidMin: 99_999, askMax: 1 }),
    );
    const vol = { ibWeek: 70_000, isWeek: 70_000 };

    const hot = bandEconomics(bandFrom(touched), vol, MARKET);
    const cold = bandEconomics(bandFrom(untouched), vol, MARKET);

    expect(hot.profitPerDay).toBeGreaterThan(0);
    expect(cold.throughput.unitsPerDay).toBe(0);
    expect(cold.profitPerDay).toBe(0);
  });

  /**
   * The names are inverted from intuition in the same way the raw bazaar fields are, so
   * both directions are pinned here rather than left to be re-derived:
   *
   *   ibWeek — units instant-BOUGHT by others — is the flow that fills YOUR SELL OFFERS
   *   isWeek — units instant-SOLD by others   — is the flow that fills YOUR BUY ORDERS
   *
   * So a small `ibWeek` means you cannot get rid of stock, which is a sell-side limit.
   */
  it("names what bound the throughput, in both directions", () => {
    const band = bandFrom(
      Array.from({ length: 168 }, (_, i) => bar(i, { bidMin: 1, askMax: 99_999 })),
    );
    expect(
      bandEconomics(band, { ibWeek: 700, isWeek: 70_000 }, MARKET).throughput.limitedBy,
    ).toBe("sell-side-flow");
    expect(
      bandEconomics(band, { ibWeek: 70_000, isWeek: 700 }, MARKET).throughput.limitedBy,
    ).toBe("buy-side-flow");
  });

  it("reports a negative net when the tax eats the spread", () => {
    const narrow = Array.from({ length: 168 }, (_, i) =>
      bar(i, { bidAvg: 1000, bidMin: 1000, askAvg: 1001, askMax: 1001 }),
    );
    const e = bandEconomics(bandFrom(narrow), { ibWeek: 70_000, isWeek: 70_000 }, MARKET);
    expect(e.netPerUnit).toBeLessThan(0);
    expect(e.profitPerDay).toBeLessThan(0);
  });
});
