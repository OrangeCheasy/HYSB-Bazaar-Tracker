import { describe, expect, it } from "vitest";
import {
  ANVIL_INPUT_PER_OUTPUT,
  DEFAULT_MAX_IMPLIED_MERGE_RATIO,
  anvilEdges,
  bookTagFor,
  booksRequired,
  deriveFamilies,
  detectMergeGates,
  levelEndpointTags,
  mergeableFamilies,
  parseBookTag,
} from "../src/anvil.js";
import { cheapestPath } from "../src/convert.js";

describe("parsing book tags", () => {
  it("splits family from trailing level", () => {
    expect(parseBookTag("ENCHANTMENT_SHARPNESS_5")).toEqual({
      tag: "ENCHANTMENT_SHARPNESS_5",
      family: "ENCHANTMENT_SHARPNESS",
      level: 5,
    });
  });

  /** Enchant names contain underscores, so the level is the TRAILING digit group and
   *  everything before it is the family. Splitting on the first underscore, or on any
   *  underscore, silently invents families. */
  it("keeps multi-word enchant names intact", () => {
    expect(parseBookTag("ENCHANTMENT_ULTIMATE_WISE_3")).toMatchObject({
      family: "ENCHANTMENT_ULTIMATE_WISE",
      level: 3,
    });
    expect(parseBookTag("ENCHANTMENT_FEATHER_FALLING_10")).toMatchObject({
      family: "ENCHANTMENT_FEATHER_FALLING",
      level: 10,
    });
  });

  it("reads multi-digit levels as one number", () => {
    expect(parseBookTag("ENCHANTMENT_FEATHER_FALLING_20")?.level).toBe(20);
  });

  it.each([
    ["ENCHANTED_COAL", "a non-book tag"],
    ["ENCHANTMENT_SHARPNESS", "no level suffix"],
    ["SHARPNESS_1", "missing prefix"],
    ["", "empty"],
  ])("rejects %s (%s)", (tag) => {
    expect(parseBookTag(tag)).toBeNull();
  });

  /** Three level-0 books are real bazaar products. Parsing them keeps them visible;
   *  whether they MERGE is a separate question, answered by MIN_MERGE_LEVEL. */
  it("parses level 0 rather than silently dropping the tag", () => {
    expect(parseBookTag("ENCHANTMENT_ULTIMATE_ONE_FOR_ALL_0")).toMatchObject({
      family: "ENCHANTMENT_ULTIMATE_ONE_FOR_ALL",
      level: 0,
    });
  });

  it("round-trips through bookTagFor", () => {
    const parsed = parseBookTag("ENCHANTMENT_ULTIMATE_WISE_4");
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(bookTagFor(parsed.family, parsed.level)).toBe("ENCHANTMENT_ULTIMATE_WISE_4");
  });
});

describe("the 2^(M-L) rule", () => {
  /** The fact most likely to be re-derived wrong. Sharpness 1 -> 7 is 64 books, not 6. */
  it("is exponential, not linear", () => {
    expect(booksRequired(1, 7)).toBe(64);
    expect(booksRequired(1, 2)).toBe(2);
    expect(booksRequired(4, 7)).toBe(8);
    expect(booksRequired(1, 10)).toBe(512);
    expect(ANVIL_INPUT_PER_OUTPUT).toBe(2);
  });

  it.each([
    [5, 5],
    [7, 3],
    [0, 4],
    [1.5, 3],
  ])("returns null rather than a misleading number for (%s -> %s)", (from, to) => {
    expect(booksRequired(from, to)).toBeNull();
  });
});

describe("deriving families from a product list", () => {
  const PRODUCTS = [
    "ENCHANTMENT_SHARPNESS_1",
    "ENCHANTMENT_SHARPNESS_2",
    "ENCHANTMENT_SHARPNESS_3",
    "ENCHANTMENT_ULTIMATE_WISE_1",
    "ENCHANTMENT_ULTIMATE_WISE_2",
    "ENCHANTMENT_LONE_WOLF_5", // single rung
    "ENCHANTED_COAL", // not a book
    "COAL",
  ];

  it("ignores non-book tags and groups the rest", () => {
    const fams = deriveFamilies(PRODUCTS);
    expect(fams.map((f) => f.family)).toEqual([
      "ENCHANTMENT_LONE_WOLF",
      "ENCHANTMENT_SHARPNESS",
      "ENCHANTMENT_ULTIMATE_WISE",
    ]);
  });

  it("records the level range and contiguity", () => {
    const [, sharpness] = deriveFamilies(PRODUCTS);
    expect(sharpness).toMatchObject({
      levels: [1, 2, 3],
      minLevel: 1,
      maxLevel: 3,
      contiguous: true,
    });
  });

  /** A brand-new enchant must work with no code change — there is no enchant map to
   *  update. This is the same discipline tier assignment follows (CLAUDE.md section 2). */
  it("handles an enchant it has never seen", () => {
    const fams = deriveFamilies([
      "ENCHANTMENT_TOTALLY_NEW_THING_1",
      "ENCHANTMENT_TOTALLY_NEW_THING_2",
    ]);
    expect(fams).toHaveLength(1);
    expect(fams[0]).toMatchObject({ family: "ENCHANTMENT_TOTALLY_NEW_THING", maxLevel: 2 });
  });

  it("de-duplicates and sorts levels regardless of input order", () => {
    const fams = deriveFamilies([
      "ENCHANTMENT_X_3",
      "ENCHANTMENT_X_1",
      "ENCHANTMENT_X_3",
      "ENCHANTMENT_X_2",
    ]);
    expect(fams[0]?.levels).toEqual([1, 2, 3]);
  });

  it("flags a gapped family", () => {
    const fams = deriveFamilies(["ENCHANTMENT_G_1", "ENCHANTMENT_G_2", "ENCHANTMENT_G_20"]);
    expect(fams[0]).toMatchObject({ minLevel: 1, maxLevel: 20, contiguous: false });
  });

  it("separates mergeable families from single-rung ones", () => {
    const fams = deriveFamilies(PRODUCTS);
    expect(mergeableFamilies(fams).map((f) => f.family)).toEqual([
      "ENCHANTMENT_SHARPNESS",
      "ENCHANTMENT_ULTIMATE_WISE",
    ]);
  });
});

describe("edge generation", () => {
  it("emits one edge per adjacent pair, always ratio 2 and never verified", () => {
    const fams = deriveFamilies([
      "ENCHANTMENT_SHARPNESS_1",
      "ENCHANTMENT_SHARPNESS_2",
      "ENCHANTMENT_SHARPNESS_3",
    ]);
    const edges = anvilEdges(fams);

    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({
      from: "ENCHANTMENT_SHARPNESS_1",
      to: "ENCHANTMENT_SHARPNESS_2",
      inputPerOutput: 2,
      kind: "anvil",
      verified: false,
      stepCost: 0,
    });
  });

  /**
   * The real gapped family. FEATHER_FALLING lists 1-10 then 20; a 10 -> 20 edge would
   * claim one merge spans ten levels, pricing 2^10 books as though they were 2. Adjacency
   * drops it without a special case.
   */
  it("does not bridge a gap with a single edge", () => {
    const fams = deriveFamilies([
      ...Array.from({ length: 10 }, (_, i) => `ENCHANTMENT_FEATHER_FALLING_${i + 1}`),
      "ENCHANTMENT_FEATHER_FALLING_20",
    ]);
    const edges = anvilEdges(fams);

    expect(edges).toHaveLength(9); // 1->2 .. 9->10, and nothing reaching 20
    expect(edges.some((e) => e.to === "ENCHANTMENT_FEATHER_FALLING_20")).toBe(false);
  });

  it("emits nothing for a single-rung family", () => {
    expect(anvilEdges(deriveFamilies(["ENCHANTMENT_LONE_WOLF_5"]))).toEqual([]);
  });

  /**
   * ENCHANTMENT_ULTIMATE_ONE_FOR_ALL is really listed at levels 0 and 1. A 0 -> 1 edge
   * would assert that two "level 0" books make a level 1, which nothing confirms — and a
   * wrong edge yields a confident wrong price. The tag stays visible in `levels`; only
   * the merge is withheld.
   */
  it("keeps level-0 tags visible but does not merge from them", () => {
    const fams = deriveFamilies([
      "ENCHANTMENT_ULTIMATE_ONE_FOR_ALL_0",
      "ENCHANTMENT_ULTIMATE_ONE_FOR_ALL_1",
    ]);
    expect(fams[0]?.levels).toEqual([0, 1]);
    expect(anvilEdges(fams)).toEqual([]);
    expect(mergeableFamilies(fams)).toEqual([]);
  });

  it("still merges normally in a family that happens to include level 0", () => {
    const fams = deriveFamilies(["ENCHANTMENT_Q_0", "ENCHANTMENT_Q_1", "ENCHANTMENT_Q_2"]);
    const edges = anvilEdges(fams);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: "ENCHANTMENT_Q_1", to: "ENCHANTMENT_Q_2" });
  });

  /** The fee is unverified, so it must be an input rather than a constant, and zero by
   *  default so it cannot quietly distort a number nobody asked it to. */
  it("defaults the anvil fee to zero and applies it per merge when supplied", () => {
    const fams = deriveFamilies(["ENCHANTMENT_X_1", "ENCHANTMENT_X_2"]);
    expect(anvilEdges(fams)[0]?.stepCost).toBe(0);
    expect(anvilEdges(fams, { stepCost: 250 })[0]?.stepCost).toBe(250);
  });
});

describe("tier A level endpoints", () => {
  it("takes the lowest and highest rung of each family", () => {
    const fams = deriveFamilies([
      "ENCHANTMENT_SHARPNESS_1",
      "ENCHANTMENT_SHARPNESS_2",
      "ENCHANTMENT_SHARPNESS_7",
      "ENCHANTMENT_ULTIMATE_WISE_1",
      "ENCHANTMENT_ULTIMATE_WISE_5",
    ]);
    expect(levelEndpointTags(fams)).toEqual([
      "ENCHANTMENT_SHARPNESS_1",
      "ENCHANTMENT_SHARPNESS_7",
      "ENCHANTMENT_ULTIMATE_WISE_1",
      "ENCHANTMENT_ULTIMATE_WISE_5",
    ]);
  });

  it("does not list a single-rung family twice", () => {
    expect(levelEndpointTags(deriveFamilies(["ENCHANTMENT_LONE_WOLF_5"]))).toEqual([
      "ENCHANTMENT_LONE_WOLF_5",
    ]);
  });
});

describe("end to end with the Part A solver", () => {
  const fams = deriveFamilies(
    Array.from({ length: 7 }, (_, i) => `ENCHANTMENT_SHARPNESS_${i + 1}`),
  );
  const edges = anvilEdges(fams);

  it("prices a full 1 -> 7 chain at 64 books", () => {
    const result = cheapestPath("ENCHANTMENT_SHARPNESS_7", edges, (t) =>
      t === "ENCHANTMENT_SHARPNESS_1" ? 1000 : null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.entryUnits).toBe(booksRequired(1, 7));
    expect(result.value.unitCost).toBe(64_000);
    expect(result.value.flags).toContain("unverified-edge");
  });

  /** Why the entry level is a search: the cheapest rung to buy is not always the lowest. */
  it("enters mid-chain when the arithmetic says so", () => {
    const prices: Record<string, number> = {
      ENCHANTMENT_SHARPNESS_1: 1000,
      ENCHANTMENT_SHARPNESS_5: 9000,
    };
    const result = cheapestPath("ENCHANTMENT_SHARPNESS_7", edges, (t) => prices[t] ?? null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 4 x 9000 = 36,000 beats 64 x 1000 = 64,000.
    expect(result.value.entryTag).toBe("ENCHANTMENT_SHARPNESS_5");
    expect(result.value.entryUnits).toBe(4);
    expect(result.value.unitCost).toBe(36_000);
  });
});

describe("merge gates — detecting rungs that cannot be merged into", () => {
  const chain = anvilEdges(
    deriveFamilies(["ENCHANTMENT_LOOTING_3", "ENCHANTMENT_LOOTING_4", "ENCHANTMENT_LOOTING_5"]),
  );

  /**
   * The real numbers, 2026-08-26. Looting IV asks 50,000; Looting V asks 172,816,195 —
   * an implied ratio near 1,700. Two Looting IV books do not make a Looting V: that book
   * comes from a minigame, not an anvil. The 1,509% margin the scan first reported was a
   * trade nobody can execute.
   */
  it("withholds the Looting IV -> V rung at real market prices", () => {
    const prices: Record<string, number> = {
      ENCHANTMENT_LOOTING_3: 20_000,
      ENCHANTMENT_LOOTING_4: 50_000,
      ENCHANTMENT_LOOTING_5: 172_816_195,
    };
    const { usable, gated } = detectMergeGates(chain, (t) => prices[t] ?? null);

    expect(gated).toHaveLength(1);
    expect(gated[0]?.edge.to).toBe("ENCHANTMENT_LOOTING_5");
    expect(gated[0]?.impliedRatio).toBeGreaterThan(1000);
    // 3 -> 4 is an ordinary merge and survives, so the family still has an opportunity.
    expect(usable.map((e) => e.to)).toEqual(["ENCHANTMENT_LOOTING_4"]);
  });

  it("keeps ordinary merges, including comfortably profitable ones", () => {
    const prices: Record<string, number> = {
      ENCHANTMENT_LOOTING_3: 20_000,
      ENCHANTMENT_LOOTING_4: 50_000, // implied 1.25 — a real 25% edge
      ENCHANTMENT_LOOTING_5: 130_000, // implied 1.3
    };
    const { usable, gated } = detectMergeGates(chain, (t) => prices[t] ?? null);
    expect(gated).toEqual([]);
    expect(usable).toHaveLength(2);
  });

  /**
   * Absence of evidence is not evidence of a gate. A thin rung that skipped an hour would
   * otherwise have its whole chain deleted — and the solver already refuses to route
   * through a rung it cannot price.
   */
  it("leaves an edge usable when either rung is unpriced", () => {
    const { usable, gated } = detectMergeGates(chain, (t) =>
      t === "ENCHANTMENT_LOOTING_3" ? 20_000 : null,
    );
    expect(gated).toEqual([]);
    expect(usable).toHaveLength(2);
  });

  it("treats a zero input price as unjudgeable rather than infinitely gated", () => {
    const { gated } = detectMergeGates(chain, (t) =>
      t === "ENCHANTMENT_LOOTING_4" ? 0 : 1000,
    );
    expect(gated.every((g) => g.edge.from !== "ENCHANTMENT_LOOTING_4")).toBe(true);
  });

  it("honours a caller-supplied threshold", () => {
    const prices: Record<string, number> = {
      ENCHANTMENT_LOOTING_3: 1000,
      ENCHANTMENT_LOOTING_4: 5000, // implied 2.5
      ENCHANTMENT_LOOTING_5: 12_000,
    };
    const priceOf = (t: string) => prices[t] ?? null;
    expect(detectMergeGates(chain, priceOf, 3).gated).toEqual([]);
    expect(detectMergeGates(chain, priceOf, 2).gated.length).toBeGreaterThan(0);
  });

  it("defaults the threshold to the CLAUDE.md section 8 suspicion line", () => {
    expect(DEFAULT_MAX_IMPLIED_MERGE_RATIO).toBe(3);
  });
});
