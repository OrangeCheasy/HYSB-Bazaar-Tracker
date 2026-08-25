import { chunkByParamCount } from "./chunk.js";

/** One 5-minute ingest tick's worth of data for one Tier B tag. */
export interface HourlyIncrementalRow {
  readonly tag: string;
  readonly hourTs: number;
  readonly ask: number;
  readonly bid: number;
  readonly askDepth: number;
  readonly bidDepth: number;
  readonly ibWeek: number;
  readonly isWeek: number;
  /** This tick's own timestamp — the idempotency guard, see migration 0002. */
  readonly tickTs: number;
}

const INCREMENTAL_PARAMS_PER_ROW = 13;

/**
 * Tier B's direct-write path, called every 5 minutes from ingest.ts. No `snapshots` row
 * backs these tags, so each tick folds its one observation into the current hour's
 * running average in place.
 *
 * The trailing WHERE is the idempotency guard: SQLite UPSERT supports an optional WHERE
 * after DO UPDATE SET, and a false condition leaves the row untouched entirely — a
 * retried tick at the same tickTs is a no-op instead of double-counting into `samples`
 * (CLAUDE.md section 3b: `hourly.samples` must be honest).
 */
export function buildHourlyIncrementalUpsert(
  db: Pick<D1Database, "prepare">,
  rows: readonly HourlyIncrementalRow[],
): D1PreparedStatement[] {
  return chunkByParamCount(rows, INCREMENTAL_PARAMS_PER_ROW).map((chunk) => {
    // 12 bound values (tag..is_week) + literal samples=1, source='hypixel' + 1 bound
    // value (last_tick_ts) = 13 placeholders, matching INCREMENTAL_PARAMS_PER_ROW.
    const placeholders = chunk
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'hypixel', ?)")
      .join(", ");
    const sql = `
      INSERT INTO hourly (
        tag, hour_ts, ask_avg, ask_min, ask_max, bid_avg, bid_min, bid_max,
        ask_depth, bid_depth, ib_week, is_week, samples, source, last_tick_ts
      )
      VALUES ${placeholders}
      ON CONFLICT(tag, hour_ts) DO UPDATE SET
        ask_avg      = (hourly.ask_avg   * hourly.samples + excluded.ask_avg)   / (hourly.samples + 1),
        ask_min      = min(hourly.ask_min, excluded.ask_min),
        ask_max      = max(hourly.ask_max, excluded.ask_max),
        bid_avg      = (hourly.bid_avg   * hourly.samples + excluded.bid_avg)   / (hourly.samples + 1),
        bid_min      = min(hourly.bid_min, excluded.bid_min),
        bid_max      = max(hourly.bid_max, excluded.bid_max),
        ask_depth    = (hourly.ask_depth * hourly.samples + excluded.ask_depth) / (hourly.samples + 1),
        bid_depth    = (hourly.bid_depth * hourly.samples + excluded.bid_depth) / (hourly.samples + 1),
        ib_week      = excluded.ib_week,
        is_week      = excluded.is_week,
        samples      = hourly.samples + 1,
        last_tick_ts = excluded.last_tick_ts
      WHERE hourly.last_tick_ts < excluded.last_tick_ts
    `;
    const args = chunk.flatMap((r) => [
      r.tag,
      r.hourTs,
      r.ask,
      r.ask,
      r.ask,
      r.bid,
      r.bid,
      r.bid,
      r.askDepth,
      r.bidDepth,
      r.ibWeek,
      r.isWeek,
      r.tickTs,
    ]);
    return db.prepare(sql).bind(...args);
  });
}

/** Tier A's rollup-built row — a `Bar` already carrying real min/max/samples. */
export interface HourlyReplaceRow {
  readonly tag: string;
  readonly hourTs: number;
  readonly askAvg: number;
  readonly askMin: number;
  readonly askMax: number;
  readonly bidAvg: number;
  readonly bidMin: number;
  readonly bidMax: number;
  readonly askDepth: number;
  readonly bidDepth: number;
  readonly ibWeek: number;
  readonly isWeek: number;
  readonly samples: number;
  readonly source: "hypixel" | "coflnet";
}

const REPLACE_PARAMS_PER_ROW = 14;

/**
 * Tier A's rollup path, called hourly from rollup.ts. Rollup recomputes the full hour
 * from `snapshots` every time, so this is a wholesale replace, never an average of an
 * average — no running-average math needed here.
 */
export function buildHourlyReplaceUpsert(
  db: Pick<D1Database, "prepare">,
  rows: readonly HourlyReplaceRow[],
): D1PreparedStatement[] {
  return chunkByParamCount(rows, REPLACE_PARAMS_PER_ROW).map((chunk) => {
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const sql = `
      INSERT INTO hourly (
        tag, hour_ts, ask_avg, ask_min, ask_max, bid_avg, bid_min, bid_max,
        ask_depth, bid_depth, ib_week, is_week, samples, source
      )
      VALUES ${placeholders}
      ON CONFLICT(tag, hour_ts) DO UPDATE SET
        ask_avg   = excluded.ask_avg,
        ask_min   = excluded.ask_min,
        ask_max   = excluded.ask_max,
        bid_avg   = excluded.bid_avg,
        bid_min   = excluded.bid_min,
        bid_max   = excluded.bid_max,
        ask_depth = excluded.ask_depth,
        bid_depth = excluded.bid_depth,
        ib_week   = excluded.ib_week,
        is_week   = excluded.is_week,
        samples   = excluded.samples,
        source    = excluded.source
    `;
    const args = chunk.flatMap((r) => [
      r.tag,
      r.hourTs,
      r.askAvg,
      r.askMin,
      r.askMax,
      r.bidAvg,
      r.bidMin,
      r.bidMax,
      r.askDepth,
      r.bidDepth,
      r.ibWeek,
      r.isWeek,
      r.samples,
      r.source,
    ]);
    return db.prepare(sql).bind(...args);
  });
}
