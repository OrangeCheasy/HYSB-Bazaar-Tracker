import { describe, expect, it } from "vitest";
import {
  buildHourlyIncrementalUpsert,
  buildHourlyReplaceUpsert,
  type HourlyIncrementalRow,
  type HourlyReplaceRow,
} from "./hourly.js";
import { makeFakeD1 } from "./testHelpers.js";

describe("buildHourlyIncrementalUpsert (Tier B)", () => {
  function makeRow(over: Partial<HourlyIncrementalRow> = {}): HourlyIncrementalRow {
    return {
      tag: "SOME_TAG",
      hourTs: 3600,
      ask: 10,
      bid: 9,
      askDepth: 100,
      bidDepth: 200,
      ibWeek: 5000,
      isWeek: 6000,
      tickTs: 1000,
      ...over,
    };
  }

  it("chunks at floor(100/13) = 7 rows per statement", () => {
    const { db, statements } = makeFakeD1();
    const rows = Array.from({ length: 15 }, (_, i) => makeRow({ tag: `TAG_${i}` }));
    buildHourlyIncrementalUpsert(db, rows);
    expect(statements.length).toBe(3); // 7 + 7 + 1
    expect(statements[0]!.args.length).toBe(7 * 13);
  });

  it("includes the idempotency guard WHERE clause on last_tick_ts", () => {
    const { db, statements } = makeFakeD1();
    buildHourlyIncrementalUpsert(db, [makeRow()]);
    expect(statements[0]!.sql).toContain("WHERE hourly.last_tick_ts < excluded.last_tick_ts");
    expect(statements[0]!.sql).toContain("last_tick_ts = excluded.last_tick_ts");
  });

  it("computes samples-weighted running averages, not a flat overwrite", () => {
    const { db, statements } = makeFakeD1();
    buildHourlyIncrementalUpsert(db, [makeRow()]);
    expect(statements[0]!.sql).toContain(
      "(hourly.ask_avg   * hourly.samples + excluded.ask_avg)   / (hourly.samples + 1)",
    );
    expect(statements[0]!.sql).toContain("samples      = hourly.samples + 1");
  });

  it("seeds min/max/avg from the single ask/bid observation and binds tickTs last", () => {
    const { db, statements } = makeFakeD1();
    const row = makeRow({ tag: "COAL", ask: 5.43, bid: 4.98, tickTs: 1_700_000_000 });
    buildHourlyIncrementalUpsert(db, [row]);
    expect(statements[0]!.args).toEqual([
      "COAL",
      3600,
      5.43,
      5.43,
      5.43, // ask_avg, ask_min, ask_max all seeded from the one observation
      4.98,
      4.98,
      4.98, // bid_avg, bid_min, bid_max
      100,
      200,
      5000,
      6000,
      1_700_000_000, // last_tick_ts
    ]);
  });
});

describe("buildHourlyReplaceUpsert (Tier A)", () => {
  function makeRow(over: Partial<HourlyReplaceRow> = {}): HourlyReplaceRow {
    return {
      tag: "SOME_TAG",
      hourTs: 3600,
      askAvg: 10,
      askMin: 9,
      askMax: 11,
      bidAvg: 8,
      bidMin: 7,
      bidMax: 9,
      askDepth: 100,
      bidDepth: 200,
      ibWeek: 5000,
      isWeek: 6000,
      samples: 12,
      source: "hypixel",
      ...over,
    };
  }

  it("chunks at floor(100/14) = 7 rows per statement", () => {
    const { db, statements } = makeFakeD1();
    const rows = Array.from({ length: 8 }, (_, i) => makeRow({ tag: `TAG_${i}` }));
    buildHourlyReplaceUpsert(db, rows);
    expect(statements.length).toBe(2); // 7 + 1
    expect(statements[0]!.args.length).toBe(7 * 14);
  });

  it("is a wholesale replace, not an average of an average", () => {
    const { db, statements } = makeFakeD1();
    buildHourlyReplaceUpsert(db, [makeRow()]);
    expect(statements[0]!.sql).toContain("ask_avg   = excluded.ask_avg");
    expect(statements[0]!.sql).toContain("samples   = excluded.samples");
    expect(statements[0]!.sql).not.toContain("hourly.samples +");
  });

  it("binds every column including the real samples count and source", () => {
    const { db, statements } = makeFakeD1();
    const row = makeRow({ samples: 5, source: "coflnet" });
    buildHourlyReplaceUpsert(db, [row]);
    expect(statements[0]!.args).toEqual([
      row.tag,
      row.hourTs,
      row.askAvg,
      row.askMin,
      row.askMax,
      row.bidAvg,
      row.bidMin,
      row.bidMax,
      row.askDepth,
      row.bidDepth,
      row.ibWeek,
      row.isWeek,
      row.samples,
      row.source,
    ]);
  });
});
