import { describe, expect, it } from "vitest";
import { buildProductsUpsert, type ProductRow } from "./products.js";
import { makeFakeD1 } from "./testHelpers.js";

describe("buildProductsUpsert", () => {
  it("chunks at floor(100/5) = 20 rows per statement", () => {
    const { db, statements } = makeFakeD1();
    const rows: ProductRow[] = Array.from({ length: 25 }, (_, i) => ({
      tag: `TAG_${i}`,
      isEnchanted: false,
      tier: "B",
      ts: 1000,
    }));
    buildProductsUpsert(db, rows);
    expect(statements.length).toBe(2);
    expect(statements[0]!.args.length).toBe(20 * 5);
    expect(statements[1]!.args.length).toBe(5 * 5);
  });

  it("never overwrites first_seen on conflict", () => {
    const { db, statements } = makeFakeD1();
    buildProductsUpsert(db, [{ tag: "COAL", isEnchanted: false, tier: "A", ts: 1000 }]);
    expect(statements[0]!.sql).toContain("ON CONFLICT(tag) DO UPDATE SET");
    expect(statements[0]!.sql).not.toMatch(/first_seen\s*=\s*excluded\.first_seen/);
  });

  it("binds args in (tag, is_enchanted, tier, first_seen, last_seen) order, boolean as 0/1", () => {
    const { db, statements } = makeFakeD1();
    buildProductsUpsert(db, [
      { tag: "ENCHANTED_COAL", isEnchanted: true, tier: "A", ts: 1_700_000_000 },
    ]);
    expect(statements[0]!.args).toEqual([
      "ENCHANTED_COAL",
      1,
      "A",
      1_700_000_000,
      1_700_000_000,
    ]);
  });
});
