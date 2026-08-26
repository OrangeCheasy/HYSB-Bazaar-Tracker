import { describe, expect, it } from "vitest";
import { ANVIL_SOFT_CAP_LEVEL, mergeTargetLevel } from "../src/anvil.js";
import { deriveCompactionRecipes } from "../src/recipes.js";

/**
 * The two derivations that replace hand-written lists, and the merge cap.
 *
 * All three exist because a seeded list goes stale against a game that keeps adding items:
 * migration 0003's 43 compaction recipes were missing 49 crafts the bazaar plainly lists.
 */

describe("deriveCompactionRecipes", () => {
  it("finds a craft only when BOTH tags are really listed", () => {
    // Tag existence is the one thing that CAN be checked automatically, so it is checked.
    const recipes = deriveCompactionRecipes(["COAL", "ENCHANTED_COAL", "ENCHANTED_GHOST"]);
    expect(recipes.map((r) => r.enchTag)).toEqual(["ENCHANTED_COAL"]);
  });

  it("never marks a derived recipe verified", () => {
    // The ratio is a guess about a crafting grid. CLAUDE.md §8: name matching cannot see one.
    for (const recipe of deriveCompactionRecipes(["COAL", "ENCHANTED_COAL"])) {
      expect(recipe.verified).toBe(false);
    }
  });

  it("applies the documented ratio exceptions rather than a blanket 160", () => {
    const recipes = deriveCompactionRecipes([
      "COAL",
      "ENCHANTED_COAL",
      "ENDER_PEARL",
      "ENCHANTED_ENDER_PEARL",
      "EGG",
      "ENCHANTED_EGG",
      "HARD_STONE",
      "ENCHANTED_HARD_STONE",
    ]);
    const ratio = (tag: string) => recipes.find((r) => r.enchTag === tag)?.ratio;
    expect(ratio("ENCHANTED_COAL")).toBe(160);
    expect(ratio("ENCHANTED_ENDER_PEARL")).toBe(20);
    expect(ratio("ENCHANTED_EGG")).toBe(144);
    expect(ratio("ENCHANTED_HARD_STONE")).toBe(576);
  });

  it("derives a tier-2 block from the ENCHANTED form, never from the raw one", () => {
    // ENCHANTED_COAL_BLOCK consumes enchanted coal, not coal. Deriving it from COAL would
    // price a craft 160x cheaper than it is.
    const recipes = deriveCompactionRecipes(["COAL", "ENCHANTED_COAL", "ENCHANTED_COAL_BLOCK"]);
    const block = recipes.find((r) => r.enchTag === "ENCHANTED_COAL_BLOCK");
    expect(block?.baseTag).toBe("ENCHANTED_COAL");
  });

  it("omits a block whose intermediate does not exist", () => {
    const recipes = deriveCompactionRecipes(["ENCHANTED_MYSTERY_BLOCK"]);
    expect(recipes).toEqual([]);
  });

  it("never treats an enchanted BOOK as a compaction craft", () => {
    // ENCHANTMENT_ and ENCHANTED_ differ by two letters, and matching the wrong prefix
    // would push 777 books through the 160:1 model.
    const recipes = deriveCompactionRecipes([
      "ENCHANTMENT_SHARPNESS_1",
      "ENCHANTMENT_SHARPNESS_2",
    ]);
    expect(recipes).toEqual([]);
  });

  it("does not guess a renamed pair", () => {
    // ENCHANTED_CACTUS_GREEN comes from CACTUS, which the name does not say. Inventing that
    // mapping is exactly the unverifiable assertion this module avoids.
    const recipes = deriveCompactionRecipes(["CACTUS", "ENCHANTED_CACTUS_GREEN"]);
    expect(recipes).toEqual([]);
  });
});

describe("mergeTargetLevel", () => {
  it("leaves families that top out at or below 5 alone", () => {
    expect(mergeTargetLevel([1, 2, 3, 4, 5])).toBe(5);
    expect(mergeTargetLevel([1, 2, 3])).toBe(3);
    expect(mergeTargetLevel([1, 2])).toBe(2);
  });

  it("caps a family that lists rungs above 5 but does not reach 10", () => {
    // 20 families list a rung 6 and 16 list a rung 7. Those rungs are not produced by
    // merging two level-5 books — they come from elsewhere in the game.
    expect(mergeTargetLevel([1, 2, 3, 4, 5, 6])).toBe(ANVIL_SOFT_CAP_LEVEL);
    expect(mergeTargetLevel([1, 2, 3, 4, 5, 6, 7])).toBe(ANVIL_SOFT_CAP_LEVEL);
  });

  it("lets a family that reaches 10 merge the whole way", () => {
    expect(mergeTargetLevel([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(10);
  });

  it("caps the level-9 family, which is the one genuinely ambiguous case", () => {
    // CULTIVATING lists rungs to 9 and no 10. By the rule as stated it is capped at 5; if
    // it really does merge to 10 with the top rung simply unlisted, this is the line to
    // revisit. Asserted so the decision is visible rather than incidental.
    expect(mergeTargetLevel([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(ANVIL_SOFT_CAP_LEVEL);
  });

  it("falls back to the highest rung the family actually lists below the cap", () => {
    // Levels are not always contiguous — FEATHER_FALLING runs 1-10 then jumps to 20.
    expect(mergeTargetLevel([1, 2, 4, 7])).toBe(4);
  });

  it("returns undefined for a family with nothing mergeable", () => {
    expect(mergeTargetLevel([])).toBeUndefined();
    expect(mergeTargetLevel([0])).toBeUndefined();
  });
});

describe("tier-2 crafts are not mistaken for one-step ones", () => {
  it("routes ENCHANTED_SUGAR_CANE through ENCHANTED_SUGAR, not SUGAR_CANE", () => {
    // The trap: ENCHANTED_SUGAR_CANE name-matches SUGAR_CANE exactly, and taking that match
    // produces a plausible 160:1 recipe for a craft that really costs 160x160 sugar cane.
    // Migration 0006 exists because this chain was got wrong once already.
    const recipes = deriveCompactionRecipes([
      "SUGAR_CANE",
      "ENCHANTED_SUGAR",
      "ENCHANTED_SUGAR_CANE",
    ]);
    const cane = recipes.find((r) => r.enchTag === "ENCHANTED_SUGAR_CANE");
    expect(cane?.baseTag).toBe("ENCHANTED_SUGAR");
    // Specifically NOT the one-step version migration 0006 had to delete. When that row
    // existed, production ranked it first at ~1.77 billion profit/day on a ~3,000% margin.
    expect(recipes).not.toContainEqual(
      expect.objectContaining({ baseTag: "SUGAR_CANE", enchTag: "ENCHANTED_SUGAR_CANE" }),
    );
    // The first rung is not derivable at all — `SUGAR` is not a bazaar product, so sugar
    // cane to enchanted sugar stays hand-curated, which is why 0006 seeds it.
    expect(recipes.find((r) => r.enchTag === "ENCHANTED_SUGAR")).toBeUndefined();
  });

  it("still routes a block through its enchanted intermediate", () => {
    const recipes = deriveCompactionRecipes(["COAL", "ENCHANTED_COAL", "ENCHANTED_COAL_BLOCK"]);
    expect(recipes.find((r) => r.enchTag === "ENCHANTED_COAL_BLOCK")?.baseTag).toBe(
      "ENCHANTED_COAL",
    );
  });

  it("does not let a character-prefix masquerade as a name-prefix", () => {
    // ENCHANTED_GOLD is a prefix of ENCHANTED_GOLDEN_CARROT by characters only. Without the
    // underscore-boundary check it would claim it as a tier-2 craft.
    const recipes = deriveCompactionRecipes([
      "GOLD",
      "ENCHANTED_GOLD",
      "GOLDEN_CARROT",
      "ENCHANTED_GOLDEN_CARROT",
    ]);
    expect(recipes.find((r) => r.enchTag === "ENCHANTED_GOLDEN_CARROT")?.baseTag).toBe(
      "GOLDEN_CARROT",
    );
  });

  it("takes the LONGEST enchanted prefix when several match", () => {
    const recipes = deriveCompactionRecipes([
      "ENCHANTED_A",
      "ENCHANTED_A_B",
      "ENCHANTED_A_B_C",
    ]);
    expect(recipes.find((r) => r.enchTag === "ENCHANTED_A_B_C")?.baseTag).toBe("ENCHANTED_A_B");
  });
});
