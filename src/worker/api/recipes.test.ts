import { describe, expect, it } from "vitest";
import type { RecipeRow } from "../db/recipes.js";
import { makeFakeEnv, makeQueuedFakeD1 } from "../test/apiFakes.js";
import { handleRecipes } from "./recipes.js";

describe("handleRecipes — meta independent of ingest staleness", () => {
  it("reports generatedAt/staleAfter from a fixed TTL, not from any hourly/ingest timestamp", async () => {
    // Recipes carry no timestamp column at all (0001_initial.sql) — this row's
    // content has nothing that COULD go stale the way hourly/ingest data does.
    const row: RecipeRow = {
      id: 1,
      base_tag: "COAL",
      ench_tag: "ENCHANTED_COAL",
      ratio: 160,
      verified: 1,
      note: null,
      kind: "compact",
    };
    const db = makeQueuedFakeD1({ all: [[row]] });

    const before = Math.floor(Date.now() / 1000);
    const res = await handleRecipes(makeFakeEnv({ db }));
    const after = Math.floor(Date.now() / 1000);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: readonly { baseTag: string }[];
      meta: { generatedAt: number; staleAfter: number; source: string };
    };
    expect(body.data).toEqual([
      { id: 1, baseTag: "COAL", enchTag: "ENCHANTED_COAL", ratio: 160, verified: true, note: null },
    ]);
    // generatedAt is "now" — the only honest answer when there is no data timestamp to
    // report — bracketed loosely since the request itself takes nonzero time.
    expect(body.meta.generatedAt).toBeGreaterThanOrEqual(before);
    expect(body.meta.generatedAt).toBeLessThanOrEqual(after);
    expect(body.meta.staleAfter).toBe(body.meta.generatedAt + 86_400);
  });
});
