import { describe, expect, it } from "vitest";
import {
  aggregate,
  deriveSides,
  isBarWellFormed,
  isWellFormed,
  normalizeCoflnetPoint,
  normalizeHourlyRow,
  normalizeMany,
  normalizeQuickStatus,
  normalizeSnapshotRow,
  pointToBar,
  type RawCoflnetPoint,
  type RawHourlyRow,
  type RawQuickStatus,
} from "../src/sides.js";
import { computeStats } from "../src/stats.js";
import { lcg, makePoint } from "./helpers.js";

/**
 * DO NOT DELETE OR WEAKEN THIS FILE.
 *
 * If the inversion test fails, the site is printing backwards profit numbers and must
 * not deploy. See CLAUDE.md section 1.
 */

/** Swap every buy-prefixed field with its sell twin. Same book, opposite labels. */
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

  it("rejects negative depth", () => {
    expect(isWellFormed(makePoint({ askDepth: -1 }))).toBe(false);
    expect(isWellFormed(makePoint({ bidDepth: -1 }))).toBe(false);
  });

  it("rejects a negative bid", () => {
    expect(isWellFormed(makePoint({ ask: 1, bid: -1 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE LOAD-BEARING REGRESSION TEST
// ---------------------------------------------------------------------------

/**
 * Swap buy/sell across an interval-shaped upstream point - prices, min, max, volume
 * AND movingWeek together. This is the same book described with the labels reversed.
 */
function invertCoflnet(raw: RawCoflnetPoint): RawCoflnetPoint {
  return {
    timestamp: raw.timestamp,
    buy: raw.sell,
    sell: raw.buy,
    minBuy: raw.minSell,
    maxBuy: raw.maxSell,
    minSell: raw.minBuy,
    maxSell: raw.maxBuy,
    buyVolume: raw.sellVolume,
    sellVolume: raw.buyVolume,
    buyMovingWeek: raw.sellMovingWeek,
    sellMovingWeek: raw.buyMovingWeek,
  };
}

describe("inversion regression - Stats must be identical under swapped labels", () => {
  /**
   * DO NOT DELETE OR WEAKEN THIS TEST. CLAUDE.md section 1.
   *
   * Every profit figure on the site is a function of Stats. If Stats changes when an
   * upstream field is renamed or the two sides arrive transposed, then the site is
   * printing backwards numbers: it will tell people to buy at the price they should be
   * selling at. The derivation is structural (higher price = ask) precisely so that this
   * test can be unfalsifiable.
   *
   * The series below deliberately varies price, spread, depth and moving-week over time
   * so that every field of Stats - means, avg-low/avg-high, floor/ceiling, spread,
   * volatility and both flow rates - is exercised rather than collapsing to a constant.
   */
  const series: RawCoflnetPoint[] = Array.from({ length: 96 }, (_, i) => {
    const drift = Math.sin(i / 7) * 0.6;
    const ask = 5.4 + drift;
    const bid = 4.9 + drift * 0.8;
    return {
      timestamp: new Date((1_700_000_000 + i * 3600) * 1000).toISOString(),
      buy: ask,
      sell: bid,
      maxBuy: ask + 0.11 + i * 0.001,
      minBuy: ask - 0.09 - i * 0.001,
      maxSell: bid + 0.07,
      minSell: bid - 0.13,
      buyVolume: 1_200_000 + i * 331,
      sellVolume: 9_800_000 - i * 517,
      buyMovingWeek: 88_000_000 + i * 1301,
      sellMovingWeek: 91_000_000 - i * 907,
    };
  });

  const straightBars = series.map((r) => normalizeCoflnetPoint(r, 3600));
  const invertedBars = series.map((r) => normalizeCoflnetPoint(invertCoflnet(r), 3600));

  it("normalizes every point in both orientations without error", () => {
    expect(straightBars.every((r) => r.ok)).toBe(true);
    expect(invertedBars.every((r) => r.ok)).toBe(true);
  });

  it("produces deeply equal Stats from the swapped series", () => {
    const straight = straightBars.flatMap((r) => (r.ok ? [r.value] : []));
    const inverted = invertedBars.flatMap((r) => (r.ok ? [r.value] : []));

    const a = computeStats(straight);
    const b = computeStats(inverted);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Deep equality, not field-by-field: a new Stats field added later is covered
    // by this assertion automatically, with no need to remember to extend the test.
    expect(b.value).toEqual(a.value);
  });

  it("keeps ask above bid in every normalized bar of both orientations", () => {
    for (const r of [...straightBars, ...invertedBars]) {
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.value.askAvg).toBeGreaterThanOrEqual(r.value.bidAvg);
      expect(isBarWellFormed(r.value)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// PROPERTY TEST
// ---------------------------------------------------------------------------

describe("property: ask >= bid for arbitrary input", () => {
  it("holds over 5000 pseudo-random books including degenerate ones", () => {
    const rnd = lcg(0xc0ffee);
    // Values chosen to hit the awkward regions on purpose, not just the happy middle.
    const pool = [0, 1e-9, 0.01, 1, 7, 1000, 1e9, Number.MAX_SAFE_INTEGER];

    for (let i = 0; i < 5000; i++) {
      const pick = (): number => {
        const r = rnd();
        // ~35% of draws come from the degenerate pool, the rest are continuous.
        if (r < 0.35) return pool[Math.floor(rnd() * pool.length)] ?? 0;
        return rnd() * 1000;
      };

      const raw: RawQuickStatus = {
        buyPrice: pick(),
        buyVolume: pick(),
        buyMovingWeek: pick(),
        sellPrice: pick(),
        sellVolume: pick(),
        sellMovingWeek: pick(),
      };

      const p = normalizeQuickStatus(i, raw);

      expect(p.ask).toBeGreaterThanOrEqual(p.bid);
      // And the invariant survives transposition, for every one of these.
      expect(normalizeQuickStatus(i, invert(raw))).toEqual(p);
    }
  });

  it("reports non-finite input as malformed rather than silently passing", () => {
    const bad: RawQuickStatus = {
      buyPrice: Number.POSITIVE_INFINITY,
      buyVolume: 1,
      buyMovingWeek: 1,
      sellPrice: Number.NaN,
      sellVolume: 1,
      sellMovingWeek: 1,
    };
    expect(isWellFormed(normalizeQuickStatus(0, bad))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ADAPTERS AND THE POINT -> BAR SEAM
// ---------------------------------------------------------------------------

describe("normalizeCoflnetPoint", () => {
  const base: RawCoflnetPoint = {
    timestamp: "2024-01-01T00:00:00.000Z",
    buy: 10,
    sell: 9,
    maxBuy: 11,
    minBuy: 9.5,
    maxSell: 9.4,
    minSell: 8.2,
    buyVolume: 500,
    sellVolume: 600,
    buyMovingWeek: 70_000,
    sellMovingWeek: 84_000,
  };

  it("maps the higher-average side to ask and carries its min/max", () => {
    const r = normalizeCoflnetPoint(base, 3600);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.askAvg).toBe(10);
    expect(r.value.askMax).toBe(11);
    expect(r.value.askMin).toBe(9.5);
    expect(r.value.bidAvg).toBe(9);
    expect(r.value.bidMax).toBe(9.4);
    expect(r.value.bidMin).toBe(8.2);
    expect(r.value.source).toBe("coflnet");
  });

  it("parses the ISO timestamp to UTC epoch seconds", () => {
    const r = normalizeCoflnetPoint(base, 3600);
    expect(r.ok && r.value.ts).toBe(1_704_067_200);
  });

  // Load-bearing, in the same way the inversion test is. Coflnet sends its timestamps
  // WITHOUT an offset, which `Date.parse` reads as local time — so before this was
  // fixed, every backfilled row landed off by the runner's UTC offset and the
  // hour-of-day profile was wrong by a different amount on every machine. These three
  // spellings of midnight 2024-01-01 UTC must agree.
  it("reads an offset-less timestamp as UTC, not local time", () => {
    const naive = normalizeCoflnetPoint({ ...base, timestamp: "2024-01-01T00:00:00" }, 3600);
    expect(naive.ok && naive.value.ts).toBe(1_704_067_200);
  });

  it("honours an explicit offset when one is present", () => {
    const zulu = normalizeCoflnetPoint({ ...base, timestamp: "2024-01-01T00:00:00Z" }, 3600);
    const offset = normalizeCoflnetPoint(
      { ...base, timestamp: "2024-01-01T02:00:00+02:00" },
      3600,
    );
    expect(zulu.ok && zulu.value.ts).toBe(1_704_067_200);
    expect(offset.ok && offset.value.ts).toBe(1_704_067_200);
  });

  it("leaves a date-only timestamp alone rather than making it unparseable", () => {
    const r = normalizeCoflnetPoint({ ...base, timestamp: "2024-01-01" }, 3600);
    expect(r.ok && r.value.ts).toBe(1_704_067_200);
  });

  // Edge case: missing min/max.
  it("falls back to the side average when min/max are missing", () => {
    const r = normalizeCoflnetPoint(
      { timestamp: base.timestamp, buy: 10, sell: 9, buyVolume: 1, sellVolume: 2 },
      3600,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.askMin).toBe(10);
    expect(r.value.askMax).toBe(10);
    expect(r.value.bidMin).toBe(9);
    expect(r.value.bidMax).toBe(9);
  });

  it("defaults absent volume and moving-week to zero", () => {
    const r = normalizeCoflnetPoint({ timestamp: base.timestamp, buy: 10, sell: 9 }, 3600);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.askDepth).toBe(0);
    expect(r.value.ibWeek).toBe(0);
    expect(r.value.isWeek).toBe(0);
  });

  it("rejects an unparseable timestamp", () => {
    const r = normalizeCoflnetPoint({ ...base, timestamp: "not a date" }, 3600);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("missing-field");
  });

  it("rejects non-finite prices", () => {
    const r = normalizeCoflnetPoint({ ...base, buy: Number.NaN }, 3600);
    expect(r.ok === false && r.error).toBe("non-finite");
  });

  it("rejects negative prices", () => {
    const r = normalizeCoflnetPoint({ ...base, sell: -1 }, 3600);
    expect(r.ok === false && r.error).toBe("negative-price");
  });

  // Edge case: ask == bid.
  it("accepts a tied book and stays inversion-proof", () => {
    const tied: RawCoflnetPoint = {
      timestamp: base.timestamp,
      buy: 7,
      sell: 7,
      minBuy: 6,
      maxBuy: 8,
      minSell: 5,
      maxSell: 9,
      buyVolume: 10,
      sellVolume: 30,
      buyMovingWeek: 20,
      sellMovingWeek: 40,
    };
    const a = normalizeCoflnetPoint(tied, 3600);
    const b = normalizeCoflnetPoint(invertCoflnet(tied), 3600);
    expect(a.ok && b.ok).toBe(true);
    expect(b).toEqual(a);
  });
});

describe("normalizeHourlyRow", () => {
  const row: RawHourlyRow = {
    hour_ts: 1_700_000_000,
    ask_avg: 10,
    ask_min: 9,
    ask_max: 11,
    bid_avg: 8,
    bid_min: 7,
    bid_max: 9,
    ask_depth: 100,
    bid_depth: 200,
    ib_week: 7000,
    is_week: 14_000,
    samples: 12,
    source: "hypixel",
  };

  it("maps columns straight through - D1 stores already-derived sides", () => {
    const r = normalizeHourlyRow(row);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.askAvg).toBe(10);
    expect(r.value.bidAvg).toBe(8);
    expect(r.value.intervalSeconds).toBe(3600);
    expect(r.value.samples).toBe(12);
  });

  /**
   * Asserts rather than re-derives, deliberately. A crossed row in D1 means ingest wrote
   * bad data; silently re-sorting it here would hide the bug that actually matters.
   */
  it("rejects a crossed row instead of quietly repairing it", () => {
    const r = normalizeHourlyRow({ ...row, ask_avg: 5, bid_avg: 9 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("crossed-book");
  });

  it("falls back to hypixel for an unrecognised source", () => {
    const r = normalizeHourlyRow({ ...row, source: "wat" });
    expect(r.ok && r.value.source).toBe("hypixel");
  });

  it("reads a coflnet-sourced backfill row", () => {
    const r = normalizeHourlyRow({ ...row, source: "coflnet" });
    expect(r.ok && r.value.source).toBe("coflnet");
  });
});

describe("normalizeSnapshotRow", () => {
  it("maps a snapshot row to a Point", () => {
    const r = normalizeSnapshotRow({
      ts: 42,
      ask: 10,
      bid: 9,
      ask_depth: 1,
      bid_depth: 2,
      ib_week: 3,
      is_week: 4,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      ts: 42,
      ask: 10,
      bid: 9,
      askDepth: 1,
      bidDepth: 2,
      ibWeek: 3,
      isWeek: 4,
    });
  });

  it("rejects a crossed snapshot row", () => {
    const r = normalizeSnapshotRow({
      ts: 42,
      ask: 1,
      bid: 9,
      ask_depth: 1,
      bid_depth: 2,
      ib_week: 3,
      is_week: 4,
    });
    expect(r.ok === false && r.error).toBe("crossed-book");
  });
});

describe("pointToBar and aggregate", () => {
  it("widens a Point into a degenerate Bar where min == avg == max", () => {
    const b = pointToBar(makePoint({ ts: 100, ask: 10, bid: 9 }), 300, "hypixel");
    expect(b.askMin).toBe(10);
    expect(b.askAvg).toBe(10);
    expect(b.askMax).toBe(10);
    expect(b.samples).toBe(1);
    expect(b.intervalSeconds).toBe(300);
  });

  it("buckets points into intervals and takes avg/min/max per side", () => {
    const pts = [
      makePoint({ ts: 3600, ask: 10, bid: 8 }),
      makePoint({ ts: 3900, ask: 12, bid: 9 }),
      makePoint({ ts: 4200, ask: 11, bid: 10 }),
      makePoint({ ts: 7200, ask: 20, bid: 19 }),
    ];
    const bars = aggregate(pts, 3600, "hypixel");
    expect(bars).toHaveLength(2);
    const [first, second] = bars;
    expect(first?.ts).toBe(3600);
    expect(first?.samples).toBe(3);
    expect(first?.askAvg).toBeCloseTo(11, 10);
    expect(first?.askMin).toBe(10);
    expect(first?.askMax).toBe(12);
    expect(first?.bidMin).toBe(8);
    expect(first?.bidMax).toBe(10);
    expect(second?.ts).toBe(7200);
    expect(second?.samples).toBe(1);
  });

  it("sorts buckets by time even when input is unordered", () => {
    const bars = aggregate(
      [makePoint({ ts: 7200 }), makePoint({ ts: 0 }), makePoint({ ts: 3600 })],
      3600,
      "hypixel",
    );
    expect(bars.map((b) => b.ts)).toEqual([0, 3600, 7200]);
  });

  it("returns an empty array for no points", () => {
    expect(aggregate([], 3600, "hypixel")).toEqual([]);
  });

  it("returns an empty array for a non-positive interval", () => {
    expect(aggregate([makePoint()], 0, "hypixel")).toEqual([]);
  });
});

describe("normalizeMany", () => {
  it("keeps good rows and reports bad ones - one bad product cannot abort a run", () => {
    const good: RawHourlyRow = {
      hour_ts: 0,
      ask_avg: 10,
      ask_min: 10,
      ask_max: 10,
      bid_avg: 9,
      bid_min: 9,
      bid_max: 9,
      ask_depth: 0,
      bid_depth: 0,
      ib_week: 0,
      is_week: 0,
      samples: 1,
      source: "hypixel",
    };
    const out = normalizeMany(
      [good, { ...good, hour_ts: 3600, ask_avg: 1 }],
      normalizeHourlyRow,
    );
    expect(out.ok).toHaveLength(1);
    expect(out.skipped).toEqual([{ index: 1, error: "crossed-book" }]);
  });
});

describe("isBarWellFormed", () => {
  const wellFormed = {
    ts: 0,
    intervalSeconds: 3600,
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
    samples: 1,
    source: "hypixel" as const,
  };

  it("does not require askMin >= bidMax - an interval can straddle", () => {
    // Over an hour the ask can dip below where the bid peaked, without any single
    // instant ever having a crossed book. This must be legal.
    expect(
      isBarWellFormed({
        ...wellFormed,
        askAvg: 10,
        askMin: 8,
        askMax: 12,
        bidAvg: 9,
        bidMin: 7,
        bidMax: 11,
        samples: 12,
      }),
    ).toBe(true);
  });

  it("rejects min above max within a side", () => {
    expect(isBarWellFormed({ ...wellFormed, askMin: 12, askMax: 8 })).toBe(false);
  });

  it("rejects a non-positive sample count", () => {
    expect(isBarWellFormed({ ...wellFormed, samples: 0 })).toBe(false);
  });

  it("rejects a crossed average", () => {
    expect(isBarWellFormed({ ...wellFormed, askAvg: 1, bidAvg: 9 })).toBe(false);
  });
});
