import { describe, expect, it } from "vitest";
import { handleBands, parseBandParams } from "./bands.js";
import { makeFakeEnv, makeQueuedFakeD1 } from "../test/apiFakes.js";

const HOUR = 3600;

function hourlyRows(count: number, over: Record<string, number> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return Array.from({ length: count }, (_, i) => ({
    hour_ts: now - (count - i) * HOUR,
    ask_avg: 200,
    ask_min: 195,
    ask_max: 205,
    bid_avg: 100,
    bid_min: 95,
    bid_max: 105,
    ask_depth: 1000,
    bid_depth: 1000,
    ib_week: 50_000,
    is_week: 50_000,
    samples: 12,
    source: "hypixel",
    ...over,
  }));
}

describe("parseBandParams", () => {
  const parse = (q: string) => parseBandParams(new URL(`https://x/api/bands/COAL?${q}`));

  it("defaults to a 7-day p10/p90 band", () => {
    const r = parse("");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ windowDays: 7, lowPercentile: 0.1, highPercentile: 0.9 });
  });

  /**
   * The obvious mistake, and the reason ADR-019 rejects rather than clamps: `?pLow=10`
   * means "the 10th percentile" to a human. Clamped to 1.0 it would return a band built
   * from the MAXIMUM bid and look perfectly confident doing it.
   */
  it("rejects a percentile given as a number out of 100", () => {
    const r = parse("pLow=10");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("pLow");
    expect(r.message).toContain("0.1");
  });

  it("rejects a low percentile at or above the high one", () => {
    const r = parse("pLow=0.9&pHigh=0.1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("must be below");
  });

  it.each(["days=0", "days=99", "days=abc", "pHigh=2"])("rejects %s", (q) => {
    expect(parse(q).ok).toBe(false);
  });

  it("accepts a deliberately widened band", () => {
    const r = parse("days=28&pLow=0.02&pHigh=0.98");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ windowDays: 28, lowPercentile: 0.02, highPercentile: 0.98 });
  });
});

describe("handleBands", () => {
  it("returns a band with its hit-rate and week count", async () => {
    const env = makeFakeEnv({ db: makeQueuedFakeD1({ all: [hourlyRows(168)] }) });
    const res = await handleBands("COAL", new URL("https://x/api/bands/COAL"), env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        tag: string;
        buyBand: number;
        sellBand: number;
        buyHits: { hoursTouched: number; hoursTotal: number; rate: number };
        sellHits: { hoursTouched: number };
        weekCount: number;
        bothHitWeeks: number;
        flags: string[];
      };
      meta: { generatedAt: number; staleAfter: number; source: string };
    };

    expect(body.data.tag).toBe("COAL");
    // Sides: buy from the bid side (100), sell from the ask side (200).
    expect(body.data.buyBand).toBeCloseTo(100, 5);
    expect(body.data.sellBand).toBeCloseTo(200, 5);
    expect(body.data.buyBand).toBeLessThan(body.data.sellBand);

    // Non-negotiable #6: the band never ships without its fill-feasibility number.
    expect(body.data.buyHits.hoursTotal).toBe(168);
    expect(body.data.weekCount).toBe(1);
    expect(body.data.flags).toContain("short-history");
  });

  /** Freshness comes from the newest bar used, never Date.now() — a band computed from a
   *  stale series must not claim to be fresh (CLAUDE.md section 5). */
  it("reports generatedAt from the data, not the clock", async () => {
    const rows = hourlyRows(168);
    const newest = Math.max(...rows.map((r) => r.hour_ts));
    const env = makeFakeEnv({ db: makeQueuedFakeD1({ all: [rows] }) });

    const res = await handleBands("COAL", new URL("https://x/api/bands/COAL"), env);
    const body = (await res.json()) as { meta: { generatedAt: number; staleAfter: number } };

    expect(body.meta.generatedAt).toBe(newest);
    expect(body.meta.staleAfter).toBe(newest + 3600);
  });

  it("404s a tag with no rows", async () => {
    const env = makeFakeEnv({ db: makeQueuedFakeD1({ all: [[]] }) });
    const res = await handleBands("NOPE", new URL("https://x/api/bands/NOPE"), env);
    expect(res.status).toBe(404);
  });

  it("422s when there is data but not enough of it to band", async () => {
    const env = makeFakeEnv({ db: makeQueuedFakeD1({ all: [hourlyRows(3)] }) });
    const res = await handleBands("COAL", new URL("https://x/api/bands/COAL"), env);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("insufficient-data");
  });

  it("400s a bad percentile without touching the database", async () => {
    const env = makeFakeEnv({ db: makeQueuedFakeD1({ all: [] }) });
    const res = await handleBands("COAL", new URL("https://x/api/bands/COAL?pLow=10"), env);
    expect(res.status).toBe(400);
  });
});
