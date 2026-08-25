import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATIO,
  RATIO_EXCEPTIONS,
  expectedRatio,
  isEnchantedTag,
  parityPrice,
  validateRecipe,
  type Recipe,
} from "../src/recipes.js";

const OK: Recipe = {
  id: 1,
  baseTag: "COAL",
  enchTag: "ENCHANTED_COAL",
  ratio: 160,
  verified: true,
  note: null,
};

describe("ratio conventions", () => {
  it("defaults to 160", () => {
    expect(DEFAULT_RATIO).toBe(160);
    expect(expectedRatio("COAL")).toBe(160);
    expect(expectedRatio("SOMETHING_NEW")).toBe(160);
  });

  /**
   * The exceptions are real and each one is a wrong number waiting to happen. Tag
   * existence can be checked automatically; ratios cannot - name matching cannot see a
   * crafting grid. CLAUDE.md section 8.
   */
  it("knows the documented exceptions", () => {
    expect(expectedRatio("ENDER_PEARL")).toBe(20);
    expect(expectedRatio("EGG")).toBe(144);
    expect(expectedRatio("HARD_STONE")).toBe(576);
  });

  it("exposes the exception table as data", () => {
    expect(RATIO_EXCEPTIONS["ENDER_PEARL"]).toBe(20);
    expect(Object.keys(RATIO_EXCEPTIONS).length).toBeGreaterThanOrEqual(3);
  });
});

describe("isEnchantedTag", () => {
  it("recognises the enchanted prefix", () => {
    expect(isEnchantedTag("ENCHANTED_COAL")).toBe(true);
    expect(isEnchantedTag("COAL")).toBe(false);
  });
});

describe("parityPrice", () => {
  it("is the base price times the ratio - the no-profit line", () => {
    expect(parityPrice(10, OK)).toBe(1600);
    expect(parityPrice(2.5, { ...OK, ratio: 20 })).toBe(50);
  });
});

describe("validateRecipe", () => {
  it("accepts a well-formed verified recipe", () => {
    const r = validateRecipe(OK);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toEqual(OK);
  });

  it("accepts an unverified recipe that matches convention", () => {
    expect(validateRecipe({ ...OK, verified: false }).ok).toBe(true);
  });

  it("accepts a null id for a recipe that has not been persisted yet", () => {
    expect(validateRecipe({ ...OK, id: null }).ok).toBe(true);
  });

  it("rejects empty tags, naming the offending field", () => {
    const r = validateRecipe({ ...OK, baseTag: "  " });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContainEqual({ kind: "empty-tag", field: "baseTag" });

    const r2 = validateRecipe({ ...OK, enchTag: "" });
    expect(r2.ok === false && r2.error).toContainEqual({ kind: "empty-tag", field: "enchTag" });
  });

  it("rejects a non-integer ratio", () => {
    const r = validateRecipe({ ...OK, ratio: 160.5 });
    expect(r.ok === false && r.error).toContainEqual({
      kind: "non-integer-ratio",
      ratio: 160.5,
    });
  });

  it("rejects a ratio outside the plausible range", () => {
    expect(validateRecipe({ ...OK, ratio: 0 }).ok).toBe(false);
    expect(validateRecipe({ ...OK, ratio: -160 }).ok).toBe(false);
    expect(validateRecipe({ ...OK, ratio: 100_000 }).ok).toBe(false);
  });

  it("rejects a recipe that crafts an item into itself", () => {
    const r = validateRecipe({ ...OK, enchTag: "COAL" });
    expect(r.ok === false && r.error).toContainEqual({ kind: "self-referential" });
  });

  /**
   * A verified recipe is allowed to disagree with the 160 convention - that is what
   * verification is FOR. An unverified one that disagrees is almost certainly a bad
   * guess from name matching, so it does not pass.
   */
  it("rejects an unverified ratio that departs from convention", () => {
    const r = validateRecipe({ ...OK, ratio: 80, verified: false });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContainEqual({
      kind: "ratio-differs-from-convention",
      expected: 160,
      actual: 80,
    });
  });

  it("allows a verified ratio to depart from convention", () => {
    expect(validateRecipe({ ...OK, ratio: 80, verified: true }).ok).toBe(true);
  });

  it("checks convention against the base tag exception table", () => {
    const pearls: Recipe = {
      id: null,
      baseTag: "ENDER_PEARL",
      enchTag: "ENCHANTED_ENDER_PEARL",
      ratio: 20,
      verified: false,
      note: null,
    };
    expect(validateRecipe(pearls).ok).toBe(true);
    expect(validateRecipe({ ...pearls, ratio: 160 }).ok).toBe(false);
  });

  it("reports every issue at once rather than stopping at the first", () => {
    const r = validateRecipe({ ...OK, baseTag: "", ratio: -1 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.length).toBeGreaterThanOrEqual(2);
  });

  it("trims surrounding whitespace from tags it accepts", () => {
    const r = validateRecipe({ ...OK, baseTag: " COAL ", enchTag: " ENCHANTED_COAL " });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.baseTag).toBe("COAL");
    expect(r.ok && r.value.enchTag).toBe("ENCHANTED_COAL");
  });
});
