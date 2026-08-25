import { describe, expect, it } from "vitest";
import { buildSnapshotsUpsert, type SnapshotRow } from "./snapshots.js";
import { makeFakeD1 } from "./testHelpers.js";

function makeRow(over: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    tag: "COAL",
    ts: 1000,
    ask: 5.43,
    bid: 4.98,
    askDepth: 1000,
    bidDepth: 2000,
    ibWeek: 50_000,
    isWeek: 60_000,
    askDepth1pct: 100,
    bidDepth1pct: 200,
    askDepth5pct: 300,
    bidDepth5pct: 400,
    askMaxWall: 50,
    bidMaxWall: 60,
    askOrderCount: 3,
    bidOrderCount: 4,
    ...over,
  };
}

describe("buildSnapshotsUpsert", () => {
  it("chunks at floor(100/16) = 6 rows per statement", () => {
    const { db, statements } = makeFakeD1();
    const rows = Array.from({ length: 13 }, (_, i) => makeRow({ tag: `TAG_${i}` }));
    buildSnapshotsUpsert(db, rows);
    expect(statements.length).toBe(3); // 6 + 6 + 1
    expect(statements[0]!.args.length).toBe(6 * 16);
    expect(statements[2]!.args.length).toBe(1 * 16);
  });

  it("upserts on the (tag, ts) composite key", () => {
    const { db, statements } = makeFakeD1();
    buildSnapshotsUpsert(db, [makeRow()]);
    expect(statements[0]!.sql).toContain("ON CONFLICT(tag, ts) DO UPDATE SET");
  });

  it("binds every column in the declared order", () => {
    const { db, statements } = makeFakeD1();
    const row = makeRow();
    buildSnapshotsUpsert(db, [row]);
    expect(statements[0]!.args).toEqual([
      row.tag,
      row.ts,
      row.ask,
      row.bid,
      row.askDepth,
      row.bidDepth,
      row.ibWeek,
      row.isWeek,
      row.askDepth1pct,
      row.bidDepth1pct,
      row.askDepth5pct,
      row.bidDepth5pct,
      row.askMaxWall,
      row.bidMaxWall,
      row.askOrderCount,
      row.bidOrderCount,
    ]);
  });
});
