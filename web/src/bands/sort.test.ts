import type { BandScanRow } from "@core/index.js";
import { describe, expect, it } from "vitest";
import { capitalPerDay, isAffordable, splitByCapital } from "./capital.js";
import { DEFAULT_SORT, nextSort, sortByKey, sortRows } from "./sort.js";
import { displayTag } from "../tagName.js";

/**
 * The band table's logic, tested away from the DOM. A table that sorts by the wrong key
 * survives a visual review — every row still looks plausible — so the comparators are
 * where the checking has to happen.
 */

function row(
  tag: string,
  over: Partial<{
    profitPerDay: number;
    spreadPct: number;
    buyBand: number;
    sellBand: number;
    buyRate: number;
    sellRate: number;
    bothHitWeeks: number;
    weekCount: number;
    capitalPerUnit: number;
    unitsPerDay: number;
  }> = {},
): BandScanRow {
  const {
    profitPerDay = 0,
    spreadPct = 0,
    buyBand = 100,
    sellBand = 200,
    buyRate = 0.5,
    sellRate = 0.5,
    bothHitWeeks = 1,
    weekCount = 4,
    capitalPerUnit = 10,
    unitsPerDay = 100,
  } = over;

  return {
    tag,
    band: {
      buyBand,
      sellBand,
      spread: sellBand - buyBand,
      spreadPct,
      buyHits: { hoursTouched: Math.round(buyRate * 168), hoursTotal: 168, rate: buyRate },
      sellHits: { hoursTouched: Math.round(sellRate * 168), hoursTotal: 168, rate: sellRate },
      bothHitWeeks,
      weekCount,
      flags: [],
    },
    economics: {
      grossPerUnit: sellBand - buyBand,
      taxPerUnit: 0,
      netPerUnit: sellBand - buyBand,
      capitalPerUnit,
      profitPerDay,
      throughput: { marketUnitsPerDay: unitsPerDay, unitsPerDay, limitedBy: "hit-rate" },
      marginPct: spreadPct,
    },
  };
}

describe("sortRows", () => {
  it("defaults to profit per day descending, never margin", () => {
    // CLAUDE.md §8: a huge spread on a tag nobody trades is not the better trade.
    const rows = [
      row("DEAD_ITEM", { profitPerDay: 1_000, spreadPct: 0.9 }),
      row("COAL", { profitPerDay: 5_000_000, spreadPct: 0.03 }),
    ];
    expect(DEFAULT_SORT).toEqual({ key: "profitPerDay", direction: "desc" });
    expect(sortRows(rows, DEFAULT_SORT).map((r) => r.tag)).toEqual(["COAL", "DEAD_ITEM"]);
  });

  it("does not mutate the array it is given", () => {
    const rows = [row("B", { profitPerDay: 1 }), row("A", { profitPerDay: 2 })];
    const before = rows.map((r) => r.tag);
    sortRows(rows, DEFAULT_SORT);
    expect(rows.map((r) => r.tag)).toEqual(before);
  });

  it("sorts tags by what is on screen, not by the raw tag", () => {
    // "Sharpness 1" should sort under S, not under E for ENCHANTMENT_.
    const rows = [row("ENCHANTMENT_SHARPNESS_1"), row("COAL"), row("ZOMBIE_HEART")];
    const order = sortRows(rows, { key: "tag", direction: "asc" }).map((r) =>
      displayTag(r.tag),
    );
    expect(order).toEqual(["Coal", "Sharpness 1", "Zombie Heart"]);
  });

  it("breaks ties on the tag so the order is stable between renders", () => {
    const rows = [
      row("ZZZ", { profitPerDay: 100 }),
      row("AAA", { profitPerDay: 100 }),
      row("MMM", { profitPerDay: 100 }),
    ];
    const first = sortRows(rows, DEFAULT_SORT).map((r) => r.tag);
    const second = sortRows([...rows].reverse(), DEFAULT_SORT).map((r) => r.tag);
    expect(first).toEqual(["AAA", "MMM", "ZZZ"]);
    expect(second).toEqual(first);
  });

  it("sinks a non-finite figure in BOTH directions rather than floating it to the top", () => {
    // A zero-volume tag can divide by zero somewhere in economics. Ascending, an Infinity
    // at the top would read as the cheapest thing on the board.
    const rows = [
      row("GOOD", { capitalPerUnit: 10, unitsPerDay: 10 }),
      row("BROKEN", { capitalPerUnit: Number.POSITIVE_INFINITY, unitsPerDay: 1 }),
    ];
    expect(sortRows(rows, { key: "capitalPerDay", direction: "asc" })[0]?.tag).toBe("GOOD");
    expect(sortRows(rows, { key: "capitalPerDay", direction: "desc" })[0]?.tag).toBe("GOOD");
  });

  it("sorts by each band and each fill rate independently", () => {
    const rows = [
      row("LOW_BUY_HIGH_FILL", { buyBand: 10, buyRate: 0.9 }),
      row("HIGH_BUY_LOW_FILL", { buyBand: 900, buyRate: 0.1 }),
    ];
    expect(sortRows(rows, { key: "buyBand", direction: "desc" })[0]?.tag).toBe(
      "HIGH_BUY_LOW_FILL",
    );
    expect(sortRows(rows, { key: "buyHitRate", direction: "desc" })[0]?.tag).toBe(
      "LOW_BUY_HIGH_FILL",
    );
  });
});

describe("sort controls", () => {
  it("starts a new column in its natural direction and flips the current one", () => {
    expect(nextSort(DEFAULT_SORT, "tag")).toEqual({ key: "tag", direction: "asc" });
    expect(nextSort(DEFAULT_SORT, "profitPerDay")).toEqual({
      key: "profitPerDay",
      direction: "asc",
    });
  });

  it("never flips when the mobile menu re-picks the column already selected", () => {
    expect(sortByKey(DEFAULT_SORT, "profitPerDay")).toEqual(DEFAULT_SORT);
    expect(sortByKey(DEFAULT_SORT, "tag")).toEqual({ key: "tag", direction: "asc" });
  });
});

describe("capital", () => {
  it("measures a full day of turnover, not one unit", () => {
    // A 20M-coin book is not "affordable" on the strength of buying exactly one.
    expect(capitalPerDay(row("BOOK", { capitalPerUnit: 20_000_000, unitsPerDay: 3 }))).toBe(
      60_000_000,
    );
  });

  it("treats an unset capital as no constraint, not as zero", () => {
    const expensive = row("BOOK", { capitalPerUnit: 20_000_000, unitsPerDay: 3 });
    expect(isAffordable(expensive, null)).toBe(true);
    expect(isAffordable(expensive, 0)).toBe(false);
  });

  it("counts what it hides instead of dropping rows silently", () => {
    const rows = [
      row("CHEAP", { capitalPerUnit: 1, unitsPerDay: 100 }),
      row("DEAR", { capitalPerUnit: 1_000_000, unitsPerDay: 100 }),
    ];
    const split = splitByCapital(rows, 1_000);
    expect(split.affordable.map((r) => r.tag)).toEqual(["CHEAP"]);
    expect(split.hiddenCount).toBe(1);
  });

  it("includes a row costing exactly the capital available", () => {
    const exact = row("EXACT", { capitalPerUnit: 10, unitsPerDay: 10 });
    expect(isAffordable(exact, 100)).toBe(true);
  });
});

describe("displayTag", () => {
  it("reads enchanted books as an enchant and a level", () => {
    expect(displayTag("ENCHANTMENT_SHARPNESS_1")).toBe("Sharpness 1");
    expect(displayTag("ENCHANTMENT_ULTIMATE_WISE_5")).toBe("Ultimate Wise 5");
  });

  it("title-cases ordinary tags", () => {
    expect(displayTag("ENCHANTED_SUGAR_CANE")).toBe("Enchanted Sugar Cane");
    expect(displayTag("COAL")).toBe("Coal");
  });

  it("keeps double-digit levels intact", () => {
    // FEATHER_FALLING runs 1-10 and then jumps to 20 — the level is not one character.
    expect(displayTag("ENCHANTMENT_FEATHER_FALLING_10")).toBe("Feather Falling 10");
    expect(displayTag("ENCHANTMENT_FEATHER_FALLING_20")).toBe("Feather Falling 20");
  });
});
