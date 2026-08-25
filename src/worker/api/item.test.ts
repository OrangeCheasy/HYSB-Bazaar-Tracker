import { describe, expect, it } from "vitest";
import type { RawHourlyRow } from "@core/index.js";
import { makeFakeEnv, makeQueuedFakeD1 } from "../test/apiFakes.js";
import { handleItemHistory, handleItemHours, handleItemStats } from "./item.js";

function makeHourlyRow(hourTs: number): RawHourlyRow {
  return {
    hour_ts: hourTs,
    ask_avg: 10,
    ask_min: 9.5,
    ask_max: 10.5,
    bid_avg: 9,
    bid_min: 8.5,
    bid_max: 9.5,
    ask_depth: 100,
    bid_depth: 200,
    ib_week: 1000,
    is_week: 2000,
    samples: 12,
    source: "hypixel",
  };
}

describe("handleItemStats — stale data", () => {
  it("reports generatedAt from the freshest bar actually present, not from Date.now()", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleHourTs = now - 5 * 3600; // hourly cron hasn't run in 5 hours
    const db = makeQueuedFakeD1({ all: [[makeHourlyRow(staleHourTs)]] });

    const res = await handleItemStats("COAL", makeFakeEnv({ db }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { meta: { generatedAt: number; staleAfter: number } };
    expect(body.meta.generatedAt).toBe(staleHourTs);
    expect(body.meta.staleAfter).toBe(staleHourTs + 3600);
    expect(body.meta.staleAfter).toBeLessThan(now); // honestly already stale
  });
});

describe("handleItemHistory — stale data", () => {
  it("reports generatedAt from the newest chart point, not the request time", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleTs = now - 4 * 3600;
    const point = {
      ts: staleTs,
      askAvg: 10,
      askMin: 9.5,
      askMax: 10.5,
      bidAvg: 9,
      bidMin: 8.5,
      bidMax: 9.5,
      samples: 12,
    };
    const db = makeQueuedFakeD1({ all: [[point]] });

    const res = await handleItemHistory(
      "COAL",
      new URL("https://bazaar.example/api/item/COAL/history?range=7d"),
      makeFakeEnv({ db }),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { meta: { generatedAt: number; staleAfter: number } };
    expect(body.meta.generatedAt).toBe(staleTs);
    expect(body.meta.staleAfter).toBeLessThan(now);
  });

  it("returns an honest generatedAt (now, not a fabricated past) when the range has no data at all", async () => {
    const db = makeQueuedFakeD1({ all: [[]] });
    const before = Math.floor(Date.now() / 1000);

    const res = await handleItemHistory(
      "DEAD_TAG",
      new URL("https://bazaar.example/api/item/DEAD_TAG/history?range=7d"),
      makeFakeEnv({ db }),
    );
    const after = Math.floor(Date.now() / 1000);

    const body = (await res.json()) as { data: unknown[]; meta: { generatedAt: number } };
    expect(body.data).toEqual([]);
    expect(body.meta.generatedAt).toBeGreaterThanOrEqual(before);
    expect(body.meta.generatedAt).toBeLessThanOrEqual(after);
  });
});

describe("handleItemHours — stale data", () => {
  it("reports generatedAt from the freshest hourly bar, not from Date.now()", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleHourTs = now - 6 * 3600;
    const db = makeQueuedFakeD1({ all: [[makeHourlyRow(staleHourTs)]] });

    const res = await handleItemHours(
      "COAL",
      new URL("https://bazaar.example/api/item/COAL/hours?days=30"),
      makeFakeEnv({ db }),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { meta: { generatedAt: number; staleAfter: number } };
    expect(body.meta.generatedAt).toBe(staleHourTs);
    expect(body.meta.staleAfter).toBeLessThan(now);
  });
});
