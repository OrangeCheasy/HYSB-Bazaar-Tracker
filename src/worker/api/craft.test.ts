import { describe, expect, it } from "vitest";
import type { RawHourlyRow } from "@core/index.js";
import type { RecipeRow } from "../db/recipes.js";
import { makeFakeEnv, makeQueuedFakeD1 } from "../test/apiFakes.js";
import { handleCraft } from "./craft.js";

function makeHourlyRow(hourTs: number, ask: number, bid: number): RawHourlyRow {
  return {
    hour_ts: hourTs,
    ask_avg: ask,
    ask_min: ask,
    ask_max: ask,
    bid_avg: bid,
    bid_min: bid,
    bid_max: bid,
    ask_depth: 100,
    bid_depth: 200,
    ib_week: 1000,
    is_week: 2000,
    samples: 1,
    source: "hypixel",
  };
}

describe("handleCraft — stale data", () => {
  it("reports generatedAt from the stalest of the base/product series, not Date.now()", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleHourTs = now - 5 * 3600; // neither tag has ingested in 5 hours

    const recipeRow: RecipeRow = {
      id: 1,
      base_tag: "COAL",
      ench_tag: "ENCHANTED_COAL",
      ratio: 160,
      verified: 1,
      note: null,
    };

    const db = makeQueuedFakeD1({
      all: [
        [recipeRow], // selectRecipesByBaseTag
        [makeHourlyRow(staleHourTs, 10, 9)], // base (COAL) series
        [makeHourlyRow(staleHourTs, 1700, 1600)], // product (ENCHANTED_COAL) series
      ],
    });

    const res = await handleCraft("COAL", new URL("https://bazaar.example/api/craft/COAL"), makeFakeEnv({ db }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: readonly { recipe: unknown; analysis?: unknown; error?: string }[];
      meta: { generatedAt: number; staleAfter: number };
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.analysis).toBeDefined();
    expect(body.meta.generatedAt).toBe(staleHourTs);
    expect(body.meta.staleAfter).toBe(staleHourTs + 3600);
    expect(body.meta.staleAfter).toBeLessThan(now);
  });

  it("returns 404 for a base tag with no recipe at all", async () => {
    const db = makeQueuedFakeD1({ all: [[]] }); // selectRecipesByBaseTag finds nothing
    const res = await handleCraft("NOT_A_TAG", new URL("https://bazaar.example/api/craft/NOT_A_TAG"), makeFakeEnv({ db }));
    expect(res.status).toBe(404);
  });
});
