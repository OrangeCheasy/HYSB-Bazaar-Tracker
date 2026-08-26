import type { ScanRow, ScenarioResult, WarningFlag } from "@core/index.js";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCAN_SORT,
  capitalRequired,
  isSuspicious,
  nextScanSort,
  scanSortByKey,
  sortScanRows,
  tierOf,
} from "./rank.js";
import { splitByCapital } from "../ui/capitalFilter.js";

function scenario(over: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    kind: "timed",
    baseUnitPrice: 1,
    productUnitPrice: 200,
    costPerCraft: 160,
    grossPerCraft: 200,
    taxPerCraft: 2.5,
    profitPerCraft: 37.5,
    marginPct: 0.23,
    fillFeasibility: 0.8,
    ...over,
  };
}

function row(
  product: string,
  over: {
    profitPerDay?: number;
    flags?: readonly WarningFlag[];
    kind?: "compact" | "anvil";
    unscored?: boolean;
    capitalRequired?: number;
    hoursToFillOneCraft?: number;
    timed?: Partial<ScenarioResult>;
    verified?: boolean;
  } = {},
): ScanRow {
  const {
    profitPerDay = 1000,
    flags = [],
    kind = "compact",
    unscored = false,
    capitalRequired: capital = 1_000,
    hoursToFillOneCraft = 1,
    timed = {},
    verified = false,
  } = over;

  const recipe = {
    id: 1,
    baseTag: `BASE_${product}`,
    enchTag: product,
    ratio: 160,
    verified,
    note: null,
  };

  if (unscored) return { recipe, kind, error: "no-base-data" };

  const timedScenario = scenario(timed);
  return {
    recipe,
    kind,
    analysis: {
      recipe,
      scenarios: { floor: scenario(), orders: scenario(), timed: timedScenario },
      throughput: {
        baseUnitsPerDay: 1000,
        productUnitsPerDay: 10,
        craftsFromSupply: 6,
        craftsFromDemand: 10,
        craftsPerDay: 6,
        limitedBy: "base-supply",
        hoursToFillOneCraft,
      },
      profitPerDay,
      capitalPerCraft: capital / 6,
      capitalRequired: capital,
      flags,
    },
  };
}

describe("ranking", () => {
  it("defaults to profit per day descending, never margin", () => {
    expect(DEFAULT_SCAN_SORT).toEqual({ key: "profitPerDay", direction: "desc" });
    const rows = [
      row("DEAD", { profitPerDay: 10, timed: { marginPct: 0.4 } }),
      row("COAL", { profitPerDay: 5_000_000, timed: { marginPct: 0.02 } }),
    ];
    expect(sortScanRows(rows, DEFAULT_SCAN_SORT).map((r) => r.recipe.enchTag)).toEqual([
      "COAL",
      "DEAD",
    ]);
  });

  it("sinks flagged rows below clean ones even when they earn more", () => {
    // 59% of scored rows carry implausible-margin. Left interleaved, a row that cannot be
    // traded heads the table this view exists to answer "what should I set up tonight".
    const rows = [
      row("SUSPECT", { profitPerDay: 999_999_999, flags: ["implausible-margin"] }),
      row("REAL", { profitPerDay: 1_000 }),
    ];
    expect(sortScanRows(rows, DEFAULT_SCAN_SORT).map((r) => r.recipe.enchTag)).toEqual([
      "REAL",
      "SUSPECT",
    ]);
  });

  it("keeps flagged rows in the table rather than filtering them away", () => {
    const rows = [row("SUSPECT", { flags: ["implausible-margin"] }), row("REAL")];
    expect(sortScanRows(rows, DEFAULT_SCAN_SORT)).toHaveLength(2);
  });

  it("does not demote on unverified-recipe, which every row carries", () => {
    // Demoting on it would demote the entire table and order nothing. The row is marked
    // instead, which is what the rule asks for.
    expect(isSuspicious(row("X", { flags: ["unverified-recipe"] }))).toBe(false);
    expect(tierOf(row("X", { flags: ["unverified-recipe"] }))).toBe(0);
  });

  it("treats the three 'this number is probably not real' flags as suspicious", () => {
    for (const flag of [
      "implausible-margin",
      "below-ratio-parity",
      "single-sided-book",
    ] as const) {
      expect(isSuspicious(row("X", { flags: [flag] }))).toBe(true);
    }
    // ...and qualifying flags on a real number as not.
    for (const flag of ["slow-fill", "volatile-base", "stale-data"] as const) {
      expect(isSuspicious(row("X", { flags: [flag] }))).toBe(false);
    }
  });

  it("puts rows with no analysis last, beneath even the flagged ones", () => {
    const rows = [
      row("NODATA", { unscored: true }),
      row("SUSPECT", { flags: ["implausible-margin"] }),
      row("REAL"),
    ];
    expect(sortScanRows(rows, DEFAULT_SCAN_SORT).map((r) => r.recipe.enchTag)).toEqual([
      "REAL",
      "SUSPECT",
      "NODATA",
    ]);
  });

  it("never lets a reversed sort float unscored rows to the top", () => {
    const rows = [row("NODATA", { unscored: true }), row("REAL", { profitPerDay: 5 })];
    const ascending = sortScanRows(rows, { key: "profitPerDay", direction: "asc" });
    expect(ascending[0]?.recipe.enchTag).toBe("REAL");
  });

  it("sinks an unfillable craft in both directions rather than calling it fastest", () => {
    // hoursToFillOneCraft is Infinity when no base flows. "Never fills" must not read as
    // "fills fastest" just because the column sorts ascending.
    const rows = [
      row("FAST", { hoursToFillOneCraft: 2 }),
      row("NEVER", { hoursToFillOneCraft: Number.POSITIVE_INFINITY }),
    ];
    expect(
      sortScanRows(rows, { key: "hoursToFillOneCraft", direction: "asc" })[0]?.recipe.enchTag,
    ).toBe("FAST");
    expect(
      sortScanRows(rows, { key: "hoursToFillOneCraft", direction: "desc" })[0]?.recipe.enchTag,
    ).toBe("FAST");
  });

  it("sorts by craft type so the two kinds can be compared or separated at will", () => {
    const rows = [row("MERGE", { kind: "anvil" }), row("PACK", { kind: "compact" })];
    expect(sortScanRows(rows, { key: "kind", direction: "asc" })[0]?.kind).toBe("anvil");
  });

  it("breaks ties on the product name so rows do not shuffle between renders", () => {
    const rows = [row("ZZZ"), row("AAA"), row("MMM")];
    const first = sortScanRows(rows, DEFAULT_SCAN_SORT).map((r) => r.recipe.enchTag);
    const again = sortScanRows([...rows].reverse(), DEFAULT_SCAN_SORT).map(
      (r) => r.recipe.enchTag,
    );
    expect(first).toEqual(again);
  });
});

describe("sort controls", () => {
  it("starts hours-to-fill ascending, because fewer hours is better", () => {
    expect(nextScanSort(DEFAULT_SCAN_SORT, "hoursToFillOneCraft")).toEqual({
      key: "hoursToFillOneCraft",
      direction: "asc",
    });
  });

  it("flips only the column already active", () => {
    expect(nextScanSort(DEFAULT_SCAN_SORT, "profitPerDay").direction).toBe("asc");
    expect(scanSortByKey(DEFAULT_SCAN_SORT, "profitPerDay")).toEqual(DEFAULT_SCAN_SORT);
  });
});

describe("capital filter", () => {
  it("hides crafts costing more than the capital set, and counts them", () => {
    const rows = [
      row("CHEAP", { capitalRequired: 100 }),
      row("DEAR", { capitalRequired: 10_000 }),
    ];
    const split = splitByCapital(rows, 1_000, capitalRequired);
    expect(split.affordable.map((r) => r.recipe.enchTag)).toEqual(["CHEAP"]);
    expect(split.hiddenCount).toBe(1);
  });

  it("keeps a row whose cost is unknown rather than hiding it", () => {
    // "We do not know what this costs" is not a reason to remove it from view, and hiding
    // it would make the filter look like it had found something.
    const rows = [row("NODATA", { unscored: true })];
    expect(splitByCapital(rows, 1, capitalRequired).affordable).toHaveLength(1);
  });

  it("treats unset capital as no constraint, not as zero", () => {
    const rows = [row("DEAR", { capitalRequired: 10_000 })];
    expect(splitByCapital(rows, null, capitalRequired).affordable).toHaveLength(1);
    expect(splitByCapital(rows, 0, capitalRequired).affordable).toHaveLength(0);
  });
});
