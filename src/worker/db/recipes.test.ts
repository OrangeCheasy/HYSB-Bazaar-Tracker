import { describe, expect, it } from "vitest";
import { anvilEdges, deriveFamilies } from "@core/index.js";
import {
  buildAnvilRecipePrune,
  buildAnvilRecipeUpsert,
  type AnvilRecipeRow,
} from "./recipes.js";
import { makeFakeD1 } from "./testHelpers.js";

function rowsFromTags(tags: readonly string[]): AnvilRecipeRow[] {
  return anvilEdges(deriveFamilies(tags)).map((e) => ({
    baseTag: e.from,
    enchTag: e.to,
    ratio: e.inputPerOutput,
  }));
}

describe("buildAnvilRecipeUpsert", () => {
  it("writes kind='anvil' and verified=0 for every row", () => {
    const { db, statements } = makeFakeD1();
    buildAnvilRecipeUpsert(db, rowsFromTags(["ENCHANTMENT_X_1", "ENCHANTMENT_X_2"]));

    expect(statements).toHaveLength(1);
    expect(statements[0]?.args).toEqual(["ENCHANTMENT_X_1", "ENCHANTMENT_X_2", 2, 0, "anvil"]);
  });

  /**
   * D1 caps bound parameters at 100 per query regardless of plan (CLAUDE.md section 3).
   * At 5 params per row that is 20 rows per statement, so the real ~620 edges must come
   * out as ~31 statements — never one giant INSERT.
   */
  it("chunks by parameter count, not row count", () => {
    const { db, statements } = makeFakeD1();
    const many: AnvilRecipeRow[] = Array.from({ length: 620 }, (_, i) => ({
      baseTag: `ENCHANTMENT_F${i}_1`,
      enchTag: `ENCHANTMENT_F${i}_2`,
      ratio: 2,
    }));
    buildAnvilRecipeUpsert(db, many);

    expect(statements).toHaveLength(31); // ceil(620 / 20)
    for (const s of statements) {
      expect(s.args.length).toBeLessThanOrEqual(100);
    }
  });

  /**
   * If someone confirms a merge in-game and flips `verified`, the next nightly sync must
   * not quietly undo it. The conflict clause therefore updates ratio and kind but never
   * verified.
   */
  it("does not reset verified on conflict", () => {
    const { db, statements } = makeFakeD1();
    buildAnvilRecipeUpsert(db, rowsFromTags(["ENCHANTMENT_X_1", "ENCHANTMENT_X_2"]));

    const sql = statements[0]?.sql ?? "";
    expect(sql).toContain("ON CONFLICT(base_tag, ench_tag) DO UPDATE SET");
    expect(sql).toContain("ratio = excluded.ratio");
    expect(sql).not.toContain("verified = excluded.verified");
  });

  it("emits nothing for an empty edge set", () => {
    const { db, statements } = makeFakeD1();
    buildAnvilRecipeUpsert(db, []);
    expect(statements).toHaveLength(0);
  });
});

describe("buildAnvilRecipePrune", () => {
  /**
   * Binds nothing on purpose. Expressing the keep-list as `NOT IN (...620 keys...)` would
   * need 620 bound parameters against a cap of 100, and chunking it is not an option —
   * each chunk's NOT IN would delete exactly what the other chunks intended to keep.
   */
  it("takes no bound parameters", () => {
    const { db, statements } = makeFakeD1();
    buildAnvilRecipePrune(db);
    // prepare() without bind() records nothing in the fake; the point is that the
    // statement is constructible with no arguments at all.
    expect(statements).toHaveLength(0);
  });

  it("is scoped to anvil rows so a curated compaction recipe cannot be deleted", () => {
    const seen: string[] = [];
    const db: Pick<D1Database, "prepare"> = {
      prepare(sql: string) {
        seen.push(sql);
        return {} as unknown as D1PreparedStatement;
      },
    };
    buildAnvilRecipePrune(db);

    const sql = seen[0] ?? "";
    expect(sql).toContain("kind = 'anvil'");
    expect(sql).toContain("NOT IN (SELECT tag FROM products)");
  });
});
