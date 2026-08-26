import { describe, expect, it } from "vitest";
import { cheapestPath, type AcquisitionPrice, type ConversionEdge } from "../src/convert.js";

function edge(
  from: string,
  to: string,
  inputPerOutput: number,
  overrides: Partial<ConversionEdge> = {},
): ConversionEdge {
  return {
    from,
    to,
    inputPerOutput,
    stepCost: 0,
    kind: "compact",
    verified: true,
    recipeId: null,
    ...overrides,
  };
}

function prices(table: Readonly<Record<string, number>>): AcquisitionPrice {
  return (tag) => table[tag] ?? null;
}

/**
 * Prices are fixed rather than pulled from live data so the test stays deterministic, but
 * they are the real 2026-08-25 figures rounded, so the conclusions below are the ones a
 * real scan would reach.
 */
const SUGAR_PRICES = prices({
  SUGAR_CANE: 18.19,
  ENCHANTED_SUGAR: 674.53,
  ENCHANTED_SUGAR_CANE: 105_975,
});

const SUGAR_CHAIN = [
  edge("SUGAR_CANE", "ENCHANTED_SUGAR", 160),
  edge("ENCHANTED_SUGAR", "ENCHANTED_SUGAR_CANE", 160),
];

/** The mis-seeded single step that migration 0006 removed from production. */
const BOGUS_ONE_STEP = edge("SUGAR_CANE", "ENCHANTED_SUGAR_CANE", 160);

describe("the sugar cane bug this module exists to prevent", () => {
  /**
   * The original defect, reproduced. Seeded as one 160:1 hop off raw sugar cane, an
   * ENCHANTED_SUGAR_CANE appears to cost ~2,910 against a market price of ~106,000 — a
   * ~3,000% margin, and it ranked first in production at 1.77 billion profit/day.
   */
  it("prices the bogus one-step interpretation absurdly cheaply", () => {
    const result = cheapestPath("ENCHANTED_SUGAR_CANE", [BOGUS_ONE_STEP], SUGAR_PRICES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.unitCost).toBeCloseTo(2910.4, 1);
    expect(result.value.beatsDirect).toBe(true);
    // 36x cheaper than simply buying it. That ratio is the smell.
    expect(result.value.directPrice! / result.value.unitCost).toBeGreaterThan(30);
  });

  /**
   * The real chain, and the answer is counterintuitive: crafting LOSES. Buying outright
   * costs 105,975; the cheapest craft (160 x ENCHANTED_SUGAR) costs 107,925, about 2%
   * worse. "Don't craft this" is the correct output, and asserting a craft path here
   * would be asserting a bug.
   */
  it("concludes that buying beats crafting, once the real chain is priced", () => {
    const result = cheapestPath("ENCHANTED_SUGAR_CANE", SUGAR_CHAIN, SUGAR_PRICES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.unitCost).toBe(105_975);
    expect(result.value.entryTag).toBe("ENCHANTED_SUGAR_CANE");
    expect(result.value.steps).toEqual([]);
    expect(result.value.beatsDirect).toBe(false);
  });

  /**
   * Both interpretations offered at once: the solver must not be rescued by only ever
   * seeing correct data. With the bogus edge present it still wins on price, which is
   * exactly why a wrong ratio is dangerous rather than merely inaccurate — the fix is
   * seeding the right edges, and this test documents that boundary.
   */
  it("cannot tell a wrong ratio from a real bargain — that is what `verified` is for", () => {
    const result = cheapestPath(
      "ENCHANTED_SUGAR_CANE",
      [...SUGAR_CHAIN, { ...BOGUS_ONE_STEP, verified: false }],
      SUGAR_PRICES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.unitCost).toBeCloseTo(2910.4, 1);
    expect(result.value.flags).toContain("unverified-edge");
  });

  /** Full chain from raw cane: 160 x 160 = 25,600 units, and a heavy loss. */
  it("composes ratios across steps when the entry is the raw material", () => {
    const result = cheapestPath(
      "ENCHANTED_SUGAR_CANE",
      SUGAR_CHAIN,
      prices({ SUGAR_CANE: 18.19, ENCHANTED_SUGAR: 1e9 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.entryTag).toBe("SUGAR_CANE");
    expect(result.value.entryUnits).toBe(25_600);
    expect(result.value.unitCost).toBeCloseTo(18.19 * 25_600, 2);
    expect(result.value.steps).toHaveLength(2);
  });
});

describe("anvil chains", () => {
  const sharpness = [1, 2, 3, 4, 5, 6].map((lvl) =>
    edge(`ENCHANTMENT_SHARPNESS_${lvl}`, `ENCHANTMENT_SHARPNESS_${lvl + 1}`, 2, {
      kind: "anvil",
    }),
  );

  /**
   * The fact most likely to be re-derived wrong: 1 -> 7 is 2^6 = 64 books, not 6. No edge
   * in this graph knows about powers of two; 64 is the product of six 2s.
   */
  it("costs 64 level-1 books to reach level 7, not 6", () => {
    const result = cheapestPath(
      "ENCHANTMENT_SHARPNESS_7",
      sharpness,
      prices({ ENCHANTMENT_SHARPNESS_1: 1000 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.entryTag).toBe("ENCHANTMENT_SHARPNESS_1");
    expect(result.value.entryUnits).toBe(64);
    expect(result.value.unitCost).toBe(64_000);
    expect(result.value.steps).toHaveLength(6);
  });

  /**
   * The reason entry level is a search and not an assumption: level 1 at 1,000 each
   * implies 64,000, but level 4 at 6,000 needs only 8 books for 48,000.
   */
  it("enters partway up the chain when that is cheaper", () => {
    const result = cheapestPath(
      "ENCHANTMENT_SHARPNESS_7",
      sharpness,
      prices({ ENCHANTMENT_SHARPNESS_1: 1000, ENCHANTMENT_SHARPNESS_4: 6000 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.entryTag).toBe("ENCHANTMENT_SHARPNESS_4");
    expect(result.value.entryUnits).toBe(8);
    expect(result.value.unitCost).toBe(48_000);
    expect(result.value.steps).toHaveLength(3);
  });

  /**
   * Step cost is per merge, not per book: reaching level 7 from level 1 performs six
   * merges per output unit. Charging it per book would be 64x too much.
   */
  it("charges the anvil fee once per merge level and flags it as unverified", () => {
    const withFee = sharpness.map((e) => ({ ...e, stepCost: 100 }));
    const result = cheapestPath(
      "ENCHANTMENT_SHARPNESS_3",
      withFee,
      prices({ ENCHANTMENT_SHARPNESS_1: 1000 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // (1000*2 + 100) = 2100 for level 2; (2100*2 + 100) = 4300 for level 3.
    expect(result.value.unitCost).toBe(4300);
    expect(result.value.flags).toContain("unverified-step-cost");
  });

  /**
   * Regression on the default depth cap. Eleven enchant families span levels 1-10 — nine
   * merges — and the first DEFAULT_MAX_DEPTH written here was 8, which would have made
   * every one of them return "no-acquisition-path" instead of a price. Silent, and wrong
   * for 11 of 155 families.
   */
  it("handles a nine-merge 1->10 family at default depth", () => {
    const deep = Array.from({ length: 9 }, (_, i) =>
      edge(`ENCHANTMENT_HECATOMB_${i + 1}`, `ENCHANTMENT_HECATOMB_${i + 2}`, 2, {
        kind: "anvil",
      }),
    );
    const result = cheapestPath(
      "ENCHANTMENT_HECATOMB_10",
      deep,
      prices({ ENCHANTMENT_HECATOMB_1: 5 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.entryUnits).toBe(512); // 2^9
    expect(result.value.unitCost).toBe(2560);
    expect(result.value.steps).toHaveLength(9);
    expect(result.value.flags).toContain("deep-chain");
  });

  /** Six merges is an ordinary craft and must not be flagged as deep. */
  it("does not flag an ordinary Sharpness 1->7 chain as deep", () => {
    const result = cheapestPath(
      "ENCHANTMENT_SHARPNESS_7",
      sharpness,
      prices({ ENCHANTMENT_SHARPNESS_1: 1000 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.flags).not.toContain("deep-chain");
  });

  it("prefers buying the finished book when the chain is more expensive", () => {
    const result = cheapestPath(
      "ENCHANTMENT_SHARPNESS_7",
      sharpness,
      prices({ ENCHANTMENT_SHARPNESS_1: 1000, ENCHANTMENT_SHARPNESS_7: 40_000 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.unitCost).toBe(40_000);
    expect(result.value.steps).toEqual([]);
    expect(result.value.beatsDirect).toBe(false);
  });
});

describe("graph safety", () => {
  /**
   * Recipe graphs are not guaranteed acyclic, and a cycle is the classic way a naive
   * relaxation loop hangs. It cannot spiral here because inputPerOutput >= 1 means
   * traversing an edge never lowers cost — the property that makes Dijkstra valid.
   */
  it("terminates on a cyclic graph", () => {
    const cyclic = [edge("A", "B", 2), edge("B", "C", 2), edge("C", "A", 2)];
    const result = cheapestPath("C", cyclic, prices({ A: 10 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unitCost).toBe(40);
  });

  it("reports no-acquisition-path when nothing on the route is priced", () => {
    const result = cheapestPath("C", [edge("A", "B", 2), edge("B", "C", 2)], prices({}));
    expect(result).toEqual({ ok: false, error: "no-acquisition-path" });
  });

  it("reports unknown-target for a tag that appears nowhere", () => {
    const result = cheapestPath("NOPE", [edge("A", "B", 2)], prices({ A: 1 }));
    expect(result).toEqual({ ok: false, error: "unknown-target" });
  });

  it.each([
    ["zero ratio", edge("A", "B", 0)],
    ["fractional ratio", edge("A", "B", 1.5)],
    ["self-referential", edge("A", "A", 2)],
    ["negative step cost", edge("A", "B", 2, { stepCost: -1 })],
    ["empty tag", edge("", "B", 2)],
  ])("rejects an %s edge", (_label, bad) => {
    expect(cheapestPath("B", [bad], prices({ A: 1 }))).toEqual({
      ok: false,
      error: "invalid-edge",
    });
  });

  it("raises deep-chain past the threshold", () => {
    const long = [1, 2, 3, 4, 5, 6].map((i) => edge(`T${i}`, `T${i + 1}`, 2));
    const result = cheapestPath("T7", long, prices({ T1: 1 }), {
      deepChainThreshold: 4,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.flags).toContain("deep-chain");
  });

  it("ignores routes longer than maxDepth", () => {
    const long = [1, 2, 3, 4, 5, 6].map((i) => edge(`T${i}`, `T${i + 1}`, 2));
    const result = cheapestPath("T7", long, prices({ T1: 1 }), { maxDepth: 3 });
    expect(result).toEqual({ ok: false, error: "no-acquisition-path" });
  });

  it("treats a zero or negative price as unbuyable rather than free", () => {
    // A zero price would otherwise make everything downstream free, which is worse than
    // reporting no route: it produces a confident, enormous, wrong margin.
    const result = cheapestPath("B", [edge("A", "B", 160)], prices({ A: 0 }));
    expect(result).toEqual({ ok: false, error: "no-acquisition-path" });
  });
});

describe("plan bookkeeping", () => {
  const chain = [edge("A", "B", 160), edge("B", "C", 160)];

  it("reports per-step input units relative to the final target", () => {
    const result = cheapestPath("C", chain, prices({ A: 1 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [first, second] = result.value.steps;
    expect(first?.edge.from).toBe("A");
    expect(first?.inputUnits).toBe(25_600); // 160 * 160 units of A per one C
    expect(second?.edge.from).toBe("B");
    expect(second?.inputUnits).toBe(160); // 160 units of B per one C
    expect(second?.unitCostAfter).toBe(result.value.unitCost);
  });

  it("carries edge kind through without branching on it", () => {
    const mixed = [
      edge("RAW", "MID", 160, { kind: "compact" }),
      edge("MID", "TOP", 2, { kind: "anvil" }),
    ];
    const result = cheapestPath("TOP", mixed, prices({ RAW: 1 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.steps.map((s) => s.edge.kind)).toEqual(["compact", "anvil"]);
    expect(result.value.unitCost).toBe(320);
  });

  it("returns a clean plan with no flags when every edge is verified and free", () => {
    const result = cheapestPath("C", chain, prices({ A: 1 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.flags).toEqual([]);
  });
});
