import { describe, expect, it } from "vitest";
import { runAnvilScan, DEFAULT_SCAN_PARAMS } from "./scan.js";

const NOW = 1_800_000_000;
const HOUR = 3600;

interface Seeded {
  readonly anvilRecipes: readonly { base_tag: string; ench_tag: string; ratio: number }[];
  /** tag -> latest ask, the batch price feed the entry search runs on. */
  readonly bookAsks: Readonly<Record<string, number>>;
  /** tag -> a flat hourly series, used by buildCraftAnalysis. */
  readonly series: Readonly<Record<string, { ask: number; bid: number; isWeek: number }>>;
}

/**
 * Routes by SQL shape rather than by call order, so adding a query to the scan does not
 * silently shift a fixture onto the wrong statement the way a strict queue does.
 */
function makeDb(seed: Seeded): Pick<D1Database, "prepare"> {
  return {
    prepare(sql: string) {
      const stmt = {
        bound: [] as unknown[],
        bind(...args: unknown[]) {
          stmt.bound = args;
          return stmt;
        },
        async all() {
          if (sql.includes("FROM recipes")) {
            return {
              results: seed.anvilRecipes.map((r, i) => ({
                id: i + 1,
                base_tag: r.base_tag,
                ench_tag: r.ench_tag,
                ratio: r.ratio,
                verified: 0,
                note: null,
                kind: "anvil",
              })),
            } as unknown as D1Result;
          }
          if (sql.includes("MAX(hour_ts)")) {
            return {
              results: Object.entries(seed.bookAsks).map(([tag, ask_avg]) => ({
                tag,
                ask_avg,
              })),
            } as unknown as D1Result;
          }
          // Per-tag hourly series for buildCraftAnalysis.
          const tag = String(stmt.bound[0] ?? "");
          const s = seed.series[tag];
          if (!s) return { results: [] } as unknown as D1Result;
          const rows = Array.from({ length: 24 }, (_, i) => ({
            hour_ts: NOW - (24 - i) * HOUR,
            ask_avg: s.ask,
            ask_min: s.ask,
            ask_max: s.ask,
            bid_avg: s.bid,
            bid_min: s.bid,
            bid_max: s.bid,
            ask_depth: 10_000,
            bid_depth: 10_000,
            ib_week: s.isWeek,
            is_week: s.isWeek,
            samples: 12,
            source: "hypixel",
          }));
          return { results: rows } as unknown as D1Result;
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  };
}

/** Sharpness 1..4, three merge edges. */
const SHARPNESS_EDGES = [1, 2, 3].map((l) => ({
  base_tag: `ENCHANTMENT_SHARPNESS_${l}`,
  ench_tag: `ENCHANTMENT_SHARPNESS_${l + 1}`,
  ratio: 2,
}));

describe("runAnvilScan", () => {
  /**
   * One row per FAMILY, not per edge. Three edges in, one opportunity out — buy the
   * cheapest rung, merge to the top, sell.
   */
  it("emits one row per family, targeting the top rung", async () => {
    const db = makeDb({
      anvilRecipes: SHARPNESS_EDGES,
      bookAsks: {
        ENCHANTMENT_SHARPNESS_1: 1000,
        ENCHANTMENT_SHARPNESS_4: 50_000,
      },
      series: {
        ENCHANTMENT_SHARPNESS_1: { ask: 1000, bid: 950, isWeek: 100_000 },
        ENCHANTMENT_SHARPNESS_4: { ask: 50_000, bid: 48_000, isWeek: 5_000 },
      },
    });

    const { rows } = await runAnvilScan(db, DEFAULT_SCAN_PARAMS, NOW);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.kind).toBe("anvil");
    expect(row?.recipe.enchTag).toBe("ENCHANTMENT_SHARPNESS_4");
    expect(row?.recipe.baseTag).toBe("ENCHANTMENT_SHARPNESS_1");
    // 2^3 books of level 1 per level-4 book — the ratio the whole chain collapses to.
    expect(row?.recipe.ratio).toBe(8);
    expect(row?.plan?.steps).toHaveLength(3);
  });

  /** Every anvil recipe is unverified: whether each rung really merges is not something
   *  tag names can confirm, even though 2^k itself is arithmetic. */
  it("marks the synthesized recipe unverified", async () => {
    const db = makeDb({
      anvilRecipes: SHARPNESS_EDGES,
      bookAsks: { ENCHANTMENT_SHARPNESS_1: 1000 },
      series: {
        ENCHANTMENT_SHARPNESS_1: { ask: 1000, bid: 950, isWeek: 100_000 },
        ENCHANTMENT_SHARPNESS_4: { ask: 50_000, bid: 48_000, isWeek: 5_000 },
      },
    });
    const { rows } = await runAnvilScan(db, DEFAULT_SCAN_PARAMS, NOW);
    expect(rows[0]?.recipe.verified).toBe(false);
    expect(rows[0]?.analysis?.flags).toContain("unverified-recipe");
  });

  /**
   * The entry search is the point of Part A. Level 3 at 3,000 needs only 2 books
   * (6,000) where level 1 at 1,000 needs 8 (8,000), so the cheaper entry wins.
   */
  it("enters mid-chain when that is cheaper, and reports the chosen rung", async () => {
    const db = makeDb({
      anvilRecipes: SHARPNESS_EDGES,
      bookAsks: {
        ENCHANTMENT_SHARPNESS_1: 1000,
        ENCHANTMENT_SHARPNESS_3: 3000,
      },
      series: {
        ENCHANTMENT_SHARPNESS_3: { ask: 3000, bid: 2900, isWeek: 20_000 },
        ENCHANTMENT_SHARPNESS_4: { ask: 50_000, bid: 48_000, isWeek: 5_000 },
      },
    });

    const { rows } = await runAnvilScan(db, DEFAULT_SCAN_PARAMS, NOW);
    expect(rows[0]?.recipe.baseTag).toBe("ENCHANTMENT_SHARPNESS_3");
    expect(rows[0]?.recipe.ratio).toBe(2);
    expect(rows[0]?.plan?.entryUnits).toBe(2);
  });

  /**
   * When buying the finished book beats every merge route the solver returns an empty
   * path. That is a real answer, but it is not a craft, so it must not appear as one —
   * a zero-step "craft" would render as an opportunity with no work behind it.
   */
  it("drops a family where buying the top rung beats merging", async () => {
    const db = makeDb({
      anvilRecipes: SHARPNESS_EDGES,
      bookAsks: {
        ENCHANTMENT_SHARPNESS_1: 1000,
        ENCHANTMENT_SHARPNESS_4: 500, // absurdly cheap: buying wins outright
      },
      series: {
        ENCHANTMENT_SHARPNESS_1: { ask: 1000, bid: 950, isWeek: 100_000 },
        ENCHANTMENT_SHARPNESS_4: { ask: 500, bid: 480, isWeek: 5_000 },
      },
    });

    const { rows } = await runAnvilScan(db, DEFAULT_SCAN_PARAMS, NOW);
    expect(rows).toEqual([]);
  });

  it("returns nothing when no anvil recipes are seeded", async () => {
    const db = makeDb({ anvilRecipes: [], bookAsks: {}, series: {} });
    const { rows, dataTo } = await runAnvilScan(db, DEFAULT_SCAN_PARAMS, NOW);
    expect(rows).toEqual([]);
    expect(dataTo).toBe(NOW);
  });

  /**
   * Throughput is what turns a margin into a ranking (CLAUDE.md section 8: rank by
   * profit-per-day, never by margin). Two families with identical prices but different
   * volume must not tie — the liquid one has to win.
   */
  it("lets sell/buy volume drive profit/day between otherwise identical families", async () => {
    const edges = [
      ...SHARPNESS_EDGES,
      ...[1, 2, 3].map((l) => ({
        base_tag: `ENCHANTMENT_GROWTH_${l}`,
        ench_tag: `ENCHANTMENT_GROWTH_${l + 1}`,
        ratio: 2,
      })),
    ];
    const db = makeDb({
      anvilRecipes: edges,
      bookAsks: {
        ENCHANTMENT_SHARPNESS_1: 1000,
        ENCHANTMENT_GROWTH_1: 1000,
      },
      series: {
        ENCHANTMENT_SHARPNESS_1: { ask: 1000, bid: 950, isWeek: 500_000 },
        ENCHANTMENT_SHARPNESS_4: { ask: 50_000, bid: 48_000, isWeek: 70_000 },
        ENCHANTMENT_GROWTH_1: { ask: 1000, bid: 950, isWeek: 500 },
        ENCHANTMENT_GROWTH_4: { ask: 50_000, bid: 48_000, isWeek: 70 },
      },
    });

    const { rows } = await runAnvilScan(db, DEFAULT_SCAN_PARAMS, NOW);
    const sharpness = rows.find((r) => r.recipe.enchTag.includes("SHARPNESS"));
    const growth = rows.find((r) => r.recipe.enchTag.includes("GROWTH"));

    expect(sharpness?.analysis).toBeDefined();
    expect(growth?.analysis).toBeDefined();
    // Same prices, same margin per craft — only the volume differs.
    expect(sharpness?.analysis?.scenarios.floor.profitPerCraft).toBeCloseTo(
      growth?.analysis?.scenarios.floor.profitPerCraft ?? 0,
      6,
    );
    expect(sharpness?.analysis?.profitPerDay).toBeGreaterThan(
      growth?.analysis?.profitPerDay ?? 0,
    );
  });
});
