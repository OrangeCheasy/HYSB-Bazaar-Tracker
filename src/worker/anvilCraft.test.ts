import { describe, expect, it } from "vitest";
import { buildAnvilCraft } from "./anvilCraft.js";
import { makeQueuedFakeD1 } from "./test/apiFakes.js";

/**
 * The merge-chain detail, and specifically the bug it exists to fix.
 *
 * `/api/craft/:tag` used to look the tag up with `selectRecipesByBaseTag`, which returns
 * the STORED 2:1 edges. A scan row for an anvil merge carries a synthetic recipe covering
 * the whole chain (Ultimate Wise 1 -> 5 at ratio 16), so the detail page analysed a
 * different, much smaller trade and reported it with equal confidence: 1.91M/day on the
 * scan against 345k/day on the detail page, for what a user believed was one row.
 */

const FAMILY = "ENCHANTMENT_TEST";

function recipeRow(level: number, id: number) {
  return {
    id,
    base_tag: `${FAMILY}_${level}`,
    ench_tag: `${FAMILY}_${level + 1}`,
    ratio: 2,
    verified: 0,
    note: null,
    kind: "anvil" as const,
  };
}

/**
 * Rungs priced so entering at level 2 is cheapest — level 1 is deliberately overpriced
 * relative to its count, so "enter at the bottom" is the wrong answer here.
 *
 * Every implied merge ratio, `price(N+1) / (2 x price(N))`, stays under ADR-025's
 * threshold of 3, or the top edge would be withheld as un-mergeable and this fixture would
 * be testing the gate instead: 0.75, 1.67, 1.2.
 */
function priceRows() {
  return [
    { tag: `${FAMILY}_1`, ask_avg: 1000, hour_ts: 100 },
    { tag: `${FAMILY}_2`, ask_avg: 1500, hour_ts: 100 },
    { tag: `${FAMILY}_3`, ask_avg: 5000, hour_ts: 100 },
    { tag: `${FAMILY}_4`, ask_avg: 12_000, hour_ts: 100 },
  ];
}

/** `buildAnvilCraft` queries recipes, then book prices, then the two series per craft. */
function fakeDb(seriesRows: unknown[][] = [[], []]) {
  return makeQueuedFakeD1({
    all: [[recipeRow(1, 1), recipeRow(2, 2), recipeRow(3, 3)], priceRows(), ...seriesRows],
  });
}

const PARAMS = {
  market: { sellTaxRate: 0.0125, captureFraction: 0.2, tick: 1, taxOnInstantSell: true },
  sleepStart: 23,
  sleepEnd: 7,
  sellWindowHours: 8,
};

describe("buildAnvilCraft", () => {
  it("describes the WHOLE chain, not one stored 2:1 edge", () => {
    // The bug in one assertion: the recipe returned must span entry rung to target rung,
    // with the chain's cumulative ratio — not level 1 to level 2 at ratio 2.
    return buildAnvilCraft(fakeDb(), `${FAMILY}_4`, PARAMS, 1_000).then((result) => {
      expect(result).not.toBeNull();
      const recipe = result!.row.recipe;
      expect(recipe.enchTag).toBe(`${FAMILY}_4`);
      expect(recipe.ratio).toBeGreaterThan(2);
      expect(result!.row.kind).toBe("anvil");
    });
  });

  it("picks the cheapest entry rung rather than always the bottom one", async () => {
    // Level 1 at 1000 x8 = 8000; level 2 at 1500 x4 = 6000; level 3 at 5000 x2 = 10000.
    // The entry-level search is the whole feature: entering low is NOT always right.
    const result = await buildAnvilCraft(fakeDb(), `${FAMILY}_4`, PARAMS, 1_000);
    expect(result!.row.plan?.entryTag).toBe(`${FAMILY}_2`);
    expect(result!.row.plan?.entryUnits).toBe(4);
  });

  it("returns the full ladder so the choice can be checked, not just taken on trust", async () => {
    const ladder = (await buildAnvilCraft(fakeDb(), `${FAMILY}_4`, PARAMS, 1_000))!.row.ladder;
    expect(ladder?.map((r) => r.level)).toEqual([1, 2, 3]);
    expect(ladder?.map((r) => r.unitsRequired)).toEqual([8, 4, 2]);
    expect(ladder?.map((r) => r.totalCost)).toEqual([8000, 6000, 10_000]);
    expect(ladder?.filter((r) => r.chosen).map((r) => r.level)).toEqual([2]);
  });

  it("accumulates the multiplier along the edges rather than assuming 2^(M-L)", async () => {
    // Every rung of this chain exists, so the two agree here — the test is that the
    // ladder's arithmetic comes from the edges. FEATHER_FALLING lists 1-10 then jumps to
    // 20, where 2^(20-10) would claim 1,024 books for what may be one merge or none.
    const ladder = (await buildAnvilCraft(fakeDb(), `${FAMILY}_4`, PARAMS, 1_000))!.row.ladder;
    for (const rung of ladder ?? []) {
      expect(rung.unitsRequired).toBe(2 ** (4 - rung.level));
    }
  });

  it("omits a rung with no route to the target instead of pricing it", async () => {
    // A family whose chain is broken above level 2: level 3 cannot reach level 4.
    const db = makeQueuedFakeD1({
      all: [[recipeRow(1, 1), recipeRow(2, 2)], priceRows(), [], []],
    });
    const ladder = (await buildAnvilCraft(db, `${FAMILY}_3`, PARAMS, 1_000))!.row.ladder;
    // Only rungs that actually reach ENCHANTMENT_TEST_3.
    expect(ladder?.map((r) => r.level)).toEqual([1, 2]);
  });

  it("withholds a rung the market prices as un-mergeable", async () => {
    // ADR-025: an implied merge ratio past 3 means the merge does not exist — the top rung
    // is a minigame reward, not something an anvil produces. 24000/(2x5000) = 2.4 is fine;
    // 40000/(2x5000) = 4.0 is not, so nothing can merge INTO level 4 and the only route to
    // it is buying it.
    const db = makeQueuedFakeD1({
      all: [
        [recipeRow(1, 1), recipeRow(2, 2), recipeRow(3, 3)],
        [
          { tag: `${FAMILY}_1`, ask_avg: 1000, hour_ts: 100 },
          { tag: `${FAMILY}_2`, ask_avg: 1500, hour_ts: 100 },
          { tag: `${FAMILY}_3`, ask_avg: 5000, hour_ts: 100 },
          { tag: `${FAMILY}_4`, ask_avg: 40_000, hour_ts: 100 },
        ],
      ],
    });
    const result = await buildAnvilCraft(db, `${FAMILY}_4`, PARAMS, 1_000);
    // No merge route survives, so there is no chain to enter and no ladder to price. The
    // alternative — quoting 8,000 coins for a book nobody can make — is the exact
    // "1,509% margin on a trade that does not exist" failure the gate was built to stop.
    expect(result!.row.error).toBe("buying-beats-merging");
    expect(result!.row.ladder).toEqual([]);
  });

  it("is not a merge chain for a tag that is not a book", async () => {
    expect(await buildAnvilCraft(fakeDb(), "COAL", PARAMS, 1_000)).toBeNull();
  });

  it("reports buying-beats-merging as an answer, with the plan still attached", async () => {
    // Every rung priced so high that buying the target outright wins.
    const db = makeQueuedFakeD1({
      all: [
        [recipeRow(1, 1), recipeRow(2, 2), recipeRow(3, 3)],
        [
          { tag: `${FAMILY}_1`, ask_avg: 100_000, hour_ts: 100 },
          { tag: `${FAMILY}_2`, ask_avg: 100_000, hour_ts: 100 },
          { tag: `${FAMILY}_3`, ask_avg: 100_000, hour_ts: 100 },
          { tag: `${FAMILY}_4`, ask_avg: 1, hour_ts: 100 },
        ],
      ],
    });
    const result = await buildAnvilCraft(db, `${FAMILY}_4`, PARAMS, 1_000);
    expect(result!.row.error).toBe("buying-beats-merging");
    expect(result!.row.analysis).toBeUndefined();
    // The plan is what makes that answer readable — a bare error would throw away the
    // comparison that justifies it.
    expect(result!.row.plan).toBeDefined();
  });
});
