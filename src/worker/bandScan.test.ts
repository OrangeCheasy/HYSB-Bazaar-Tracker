import { describe, expect, it } from "vitest";
import { runBandScan, DEFAULT_BAND_SCAN_PARAMS } from "./bandScan.js";

const HOUR = 3600;
const NOW = 1_800_000_000;

interface SeedTag {
  readonly tag: string;
  readonly hours: number;
  /** How long ago the tag stopped reporting, so a genuinely stale series can be built. */
  readonly endsHoursAgo?: number;
  readonly bidAvg?: number;
  readonly askAvg?: number;
  readonly bidMin?: number;
  readonly askMax?: number;
  readonly volume?: number;
}

/**
 * Fake D1 that honours the keyset cursor and LIMIT the same way real SQL would, so the
 * pagination logic is genuinely exercised rather than handed everything in one page.
 * Counts pages so a test can assert the scan is not degenerating into a query per tag.
 */
function makeDb(seed: readonly SeedTag[], pageSize = 5000) {
  const all: {
    tag: string;
    hour_ts: number;
    ask_avg: number;
    ask_min: number;
    ask_max: number;
    bid_avg: number;
    bid_min: number;
    bid_max: number;
    ask_depth: number;
    bid_depth: number;
    ib_week: number;
    is_week: number;
    samples: number;
    source: string;
  }[] = [];

  for (const s of seed) {
    for (let i = 0; i < s.hours; i++) {
      const bidAvg = s.bidAvg ?? 100;
      const askAvg = s.askAvg ?? 200;
      all.push({
        tag: s.tag,
        hour_ts: NOW - (s.endsHoursAgo ?? 1) * HOUR - (s.hours - 1 - i) * HOUR,
        ask_avg: askAvg,
        ask_min: askAvg - 5,
        ask_max: s.askMax ?? askAvg + 5,
        bid_avg: bidAvg,
        bid_min: s.bidMin ?? bidAvg - 5,
        bid_max: bidAvg + 5,
        ask_depth: 1000,
        bid_depth: 1000,
        ib_week: s.volume ?? 70_000,
        is_week: s.volume ?? 70_000,
        samples: 12,
        source: "hypixel",
      });
    }
  }
  all.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : a.hour_ts - b.hour_ts));

  let pages = 0;
  const db: Pick<D1Database, "prepare"> = {
    prepare(_sql: string) {
      const stmt = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt.args = args;
          return stmt;
        },
        async all() {
          pages++;
          const [sinceTs, cursorTag, cursorTs, limit] = stmt.args as [
            number,
            string,
            number,
            number,
          ];
          const rows = all
            .filter(
              (r) =>
                r.hour_ts >= sinceTs &&
                (r.tag > cursorTag || (r.tag === cursorTag && r.hour_ts > cursorTs)),
            )
            .slice(0, Math.min(limit, pageSize));
          return { results: rows } as unknown as D1Result;
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  };
  return { db, pageCount: () => pages };
}

describe("runBandScan", () => {
  it("produces one row per tag, ranked by profit/day", async () => {
    const { db } = makeDb([
      { tag: "AAA", hours: 168, volume: 500 },
      { tag: "BBB", hours: 168, volume: 500_000 },
      { tag: "CCC", hours: 168, volume: 50_000 },
    ]);

    const { rows } = await runBandScan(db, DEFAULT_BAND_SCAN_PARAMS, NOW);

    expect(rows.map((r) => r.tag)).toEqual(["BBB", "CCC", "AAA"]);
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      expect(prev?.economics.profitPerDay).toBeGreaterThanOrEqual(
        cur?.economics.profitPerDay ?? 0,
      );
    }
  });

  /**
   * The whole design rests on this: streaming ordered rows in bulk pages, not one query
   * per tag. Twenty tags must cost a handful of pages, not twenty queries — that ratio is
   * what keeps the scan inside D1's 1,000-query cap at Tier A scale.
   */
  it("pages in bulk rather than querying per tag", async () => {
    const seed = Array.from({ length: 20 }, (_, i) => ({
      tag: `TAG_${String(i).padStart(2, "0")}`,
      hours: 168,
    }));
    const { db, pageCount } = makeDb(seed, 5000);

    const { rows } = await runBandScan(db, DEFAULT_BAND_SCAN_PARAMS, NOW);

    expect(rows).toHaveLength(20);
    expect(pageCount()).toBeLessThan(5); // 3,360 rows at 5k/page
  });

  /**
   * A tag whose rows straddle a page boundary must still be finalized from ALL of them.
   * Getting this wrong truncates the series silently and shifts the band — the kind of
   * bug that looks like noise rather than breakage.
   */
  it("finalizes a tag whose rows span multiple pages", async () => {
    const small = makeDb([{ tag: "SPLIT", hours: 168 }]);
    const paged = makeDb([{ tag: "SPLIT", hours: 168 }]);

    const whole = await runBandScan(small.db, DEFAULT_BAND_SCAN_PARAMS, NOW);
    const split = await runBandScan(
      paged.db,
      { ...DEFAULT_BAND_SCAN_PARAMS, pageSize: 37 }, // forces ~5 pages
      NOW,
    );

    expect(paged.pageCount()).toBeGreaterThan(3);
    expect(split.rows).toHaveLength(1);
    expect(split.rows[0]?.band.buyHits.hoursTotal).toBe(168);
    expect(split.rows[0]?.band.buyBand).toBe(whole.rows[0]?.band.buyBand);
    expect(split.rows[0]?.economics.profitPerDay).toBeCloseTo(
      whole.rows[0]?.economics.profitPerDay ?? 0,
      6,
    );
  });

  /** Tags that cannot band are counted by reason, not dropped in silence — "47 tags lack
   *  24 hours of history" is operationally useful. */
  it("reports why a tag was skipped", async () => {
    const { db } = makeDb([
      { tag: "GOOD", hours: 168 },
      { tag: "THIN", hours: 3 },
    ]);

    const { rows, skipped } = await runBandScan(db, DEFAULT_BAND_SCAN_PARAMS, NOW);
    expect(rows.map((r) => r.tag)).toEqual(["GOOD"]);
    expect(skipped["insufficient-data"]).toBe(1);
  });

  /**
   * `normalizeHourlyRow` asserts rather than fixes (ADR-006). Raw Hypixel fields get sides
   * DERIVED structurally by price, but `ask_*`/`bid_*` in `hourly` are columns WE wrote —
   * a crossed one means our own data is corrupt, so it is rejected, not relabelled.
   *
   * The tag is then left with no usable bars. It must be REPORTED rather than quietly
   * absent: an early return here would delete it from the scan with no trace of why, which
   * is exactly the silent-gap failure CLAUDE.md section 3b is about.
   */
  it("reports a tag whose rows all fail normalization instead of dropping it", async () => {
    const { db } = makeDb([
      { tag: "INVERTED", hours: 168, bidAvg: 500, askAvg: 100, askMax: 105 },
      { tag: "FINE", hours: 168 },
    ]);
    const { rows, skipped } = await runBandScan(db, DEFAULT_BAND_SCAN_PARAMS, NOW);

    expect(rows.map((r) => r.tag)).toEqual(["FINE"]);
    expect(skipped["unnormalizable"]).toBe(1);
  });

  it("returns an empty result and an honest dataTo when there is nothing to band", async () => {
    const { db } = makeDb([]);
    const result = await runBandScan(db, DEFAULT_BAND_SCAN_PARAMS, NOW);
    expect(result.rows).toEqual([]);
    expect(result.dataTo).toBe(NOW);
  });

  /** dataTo is the OLDEST "freshest bar" across included tags — the payload is only as
   *  fresh as its stalest ingredient, so one lagging tag must drag the whole figure down
   *  rather than the payload claiming the freshest tag's timestamp. */
  it("reports dataTo from the stalest included tag", async () => {
    const { db } = makeDb([
      { tag: "FRESH", hours: 168, endsHoursAgo: 1 },
      { tag: "STALE", hours: 168, endsHoursAgo: 12 },
    ]);
    const { rows, dataTo } = await runBandScan(db, DEFAULT_BAND_SCAN_PARAMS, NOW);
    expect(rows).toHaveLength(2);
    expect(dataTo).toBe(NOW - 12 * HOUR);
  });
});
