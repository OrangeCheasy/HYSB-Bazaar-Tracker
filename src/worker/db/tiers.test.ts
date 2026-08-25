import { describe, expect, it } from "vitest";
import { computeTierA } from "./tiers.js";

describe("computeTierA", () => {
  it("includes every recipe tag regardless of volume", () => {
    const tierA = computeTierA(["COAL", "ENCHANTED_COAL"], [], 500);
    expect(tierA.has("COAL")).toBe(true);
    expect(tierA.has("ENCHANTED_COAL")).toBe(true);
  });

  it("includes the top N tags by sellMovingWeek even with no recipe", () => {
    const sorted = ["HYPE_ITEM", "SECOND", "THIRD"];
    const tierA = computeTierA([], sorted, 2);
    expect(tierA.has("HYPE_ITEM")).toBe(true);
    expect(tierA.has("SECOND")).toBe(true);
    expect(tierA.has("THIRD")).toBe(false);
  });

  it("unions recipe tags and top-volume tags without duplication", () => {
    const tierA = computeTierA(["COAL"], ["COAL", "OTHER"], 2);
    expect(tierA.size).toBe(2);
    expect([...tierA].sort()).toEqual(["COAL", "OTHER"]);
  });

  it("drops a recipe tag out of the top-N list without dropping it from Tier A", () => {
    // A dead recipe tag must still be Tier A -- tier assignment is a union, not gated
    // by volume for recipe-referenced tags.
    const tierA = computeTierA(["DEAD_TAG"], ["A", "B", "C"], 2);
    expect(tierA.has("DEAD_TAG")).toBe(true);
    expect(tierA.size).toBe(3); // DEAD_TAG + top 2 of A/B/C
  });

  it("respects topN of 0 (recipe tags only)", () => {
    const tierA = computeTierA(["COAL"], ["A", "B"], 0);
    expect([...tierA]).toEqual(["COAL"]);
  });
});
