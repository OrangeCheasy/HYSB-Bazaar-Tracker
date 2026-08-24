import { describe, expect, it } from "vitest";
import {
  deriveSides,
  isWellFormed,
  normalizeQuickStatus,
  type RawQuickStatus,
} from "../src/sides.js";

/**
 * DO NOT DELETE OR WEAKEN THIS FILE.
 *
 * If the inversion test fails, the site is printing backwards profit numbers and must
 * not deploy. See CLAUDE.md §1.
 */

/** Swap every `buy`-prefixed field with its `sell` twin. Same book, opposite labels. */
function invert(raw: RawQuickStatus): RawQuickStatus {
  return {
    buyPrice: raw.sellPrice,
    buyVolume: raw.sellVolume,
    buyMovingWeek: raw.sellMovingWeek,
    sellPrice: raw.buyPrice,
    sellVolume: raw.buyVolume,
    sellMovingWeek: raw.buyMovingWeek,
  };
}

// A realistic COAL-ish book. buyPrice (what you pay to instant-buy) is the higher one.
const SAMPLE: RawQuickStatus = {
  buyPrice: 5.43,
  buyVolume: 1_204_337,
  buyMovingWeek: 88_412_009,
  sellPrice: 4.98,
  sellVolume: 9_881_022,
  sellMovingWeek: 91_003_774,
};

describe("deriveSides", () => {
  it("assigns the higher price to ask and the lower to bid", () => {
    const p = normalizeQuickStatus(1_700_000_000, SAMPLE);
    expect(p.ask).toBe(5.43);
    expect(p.bid).toBe(4.98);
  });

  it("carries volume and moving-week with their own side", () => {
    const p = normalizeQuickStatus(1_700_000_000, SAMPLE);
    expect(p.askDepth).toBe(SAMPLE.buyVolume);
    expect(p.ibWeek).toBe(SAMPLE.buyMovingWeek);
    expect(p.bidDepth).toBe(SAMPLE.sellVolume);
    expect(p.isWeek).toBe(SAMPLE.sellMovingWeek);
  });

  // The load-bearing one.
  it("produces identical output when every buy/sell field is swapped", () => {
    const straight = normalizeQuickStatus(1_700_000_000, SAMPLE);
    const inverted = normalizeQuickStatus(1_700_000_000, invert(SAMPLE));
    expect(inverted).toEqual(straight);
  });

  it("stays inversion-proof across a whole series", () => {
    const series: RawQuickStatus[] = Array.from({ length: 50 }, (_, i) => ({
      buyPrice: 5 + i * 0.01,
      buyVolume: 1000 + i,
      buyMovingWeek: 50_000 + i * 7,
      sellPrice: 4.5 + i * 0.01,
      sellVolume: 2000 + i,
      sellMovingWeek: 60_000 + i * 11,
    }));

    for (const [i, raw] of series.entries()) {
      expect(normalizeQuickStatus(i, invert(raw))).toEqual(normalizeQuickStatus(i, raw));
    }
  });

  it("holds ask >= bid for any input, including inverted and degenerate books", () => {
    const cases: RawQuickStatus[] = [
      SAMPLE,
      invert(SAMPLE),
      // ask === bid: a degenerate but legal book
      {
        buyPrice: 7,
        buyVolume: 10,
        buyMovingWeek: 20,
        sellPrice: 7,
        sellVolume: 30,
        sellMovingWeek: 40,
      },
      // zero volume on both sides: a dead item
      {
        buyPrice: 1000,
        buyVolume: 0,
        buyMovingWeek: 0,
        sellPrice: 900,
        sellVolume: 0,
        sellMovingWeek: 0,
      },
    ];

    for (const raw of cases) {
      const p = normalizeQuickStatus(0, raw);
      expect(p.ask).toBeGreaterThanOrEqual(p.bid);
      expect(isWellFormed(p)).toBe(true);
    }
  });

  it("is inversion-proof even when ask === bid and depths differ", () => {
    const tied: RawQuickStatus = {
      buyPrice: 7,
      buyVolume: 10,
      buyMovingWeek: 20,
      sellPrice: 7,
      sellVolume: 30,
      sellMovingWeek: 40,
    };
    expect(normalizeQuickStatus(0, invert(tied))).toEqual(normalizeQuickStatus(0, tied));
  });

  it("preserves the timestamp it was given", () => {
    expect(normalizeQuickStatus(1_234_567, SAMPLE).ts).toBe(1_234_567);
  });

  it("accepts unlabelled sides in either argument order", () => {
    const a = { price: 10, volume: 5, movingWeek: 100 };
    const b = { price: 9, volume: 6, movingWeek: 200 };
    expect(deriveSides(0, a, b)).toEqual(deriveSides(0, b, a));
  });
});

describe("isWellFormed", () => {
  it("rejects a crossed book", () => {
    expect(
      isWellFormed({
        ts: 0,
        ask: 1,
        bid: 2,
        askDepth: 0,
        bidDepth: 0,
        ibWeek: 0,
        isWeek: 0,
      }),
    ).toBe(false);
  });

  it("rejects non-finite prices", () => {
    expect(
      isWellFormed({
        ts: 0,
        ask: Number.NaN,
        bid: 0,
        askDepth: 0,
        bidDepth: 0,
        ibWeek: 0,
        isWeek: 0,
      }),
    ).toBe(false);
  });
});
