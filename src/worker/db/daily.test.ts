import { describe, expect, it } from "vitest";
import { buildDailyUpsert, type DailyRow } from "./daily.js";
import { makeFakeD1 } from "./testHelpers.js";

function makeRow(over: Partial<DailyRow> = {}): DailyRow {
  return {
    tag: "COAL",
    dayTs: 86_400,
    askAvg: 10,
    askMin: 9,
    askMax: 11,
    bidAvg: 8,
    bidMin: 7,
    bidMax: 9,
    ibWeek: 5000,
    isWeek: 6000,
    samples: 24,
    ...over,
  };
}

describe("buildDailyUpsert", () => {
  it("chunks at floor(100/11) = 9 rows per statement", () => {
    const { db, statements } = makeFakeD1();
    const rows = Array.from({ length: 10 }, (_, i) => makeRow({ tag: `TAG_${i}` }));
    buildDailyUpsert(db, rows);
    expect(statements.length).toBe(2); // 9 + 1
    expect(statements[0]!.args.length).toBe(9 * 11);
  });

  it("upserts on the (tag, day_ts) composite key as a wholesale replace", () => {
    const { db, statements } = makeFakeD1();
    buildDailyUpsert(db, [makeRow()]);
    expect(statements[0]!.sql).toContain("ON CONFLICT(tag, day_ts) DO UPDATE SET");
    expect(statements[0]!.sql).toContain("samples = excluded.samples");
  });

  it("binds every column in the declared order", () => {
    const { db, statements } = makeFakeD1();
    const row = makeRow();
    buildDailyUpsert(db, [row]);
    expect(statements[0]!.args).toEqual([
      row.tag,
      row.dayTs,
      row.askAvg,
      row.askMin,
      row.askMax,
      row.bidAvg,
      row.bidMin,
      row.bidMax,
      row.ibWeek,
      row.isWeek,
      row.samples,
    ]);
  });
});
